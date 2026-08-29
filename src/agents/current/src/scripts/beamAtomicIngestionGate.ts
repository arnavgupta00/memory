import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import OpenAI from "openai";
import { z } from "zod";

import type {
  RecertifiedEvidenceAtom,
  RecertifiedOracleEntry,
} from "../compression/beamCompression.js";
import {
  CostBudget,
  DispatchGate,
  callStructured,
  loadDotEnv,
  mapPool,
  type ReasoningEffort,
  type StructuredCallResult,
  type TokenUsage,
} from "../compression/structuredCall.js";
import {
  AtomicCardAuditorOutputSchema,
  AtomicCardExtractorOutputSchema,
  DraftAtomicCardSchema,
  MaterializedAtomicCardSchema,
  QuarantinedAtomicCardSchema,
  materializeAtomicCards,
  type AtomicCardDerivation,
  type AtomicCardSourceTurn,
  type DraftAtomicCard,
  type MaterializedAtomicCard,
  type QuarantinedAtomicCard,
  type TurnDisposition,
} from "../ingestion/atomicCards.js";
import {
  computeExactCardTokenMetrics,
  countO200kTokens,
  evaluateTurnOnlyAtomCoverage,
  mapAcceptedCardSpansToOracleAtoms,
  mapAcceptedCardTurnsToOracleAtoms,
  stableJson,
  summarizeAtomicIngestionCounts,
  validateFrozenCanaryManifest,
  type AtomCardCandidates,
  type FrozenAtomicIngestionCanaryManifest,
} from "../ingestion/atomicIngestionEvaluation.js";
import { PromptLoader } from "../services/promptLoader.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const DEFAULT_DATASET = resolve(
  PROJECT_ROOT,
  "runs/beam-1m-canary-a-architecture-0008-20260731-r2/input/dataset.json",
);
const DEFAULT_SOURCE_MANIFEST = resolve(
  PROJECT_ROOT,
  "src/agents/current/eval-slices/beam-1m/beam-1m-atomic-ingestion-source-v1.json",
);
const DEFAULT_PROBE_MANIFEST = resolve(
  PROJECT_ROOT,
  "src/agents/current/eval-slices/beam-1m/beam-1m-atomic-ingestion-dev-v1.json",
);
const DEFAULT_ORACLE = resolve(
  PROJECT_ROOT,
  "runs/beam-1m-compression-oracle-recertification-20260808/oracle-recertified-v1.json",
);
const DEFAULT_OUT = resolve(PROJECT_ROOT, "runs/beam-1m-atomic-ingestion-v0-20260809");
const DEFAULT_EXTRACTOR_MODEL = "gpt-5.4-nano-2026-03-17";
const DEFAULT_AUDITOR_MODEL = "gpt-5.6-luna";
const DEFAULT_JUDGE_MODEL = "gpt-5.6-luna";

const SourceManifestSchema = z.strictObject({
  schema_version: z.literal(1),
  benchmark: z.literal("BEAM"),
  tier: z.literal("1M"),
  name: z.string().min(1),
  role: z.literal("question_blind_ingestion_source_selection"),
  selection_seed: z.string().min(1),
  eligible_conversation_ids: z.array(z.union([z.string(), z.number()])),
  primary_conversation_id: z.union([z.string(), z.number()]),
  primary_sha256_rank: z.string().regex(/^[a-f0-9]{64}$/),
  shadow_conversation_id: z.union([z.string(), z.number()]),
  shadow_sha256_rank: z.string().regex(/^[a-f0-9]{64}$/),
  forbidden_inputs: z.array(z.string().min(1)).min(1),
});

const TurnSchema = z.strictObject({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});
const ConversationSchema = z.strictObject({
  conversation_id: z.union([z.string(), z.number()]),
  session_ids: z.array(z.string().min(1)),
  session_dates: z.array(z.string()),
  sessions: z.array(z.array(TurnSchema)),
});
const DatasetSchema = z.object({
  conversations: z.array(ConversationSchema),
});

const OracleFileSchema = z.object({
  schema_version: z.number(),
  entries: z.array(z.custom<RecertifiedOracleEntry>()),
});

type AtomJudgeOutput = {
  judgments: Array<{
    atomId: string;
    covered: boolean;
    coveringCardIds: string[];
    missingDetails: string[];
    unsupportedCardIds: string[];
  }>;
};

function atomJudgeOutputSchemaFor(cardIds: readonly string[]): z.ZodType<AtomJudgeOutput> {
  const values = [...new Set(cardIds)];
  const cardIdSchema: z.ZodType<string> = values.length === 0
    ? z.never()
    : z.enum(values as [string, ...string[]]);
  return z.strictObject({
    judgments: z.array(z.strictObject({
      atomId: z.string().min(1),
      covered: z.boolean(),
      coveringCardIds: z.array(cardIdSchema).max(128),
      missingDetails: z.array(z.string()).max(32),
      unsupportedCardIds: z.array(cardIdSchema).max(128),
    })).max(64),
  });
}

type Conversation = z.infer<typeof ConversationSchema>;
type SessionWindow = {
  index: number;
  realSessionId: string;
  opaqueSessionId: string;
  sessionDate: string;
  turns: Array<{ turnIndex: number; role: "user" | "assistant"; content: string }>;
};
type ValidationRow = {
  draftIndex: number;
  validation: "accepted" | "quarantined";
  issues: Array<{ sourceIndex: number; reason: string; detail: string }>;
};
type DispositionValidation = {
  valid: boolean;
  errors: string[];
  turns: Array<{
    turnIndex: number;
    disposition: TurnDisposition["disposition"] | null;
    cardIds: string[];
    reason: string | null;
  }>;
};
type SessionResult = {
  schema_version: 1;
  session_index: number;
  real_session_id: string;
  opaque_session_id: string;
  session_date: string;
  raw_turn_count: number;
  nano_cards: MaterializedAtomicCard[];
  nano_quarantined: QuarantinedAtomicCard[];
  nano_dispositions: DispositionValidation;
  audited_cards: MaterializedAtomicCard[];
  audited_quarantined: QuarantinedAtomicCard[];
  audited_dispositions: DispositionValidation;
  audit_rejected_draft_indexes: number[];
  audit_index_errors: string[];
};

function parseArgs(argv: string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith("--")) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) output[argument.slice(2)] = "true";
    else {
      output[argument.slice(2)] = value;
      index += 1;
    }
  }
  return output;
}

function projectPath(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  return isAbsolute(value) ? value : resolve(PROJECT_ROOT, value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fileSha256(path: string): string {
  return sha256(readFileSync(path));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(path: string, values: readonly unknown[]): void {
  const body = values.length === 0 ? "" : `${values.map(stableJson).join("\n")}\n`;
  writeFileSync(path, body);
}

function safeName(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
}

function opaqueSessionId(index: number): string {
  return `memory_${String(index + 1).padStart(6, "0")}`;
}

function callJson<T>(call: StructuredCallResult<T>): Record<string, unknown> {
  return {
    value: call.value,
    outputText: call.outputText,
    usage: call.usage,
    latencyMs: call.latencyMs,
    requestId: call.requestId,
    retryCount: call.retryCount,
    inputSha256: call.inputSha256,
    promptCacheKey: call.promptCacheKey,
    estimatedCostUsd: call.estimatedCostUsd,
    promptMessages: call.promptMessages,
  };
}

function loadCallValue<T>(path: string, schema: z.ZodType<T>): T | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { value?: unknown };
  return schema.parse(parsed.value);
}

function windowForConversation(conversation: Conversation): SessionWindow[] {
  if (
    conversation.session_ids.length !== conversation.sessions.length
    || conversation.session_dates.length !== conversation.sessions.length
  ) {
    throw new Error(`conversation ${String(conversation.conversation_id)} has misaligned session arrays`);
  }
  return conversation.sessions.map((turns, index) => {
    const realSessionId = conversation.session_ids[index];
    const sessionDate = conversation.session_dates[index];
    if (realSessionId === undefined || sessionDate === undefined) {
      throw new Error(`conversation session ${String(index)} is incomplete`);
    }
    return {
      index,
      realSessionId,
      opaqueSessionId: opaqueSessionId(index),
      sessionDate,
      turns: turns.map((turn, turnIndex) => ({ turnIndex, ...turn })),
    };
  });
}

function modelSession(session: SessionWindow): Record<string, unknown> {
  return {
    sessionId: session.opaqueSessionId,
    sessionDate: session.sessionDate,
    turns: session.turns,
  };
}

function realSourceTurns(session: SessionWindow): AtomicCardSourceTurn[] {
  return session.turns.map((turn) => ({
    sessionId: session.realSessionId,
    turnIndex: turn.turnIndex,
    role: turn.role,
    content: turn.content,
    timestamp: session.sessionDate || null,
  }));
}

function bindDraftToRealSession(draft: DraftAtomicCard, session: SessionWindow): DraftAtomicCard {
  return DraftAtomicCardSchema.parse({
    ...draft,
    sources: draft.sources.map((source) => ({
      ...source,
      sessionId: source.sessionId === session.opaqueSessionId
        ? session.realSessionId
        : source.sessionId,
    })),
  });
}

function materializeIndexedDrafts(args: {
  drafts: readonly DraftAtomicCard[];
  session: SessionWindow;
  derivation: AtomicCardDerivation;
}): {
  acceptedByIndex: Map<number, MaterializedAtomicCard>;
  quarantined: QuarantinedAtomicCard[];
  validation: ValidationRow[];
} {
  const acceptedByIndex = new Map<number, MaterializedAtomicCard>();
  const quarantined: QuarantinedAtomicCard[] = [];
  const validation: ValidationRow[] = [];
  for (let draftIndex = 0; draftIndex < args.drafts.length; draftIndex += 1) {
    const original = args.drafts[draftIndex];
    if (!original) continue;
    const draft = bindDraftToRealSession(original, args.session);
    const result = materializeAtomicCards({
      turns: realSourceTurns(args.session),
      drafts: [draft],
      derivation: args.derivation,
    });
    const card = result.cards[0];
    if (card) acceptedByIndex.set(draftIndex, card);
    const rewritten = result.quarantined.map((item) => QuarantinedAtomicCardSchema.parse({
      ...item,
      draftIndex,
    }));
    quarantined.push(...rewritten);
    validation.push({
      draftIndex,
      validation: card ? "accepted" : "quarantined",
      issues: rewritten.flatMap((item) => item.issues),
    });
  }
  return { acceptedByIndex, quarantined, validation };
}

function dedupeCards(cards: readonly MaterializedAtomicCard[]): MaterializedAtomicCard[] {
  return [...new Map(cards.map((card) => [card.cardId, card])).values()]
    .sort((left, right) => left.cardId.localeCompare(right.cardId));
}

function validateDispositions(args: {
  dispositions: readonly TurnDisposition[];
  session: SessionWindow;
  cards: readonly MaterializedAtomicCard[];
}): DispositionValidation {
  const errors: string[] = [];
  const byTurn = new Map<number, TurnDisposition>();
  for (const disposition of args.dispositions) {
    if (byTurn.has(disposition.turnIndex)) {
      errors.push(`duplicate disposition for turn ${String(disposition.turnIndex)}`);
    } else {
      byTurn.set(disposition.turnIndex, disposition);
    }
  }
  const validTurns = new Set(args.session.turns.map((turn) => turn.turnIndex));
  for (const turnIndex of byTurn.keys()) {
    if (!validTurns.has(turnIndex)) errors.push(`disposition references unknown turn ${String(turnIndex)}`);
  }
  const turns = args.session.turns.map((turn) => {
    const disposition = byTurn.get(turn.turnIndex);
    const cardIds = args.cards.filter((card) => card.sources.some((source) =>
      source.sessionId === args.session.realSessionId && source.turnIndex === turn.turnIndex,
    )).map((card) => card.cardId);
    if (!disposition) errors.push(`missing disposition for turn ${String(turn.turnIndex)}`);
    if (disposition?.disposition === "cards_extracted" && cardIds.length === 0) {
      errors.push(`turn ${String(turn.turnIndex)} says cards_extracted but has no accepted card`);
    }
    if (disposition?.disposition === "no_extractable_content" && cardIds.length > 0) {
      errors.push(`turn ${String(turn.turnIndex)} says no_extractable_content but has accepted cards`);
    }
    return {
      turnIndex: turn.turnIndex,
      disposition: disposition?.disposition ?? null,
      cardIds,
      reason: disposition?.reason ?? null,
    };
  });
  return { valid: errors.length === 0, errors, turns };
}

function auditIndexErrors(
  draftCount: number,
  rejected: readonly number[],
  replacements: ReadonlyArray<{ draftIndex: number }>,
): string[] {
  const errors: string[] = [];
  const rejectedSet = new Set(rejected);
  if (rejectedSet.size !== rejected.length) errors.push("auditor returned duplicate rejected indexes");
  const replacementIndexes = replacements.map((item) => item.draftIndex);
  // One conflated draft may legitimately require several atomic replacements.
  for (const index of [...rejected, ...replacementIndexes]) {
    if (index < 0 || index >= draftCount) {
      errors.push(`auditor referenced out-of-range draft index ${String(index)}`);
    }
  }
  return [...new Set(errors)];
}

function usageFromCallFile(path: string): { usage: TokenUsage; cost: number; latencyMs: number } | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    usage?: TokenUsage;
    estimatedCostUsd?: number;
    latencyMs?: number;
  };
  if (!parsed.usage) return null;
  return {
    usage: parsed.usage,
    cost: parsed.estimatedCostUsd ?? 0,
    latencyMs: parsed.latencyMs ?? 0,
  };
}

function aggregateUsage(rows: Array<{ usage: TokenUsage; cost: number; latencyMs: number }>): Record<string, number> {
  return rows.reduce((total, row) => ({
    input_tokens: total.input_tokens + (row.usage.input_tokens ?? 0),
    cached_input_tokens: total.cached_input_tokens + (row.usage.cached_input_tokens ?? 0),
    cache_write_tokens: total.cache_write_tokens + (row.usage.cache_write_tokens ?? 0),
    output_tokens: total.output_tokens + (row.usage.output_tokens ?? 0),
    reasoning_tokens: total.reasoning_tokens + (row.usage.reasoning_tokens ?? 0),
    total_tokens: total.total_tokens + (row.usage.total_tokens ?? 0),
    cost_usd: total.cost_usd + row.cost,
    latency_ms_sum: total.latency_ms_sum + row.latencyMs,
  }), {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
    latency_ms_sum: 0,
  });
}

function sourceText(sessions: readonly SessionWindow[]): string {
  return sessions.flatMap((session) => session.turns.map((turn) =>
    `<${turn.role}>\n${turn.content}`,
  )).join("\n\n");
}

async function ingest(args: Record<string, string>): Promise<void> {
  const datasetPath = projectPath(args.dataset, DEFAULT_DATASET);
  const sourceManifestPath = projectPath(args["source-manifest"], DEFAULT_SOURCE_MANIFEST);
  const outDir = projectPath(args.out, DEFAULT_OUT);
  const variant = args.variant ?? "primary";
  const sourceManifest = SourceManifestSchema.parse(JSON.parse(readFileSync(sourceManifestPath, "utf8")));
  const conversationId = variant === "primary"
    ? sourceManifest.primary_conversation_id
    : variant === "shadow"
      ? sourceManifest.shadow_conversation_id
      : args["conversation-id"] ?? variant;
  const dataset = DatasetSchema.parse(JSON.parse(readFileSync(datasetPath, "utf8")));
  const conversation = dataset.conversations.find((item) =>
    String(item.conversation_id) === String(conversationId),
  );
  if (!conversation) throw new Error(`conversation ${String(conversationId)} not found`);
  const allSessions = windowForConversation(conversation);
  const sessionLimit = args["session-limit"] === undefined
    ? allSessions.length
    : Number(args["session-limit"]);
  if (!Number.isInteger(sessionLimit) || sessionLimit <= 0 || sessionLimit > allSessions.length) {
    throw new Error("--session-limit must be a positive integer within the conversation");
  }
  const sessions = allSessions.slice(0, sessionLimit);
  const runDir = resolve(outDir, variant);
  const callsDir = resolve(runDir, "calls");
  mkdirSync(callsDir, { recursive: true });

  const extractorModel = args["extractor-model"] ?? DEFAULT_EXTRACTOR_MODEL;
  const auditorModel = args["auditor-model"] ?? DEFAULT_AUDITOR_MODEL;
  const extractorReasoning = (args["extractor-reasoning"] ?? "low") as ReasoningEffort;
  const auditorReasoning = (args["auditor-reasoning"] ?? "medium") as ReasoningEffort;
  const concurrency = Number(args.concurrency ?? 128);
  const tokenBudget = Number(args["token-budget"] ?? 1_900_000);
  const maxCost = Number(args["max-cost"] ?? 100);
  const extractorMaxOutput = Number(args["extractor-max-output"] ?? 32_000);
  const auditorMaxOutput = Number(args["auditor-max-output"] ?? 64_000);
  const runId = `beam-atomic-ingestion-v0:${variant}:${sha256(stableJson({
    sourceManifestSha256: fileSha256(sourceManifestPath),
    conversationId: conversation.conversation_id,
    extractorModel,
    extractorReasoning,
    auditorModel,
    auditorReasoning,
  })).slice(0, 24)}`;
  const extractorPromptPath = resolve(PROJECT_ROOT, "src/agents/current/prompts/beam-atomic-card-extract-v1.yaml");
  const auditorPromptPath = resolve(PROJECT_ROOT, "src/agents/current/prompts/beam-atomic-card-audit-v1.yaml");
  const extractorDerivation: AtomicCardDerivation = {
    model: extractorModel,
    promptSha256: fileSha256(extractorPromptPath),
    runId,
  };
  const auditorDerivation: AtomicCardDerivation = {
    model: auditorModel,
    promptSha256: fileSha256(auditorPromptPath),
    runId,
  };

  const preflight = {
    schema_version: 1,
    phase: "ingest",
    question_blind: true,
    source_manifest: sourceManifestPath,
    source_manifest_sha256: fileSha256(sourceManifestPath),
    dataset: datasetPath,
    dataset_sha256: fileSha256(datasetPath),
    conversation_id: conversation.conversation_id,
    variant,
    full_session_count: allSessions.length,
    selected_session_count: sessions.length,
    full_turn_count: allSessions.reduce((sum, session) => sum + session.turns.length, 0),
    selected_turn_count: sessions.reduce((sum, session) => sum + session.turns.length, 0),
    complete_chronological_source: sessions.length === allSessions.length,
    forbidden_inputs_opened: [],
    extractor_model: extractorModel,
    extractor_reasoning: extractorReasoning,
    auditor_model: auditorModel,
    auditor_reasoning: auditorReasoning,
    concurrency,
    token_budget_per_minute: tokenBudget,
    max_cost_usd: maxCost,
  };
  writeJson(resolve(runDir, "preflight.json"), preflight);
  writeJson(resolve(runDir, "raw-archive.json"), {
    schema_version: 1,
    conversation_id: conversation.conversation_id,
    sessions: sessions.map((session) => ({
      session_id: session.realSessionId,
      session_date: session.sessionDate,
      turns: session.turns,
    })),
  });
  writeJson(resolve(runDir, "opaque-session-map.json"), sessions.map((session) => ({
    opaque_session_id: session.opaqueSessionId,
    real_session_id: session.realSessionId,
    session_index: session.index,
  })));

  const prompts = new PromptLoader();
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const dispatch = new DispatchGate(tokenBudget, 60, concurrency);
  const costBudget = new CostBudget(maxCost);
  let completedCount = 0;
  const rawIds = allSessions.map((session) => session.realSessionId);

  const sessionResults = await mapPool(sessions, concurrency, async (session): Promise<SessionResult> => {
    const callDir = resolve(callsDir, session.opaqueSessionId);
    mkdirSync(callDir, { recursive: true });
    const targetSourceTokens = countO200kTokens(sourceText([session]));
    const extractionPath = resolve(callDir, "extractor.json");
    let extraction = loadCallValue(extractionPath, AtomicCardExtractorOutputSchema);
    if (!extraction) {
      const preceding = allSessions.slice(Math.max(0, session.index - 2), session.index);
      const prompt = await prompts.render("beam-atomic-card-extract-v1", {
        preceding_context_sessions: JSON.stringify(preceding.map(modelSession)),
        target_session: JSON.stringify(modelSession(session)),
      });
      const call = await callStructured({
        openai,
        dispatch,
        costBudget,
        model: extractorModel,
        reasoning: extractorReasoning,
        prompt,
        schema: AtomicCardExtractorOutputSchema,
        schemaName: "beam_atomic_card_extract_v1",
        maxOutputTokens: extractorMaxOutput,
        dispatchOutputTokens: Math.min(
          extractorMaxOutput,
          Math.max(6_000, targetSourceTokens * 5),
        ),
        rawSessionIdsForLeakCheck: rawIds,
      });
      extraction = call.value;
      writeJson(extractionPath, callJson(call));
    }
    const nano = materializeIndexedDrafts({
      drafts: extraction.cards,
      session,
      derivation: extractorDerivation,
    });
    const nanoCards = dedupeCards([...nano.acceptedByIndex.values()]);
    const nanoDispositions = validateDispositions({
      dispositions: extraction.turnDispositions,
      session,
      cards: nanoCards,
    });

    const auditPath = resolve(callDir, "auditor.json");
    let audit = loadCallValue(auditPath, AtomicCardAuditorOutputSchema);
    if (!audit) {
      const preceding = allSessions.slice(Math.max(0, session.index - 2), session.index);
      const acceptedDrafts = [...nano.acceptedByIndex.keys()].map((draftIndex) => ({
        draftIndex,
        draft: extraction.cards[draftIndex],
      }));
      const prompt = await prompts.render("beam-atomic-card-audit-v1", {
        preceding_context_sessions: JSON.stringify(preceding.map(modelSession)),
        target_session: JSON.stringify(modelSession(session)),
        validated_draft_cards: JSON.stringify(acceptedDrafts),
        draft_card_validation: JSON.stringify(nano.validation),
      });
      const call = await callStructured({
        openai,
        dispatch,
        costBudget,
        model: auditorModel,
        reasoning: auditorReasoning,
        prompt,
        schema: AtomicCardAuditorOutputSchema,
        schemaName: "beam_atomic_card_audit_v1",
        maxOutputTokens: auditorMaxOutput,
        dispatchOutputTokens: Math.min(
          auditorMaxOutput,
          Math.max(8_000, targetSourceTokens * 8),
        ),
        rawSessionIdsForLeakCheck: rawIds,
      });
      audit = call.value;
      writeJson(auditPath, callJson(call));
    }
    const indexErrors = auditIndexErrors(
      extraction.cards.length,
      audit.rejectedDraftIndexes,
      audit.replacementCards,
    );
    const removedIndexes = new Set([
      ...audit.rejectedDraftIndexes.filter((index) => index < extraction.cards.length),
      ...audit.replacementCards
        .map((item) => item.draftIndex)
        .filter((index) => index < extraction.cards.length),
    ]);
    const retained = [...nano.acceptedByIndex.entries()]
      .filter(([draftIndex]) => !removedIndexes.has(draftIndex))
      .map(([, card]) => card);
    const repairDrafts = [
      ...audit.replacementCards.map((item) => item.card),
      ...audit.missingCards,
    ];
    const repairs = materializeIndexedDrafts({
      drafts: repairDrafts,
      session,
      derivation: auditorDerivation,
    });
    const auditedCards = dedupeCards([...retained, ...repairs.acceptedByIndex.values()]);
    const auditedDispositions = validateDispositions({
      dispositions: audit.turnDispositions,
      session,
      cards: auditedCards,
    });
    const result: SessionResult = {
      schema_version: 1,
      session_index: session.index,
      real_session_id: session.realSessionId,
      opaque_session_id: session.opaqueSessionId,
      session_date: session.sessionDate,
      raw_turn_count: session.turns.length,
      nano_cards: nanoCards,
      nano_quarantined: nano.quarantined,
      nano_dispositions: nanoDispositions,
      audited_cards: auditedCards,
      audited_quarantined: repairs.quarantined,
      audited_dispositions: auditedDispositions,
      audit_rejected_draft_indexes: audit.rejectedDraftIndexes,
      audit_index_errors: indexErrors,
    };
    writeJson(resolve(callDir, "session-result.json"), result);
    completedCount += 1;
    if (completedCount % 25 === 0 || completedCount === sessions.length) {
      console.log(JSON.stringify({
        event: "atomic_ingestion_progress",
        variant,
        completed_sessions: completedCount,
        total_sessions: sessions.length,
        cost: costBudget.snapshot(),
      }));
    }
    return result;
  });

  sessionResults.sort((left, right) => left.session_index - right.session_index);
  const nanoCards = dedupeCards(sessionResults.flatMap((result) => result.nano_cards));
  const auditedCards = dedupeCards(sessionResults.flatMap((result) => result.audited_cards));
  const nanoQuarantined = sessionResults.flatMap((result) => result.nano_quarantined);
  const auditedQuarantined = sessionResults.flatMap((result) => result.audited_quarantined);
  writeJsonl(resolve(runDir, "cards-nano.jsonl"), nanoCards);
  writeJsonl(resolve(runDir, "cards-audited.jsonl"), auditedCards);
  writeJsonl(resolve(runDir, "quarantine-nano.jsonl"), nanoQuarantined);
  writeJsonl(resolve(runDir, "quarantine-audited.jsonl"), auditedQuarantined);
  writeJson(resolve(runDir, "dispositions.json"), sessionResults.map((result) => ({
    session_index: result.session_index,
    real_session_id: result.real_session_id,
    nano: result.nano_dispositions,
    audited: result.audited_dispositions,
  })));

  const usageRows = sessions.flatMap((session) => {
    const callDir = resolve(callsDir, session.opaqueSessionId);
    return [
      usageFromCallFile(resolve(callDir, "extractor.json")),
      usageFromCallFile(resolve(callDir, "auditor.json")),
    ].filter((row): row is NonNullable<typeof row> => row !== null);
  });
  const sourceTokenCount = countO200kTokens(sourceText(sessions));
  const artifactPaths = [
    "raw-archive.json",
    "opaque-session-map.json",
    "cards-nano.jsonl",
    "cards-audited.jsonl",
    "quarantine-nano.jsonl",
    "quarantine-audited.jsonl",
    "dispositions.json",
    "preflight.json",
  ];
  const complete = sessions.length === allSessions.length
    && sessionResults.length === allSessions.length;
  const freezeManifest = {
    schema_version: 1,
    status: complete ? "complete" : "incomplete",
    frozen_at: new Date().toISOString(),
    question_blind: true,
    variant,
    conversation_id: conversation.conversation_id,
    complete_chronological_source: sessions.length === allSessions.length,
    source_sessions: sessions.length,
    source_turns: sessions.reduce((sum, session) => sum + session.turns.length, 0),
    exact_source_tokens_o200k: sourceTokenCount,
    forbidden_inputs_opened: [],
    prompt_hashes: {
      extractor: extractorDerivation.promptSha256,
      auditor: auditorDerivation.promptSha256,
    },
    models: {
      extractor: { model: extractorModel, reasoning: extractorReasoning },
      auditor: { model: auditorModel, reasoning: auditorReasoning },
    },
    artifacts: Object.fromEntries(artifactPaths.map((name) => [name, fileSha256(resolve(runDir, name))])),
    nano: {
      counts: summarizeAtomicIngestionCounts({ cards: nanoCards, quarantined: nanoQuarantined }),
      exact_card_artifact_metrics: computeExactCardTokenMetrics(nanoCards, sourceTokenCount),
      disposition_error_sessions: sessionResults.filter((result) => !result.nano_dispositions.valid).length,
    },
    audited: {
      counts: summarizeAtomicIngestionCounts({ cards: auditedCards, quarantined: auditedQuarantined }),
      exact_card_artifact_metrics: computeExactCardTokenMetrics(auditedCards, sourceTokenCount),
      disposition_error_sessions: sessionResults.filter((result) => !result.audited_dispositions.valid).length,
      audit_index_error_sessions: sessionResults.filter((result) => result.audit_index_errors.length > 0).length,
    },
    usage: aggregateUsage(usageRows),
  };
  writeJson(resolve(runDir, "freeze-manifest.json"), freezeManifest);
  console.log(JSON.stringify({
    event: "atomic_ingestion_frozen",
    run_dir: runDir,
    status: freezeManifest.status,
    nano_cards: nanoCards.length,
    audited_cards: auditedCards.length,
    usage: freezeManifest.usage,
  }, null, 2));
}

function readJsonl<T>(path: string, schema: z.ZodType<T>): T[] {
  if (!existsSync(path)) throw new Error(`missing artifact ${path}`);
  return readFileSync(path, "utf8").split("\n").flatMap((line) =>
    line.trim() ? [schema.parse(JSON.parse(line))] : [],
  );
}

function candidatePayload(
  atom: RecertifiedEvidenceAtom,
  candidates: AtomCardCandidates,
  cardsById: ReadonlyMap<string, MaterializedAtomicCard>,
): Record<string, unknown> {
  return {
    atomId: atom.atom_id,
    description: atom.description,
    certifiedSources: atom.sources,
    candidateCards: candidates.candidateCardIds.map((cardId) => {
      const card = cardsById.get(cardId);
      if (!card) throw new Error(`candidate card ${cardId} is missing`);
      return card;
    }),
  };
}

function validateJudgments(
  output: AtomJudgeOutput,
  oracle: RecertifiedOracleEntry,
  candidates: readonly AtomCardCandidates[],
): void {
  const expected = new Set(oracle.evidence_atoms.map((atom) => atom.atom_id));
  const actual = output.judgments.map((judgment) => judgment.atomId);
  if (new Set(actual).size !== actual.length) throw new Error("judge returned duplicate atom IDs");
  if (actual.length !== expected.size || actual.some((atomId) => !expected.has(atomId))) {
    throw new Error("judge did not return exactly one judgment for every oracle atom");
  }
  // Certified atom descriptions may explicitly depend on another atom in the
  // same probe (for example, "later state, distinct from the initial state").
  // Permit only the union of provenance-matched cards from this probe; cards
  // from other questions or non-certified source turns remain forbidden.
  const allowed = new Set(candidates.flatMap((entry) => entry.candidateCardIds));
  for (const judgment of output.judgments) {
    for (const cardId of [...judgment.coveringCardIds, ...judgment.unsupportedCardIds]) {
      if (!allowed.has(cardId)) throw new Error(`judge referenced non-candidate card ${cardId}`);
    }
    if (judgment.covered && judgment.coveringCardIds.length === 0) {
      throw new Error(`covered atom ${judgment.atomId} has no covering cards`);
    }
  }
}

async function evaluate(args: Record<string, string>): Promise<void> {
  const outDir = projectPath(args.out, DEFAULT_OUT);
  const variant = args.variant ?? "primary";
  const runDir = resolve(outDir, variant);
  const freezePath = resolve(runDir, "freeze-manifest.json");
  if (!existsSync(freezePath)) throw new Error("ingestion has not been frozen");
  const freeze = JSON.parse(readFileSync(freezePath, "utf8")) as {
    status?: string;
    conversation_id?: string | number;
    exact_source_tokens_o200k?: number;
  };
  if (freeze.status !== "complete") throw new Error("only a complete frozen ingestion can be evaluated");

  // Probe and oracle files are deliberately opened only after the freeze check above.
  const probeManifestPath = projectPath(args["probe-manifest"], DEFAULT_PROBE_MANIFEST);
  const oraclePath = projectPath(args.oracle, DEFAULT_ORACLE);
  const manifest = JSON.parse(readFileSync(probeManifestPath, "utf8")) as FrozenAtomicIngestionCanaryManifest;
  const manifestValidation = validateFrozenCanaryManifest(manifest);
  if (!manifestValidation.valid) {
    throw new Error(`invalid frozen canary manifest: ${manifestValidation.errors.join("; ")}`);
  }
  const expectedConversation = variant === "primary"
    ? manifest.conversation_selection.primary_conversation_id
    : manifest.conversation_selection.shadow_conversation_id;
  if (String(expectedConversation) !== String(freeze.conversation_id)) {
    throw new Error("frozen ingestion conversation does not match the selected probe cohort");
  }
  const probeIds = variant === "primary" ? manifest.primary_probe_ids : manifest.shadow_probe_ids;
  const oracleFile = OracleFileSchema.parse(JSON.parse(readFileSync(oraclePath, "utf8")));
  const oracleById = new Map(oracleFile.entries.map((entry) => [entry.question_id, entry]));
  const probes = probeIds.map((questionId) => {
    const oracle = oracleById.get(questionId);
    if (!oracle || oracle.status !== "certified") throw new Error(`missing certified oracle ${questionId}`);
    return oracle;
  });

  const judgeModel = args["judge-model"] ?? DEFAULT_JUDGE_MODEL;
  const judgeReasoning = (args["judge-reasoning"] ?? "high") as ReasoningEffort;
  const concurrency = Number(args.concurrency ?? 24);
  const tokenBudget = Number(args["token-budget"] ?? 1_900_000);
  const maxCost = Number(args["max-cost"] ?? 100);
  const maxOutput = Number(args["judge-max-output"] ?? 6_000);
  const candidateScope = args["candidate-scope"] ?? "quote";
  if (!new Set(["quote", "turn"]).has(candidateScope)) {
    throw new Error("--candidate-scope must be quote or turn");
  }
  const prompts = new PromptLoader();
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const dispatch = new DispatchGate(tokenBudget, 60, concurrency);
  const costBudget = new CostBudget(maxCost);
  const evaluationDir = resolve(runDir, "evaluation");
  mkdirSync(evaluationDir, { recursive: true });

  const configurationResults: Array<Record<string, unknown>> = [];
  for (const configuration of ["nano", "audited"] as const) {
    const cards = readJsonl(
      resolve(runDir, `cards-${configuration}.jsonl`),
      MaterializedAtomicCardSchema,
    );
    const cardsById = new Map(cards.map((card) => [card.cardId, card]));
    const resultConfiguration = candidateScope === "quote"
      ? configuration
      : `${configuration}-turn`;
    const configDir = resolve(evaluationDir, resultConfiguration);
    mkdirSync(configDir, { recursive: true });
    const cases = await mapPool(probes, concurrency, async (oracle) => {
      const candidates = candidateScope === "quote"
        ? mapAcceptedCardSpansToOracleAtoms(cards, oracle)
        : mapAcceptedCardTurnsToOracleAtoms(cards, oracle);
      const payload = oracle.evidence_atoms.map((atom) => {
        const candidate = candidates.find((entry) => entry.atomId === atom.atom_id);
        if (!candidate) throw new Error(`missing candidate map ${atom.atom_id}`);
        return candidatePayload(atom, candidate, cardsById);
      });
      const casePath = resolve(configDir, `${safeName(oracle.question_id)}.json`);
      const caseSchema = atomJudgeOutputSchemaFor(candidates.flatMap((entry) => entry.candidateCardIds));
      let output: AtomJudgeOutput | null = null;
      try {
        output = loadCallValue(casePath, caseSchema);
      } catch (error) {
        renameSync(casePath, `${casePath}.invalid-${String(Date.now())}`);
        console.warn(JSON.stringify({
          event: "atomic_ingestion_judge_call_quarantined",
          configuration: resultConfiguration,
          question_id: oracle.question_id,
          reason: error instanceof Error ? error.message : String(error),
        }));
      }
      let callUsage: { usage: TokenUsage; cost: number; latencyMs: number } | null = null;
      if (!output) {
        const prompt = await prompts.render("beam-atomic-card-atom-judge-v1", {
          probe_atoms_with_candidate_cards: JSON.stringify(payload),
        });
        const call = await callStructured({
          openai,
          dispatch,
          costBudget,
          model: judgeModel,
          reasoning: judgeReasoning,
          prompt,
          schema: caseSchema,
          schemaName: "beam_atomic_card_atom_judge_v1",
          maxOutputTokens: maxOutput,
        });
        output = call.value;
        writeJson(casePath, callJson(call));
        callUsage = { usage: call.usage, cost: call.estimatedCostUsd, latencyMs: call.latencyMs };
      } else {
        callUsage = usageFromCallFile(casePath);
      }
      validateJudgments(output, oracle, candidates);
      const coveredAtoms = output.judgments.filter((judgment) => judgment.covered).length;
      const fullStory = coveredAtoms === oracle.evidence_atoms.length;
      return {
        question_id: oracle.question_id,
        ability: oracle.question_id.split("/")[2] ?? "unknown",
        total_atoms: oracle.evidence_atoms.length,
        covered_atoms: coveredAtoms,
        atom_recall: oracle.evidence_atoms.length === 0 ? 1 : coveredAtoms / oracle.evidence_atoms.length,
        full_story: fullStory,
        turn_only_compatibility: evaluateTurnOnlyAtomCoverage(cards, oracle),
        candidates,
        judgments: output.judgments,
        usage: callUsage,
      };
    });
    const totalAtoms = cases.reduce((sum, item) => sum + item.total_atoms, 0);
    const coveredAtoms = cases.reduce((sum, item) => sum + item.covered_atoms, 0);
    const criticalAbilities = new Set(["contradiction_resolution", "knowledge_update", "temporal_reasoning"]);
    const criticalCases = cases.filter((item) => criticalAbilities.has(item.ability));
    const unsupported = new Set(cases.flatMap((item) => item.judgments.flatMap((judgment) =>
      judgment.unsupportedCardIds,
    )));
    const result = {
      schema_version: 1,
      configuration: resultConfiguration,
      candidate_scope: candidateScope,
      judge: { model: judgeModel, reasoning: judgeReasoning },
      questions: cases.length,
      total_atoms: totalAtoms,
      covered_atoms: coveredAtoms,
      strict_semantic_atom_recall: totalAtoms === 0 ? 1 : coveredAtoms / totalAtoms,
      complete_stories: cases.filter((item) => item.full_story).length,
      critical_complete_stories: criticalCases.filter((item) => item.full_story).length,
      critical_story_denominator: criticalCases.length,
      unsupported_candidate_cards: unsupported.size,
      gates: {
        semantic_atom_recall_at_least_97pct: totalAtoms === 0 || coveredAtoms / totalAtoms >= 0.97,
        complete_stories_at_least_11_of_12: cases.filter((item) => item.full_story).length >= 11,
        critical_stories_6_of_6: criticalCases.length === 6 && criticalCases.every((item) => item.full_story),
        no_unsupported_candidates: unsupported.size === 0,
      },
      cases,
      usage: aggregateUsage(cases.flatMap((item) => item.usage ? [item.usage] : [])),
    };
    writeJson(resolve(configDir, "summary.json"), result);
    configurationResults.push(result);
  }

  const final = {
    schema_version: 1,
    benchmark: "BEAM",
    tier: "1M",
    phase: "atomic_ingestion_evaluation",
    variant,
    freeze_manifest_sha256: fileSha256(freezePath),
    probe_manifest_sha256: fileSha256(probeManifestPath),
    oracle_sha256: fileSha256(oraclePath),
    configurations: configurationResults,
    cost: costBudget.snapshot(),
  };
  writeJson(resolve(
    evaluationDir,
    candidateScope === "quote" ? "comparison.json" : `comparison-${candidateScope}.json`,
  ), final);
  console.log(JSON.stringify({ event: "atomic_ingestion_evaluation_complete", ...final }, null, 2));
}

async function main(): Promise<void> {
  loadDotEnv(resolve(PROJECT_ROOT, ".env"));
  const args = parseArgs(process.argv.slice(2));
  const phase = args.phase;
  if (phase === "ingest") await ingest(args);
  else if (phase === "evaluate") await evaluate(args);
  else throw new Error("--phase must be ingest or evaluate; phase separation is mandatory");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
