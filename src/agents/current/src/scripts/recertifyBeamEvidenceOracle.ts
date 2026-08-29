import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import OpenAI from "openai";
import { z } from "zod";

import { Bm25Index } from "../retrieval/bm25.js";
import type { RetrievalDocument } from "../retrieval/types.js";
import { PromptLoader } from "../services/promptLoader.js";
import {
  CostBudget,
  DispatchGate,
  callStructured,
  loadDotEnv,
  mapPool,
  type ReasoningEffort,
  type StructuredCallResult,
} from "../compression/structuredCall.js";
import type {
  RecertifiedEvidenceAtom,
  RecertifiedEvidenceSource,
  RecertifiedOracleEntry,
} from "../compression/beamCompression.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const DEFAULT_SOURCE_ROOT = resolve(
  PROJECT_ROOT,
  "runs/local-archive/beam-1m-canary-a-source/chats/1M",
);
const DEFAULT_QUESTION_RUN = resolve(
  PROJECT_ROOT,
  "runs/beam-1m-k81-downstream-20260806/retrieval/k81-mmr085-focused-answerable78.json",
);
const DEFAULT_OUT = resolve(
  PROJECT_ROOT,
  "runs/beam-1m-compression-oracle-recertification-20260808",
);
const DEFAULT_MODEL = "gpt-5.6-luna";

const AuditSchema = z.strictObject({
  overallStatus: z.enum(["supported", "needs_review"]),
  evidenceAtoms: z.array(z.strictObject({
    atomId: z.string().regex(/^[a-z][a-z0-9_]*$/),
    description: z.string().min(1).max(2_000),
    status: z.enum(["supported", "not_found", "ambiguous"]),
    sources: z.array(z.strictObject({
      messageId: z.number().int().nonnegative(),
      verbatimQuote: z.string().min(1).max(4_000),
    })).max(12),
  })).min(1).max(40),
});
type Audit = z.infer<typeof AuditSchema>;

type Message = {
  id?: number | string;
  role: "user" | "assistant";
  content: string;
  time_anchor?: string | null;
};
type Batch = {
  time_anchor?: string | null;
  turns?: Message[][];
};
type MessageRecord = {
  messageId: number;
  role: "user" | "assistant";
  content: string;
  date: string;
  sessionId: string;
  turnIndex: number;
};
type QuestionRef = { question_id: string };
type QuestionRun = { cases?: QuestionRef[]; question_ids?: string[] };
type RawProbe = Record<string, unknown>;
type ProbeFile = Record<string, RawProbe[]>;

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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function projectPath(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  return isAbsolute(value) ? value : resolve(PROJECT_ROOT, value);
}

function questionParts(questionId: string): { conversationId: number; ability: string; index: number } {
  const match = questionId.match(/^beam-1m\/chat-([0-9]+)\/([^/]+)\/([12])$/);
  if (!match?.[1] || !match[2] || !match[3]) throw new Error(`invalid question ID ${questionId}`);
  return { conversationId: Number(match[1]), ability: match[2], index: Number(match[3]) - 1 };
}

function sessionId(conversationId: number, sessionIndex: number): string {
  return `beam1m_c${String(conversationId).padStart(2, "0")}_s${String(sessionIndex + 1).padStart(4, "0")}`;
}

function flattenNumericIds(value: unknown): number[] {
  if (Array.isArray(value)) return value.flatMap(flattenNumericIds);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(flattenNumericIds);
  }
  const number = Number(value);
  return Number.isFinite(number) ? [number] : [];
}

function loadMessages(sourceRoot: string, conversationId: number): MessageRecord[] {
  const path = resolve(sourceRoot, String(conversationId), "chat.json");
  const batches = JSON.parse(readFileSync(path, "utf8")) as Batch[];
  const messages: MessageRecord[] = [];
  let date = "no-explicit-time-anchor";
  let sessionIndex = 0;
  for (const batch of batches) {
    if (typeof batch.time_anchor === "string" && batch.time_anchor.trim()) date = batch.time_anchor.trim();
    for (const group of batch.turns ?? []) {
      const id = sessionId(conversationId, sessionIndex);
      for (let turnIndex = 0; turnIndex < group.length; turnIndex += 1) {
        const message = group[turnIndex];
        if (!message) continue;
        if (typeof message.time_anchor === "string" && message.time_anchor.trim()) {
          date = message.time_anchor.trim();
        }
        const messageId = Number(message.id);
        if (!Number.isFinite(messageId)) throw new Error(`${path} has invalid message ID`);
        messages.push({
          messageId,
          role: message.role,
          content: message.content,
          date,
          sessionId: id,
          turnIndex,
        });
      }
      sessionIndex += 1;
    }
  }
  return messages;
}

function sanitizeProbe(value: unknown, key = ""): unknown {
  if (key === "source_chat_ids" || key === "conversation_sessions") return undefined;
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string" && /^chat_id:\s*[0-9]+$/i.test(item.trim())) return [];
      const sanitized = sanitizeProbe(item);
      return sanitized === undefined ? [] : [sanitized];
    });
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).flatMap(([childKey, child]) => {
      const sanitized = sanitizeProbe(child, childKey);
      return sanitized === undefined ? [] : [[childKey, sanitized] as const];
    });
    return Object.fromEntries(entries);
  }
  return value;
}

function buildCandidates(probe: RawProbe, messages: MessageRecord[]): MessageRecord[] {
  const sourceIds = new Set(flattenNumericIds(probe.source_chat_ids));
  const documents: RetrievalDocument[] = messages.map((message) => ({
    id: String(message.messageId),
    sessionId: message.sessionId,
    date: message.date,
    text: `${message.role} ${message.content}`,
    startTurn: message.turnIndex,
    endTurn: message.turnIndex,
  }));
  const index = new Bm25Index(documents);
  const query = JSON.stringify(sanitizeProbe(probe));
  const selectedIds = new Set(index.search(query, 56, 0).map((hit) => Number(hit.documentId)));
  const neighborRadius = sourceIds.size <= 4 ? 8 : 2;
  for (const sourceId of sourceIds) {
    selectedIds.add(sourceId);
    for (let delta = -neighborRadius; delta <= neighborRadius; delta += 1) {
      selectedIds.add(sourceId + delta);
    }
  }
  const byId = new Map(messages.map((message) => [message.messageId, message]));
  return [...selectedIds].flatMap((messageId) => {
    const message = byId.get(messageId);
    return message ? [message] : [];
  }).sort((left, right) => left.messageId - right.messageId);
}

function candidateJson(messages: MessageRecord[]): string {
  return JSON.stringify(messages.map((message) => ({
    messageId: message.messageId,
    role: message.role,
    date: message.date,
    content: message.content,
  })));
}

function sourceSet(audit: Audit): string {
  return [...new Set(audit.evidenceAtoms.flatMap((atom) =>
    atom.status === "supported" ? atom.sources.map((source) => source.messageId) : [],
  ))].sort((left, right) => left - right).join(",");
}

function validateAudit(
  audit: Audit,
  candidates: MessageRecord[],
  options: { allowExplicitExclusions?: boolean } = {},
): { entry: Omit<RecertifiedOracleEntry, "question_id">; invalidCitations: string[] } {
  const byId = new Map(candidates.map((message) => [message.messageId, message]));
  const invalidCitations: string[] = [];
  const evidenceAtoms: RecertifiedEvidenceAtom[] = audit.evidenceAtoms.flatMap((atom) => {
    if (atom.status !== "supported") return [];
    const sources: RecertifiedEvidenceSource[] = atom.sources.flatMap((source) => {
      const message = byId.get(source.messageId);
      if (!message) {
        invalidCitations.push(`${atom.atomId}: unknown message ${String(source.messageId)}`);
        return [];
      }
      if (!message.content.includes(source.verbatimQuote)) {
        invalidCitations.push(`${atom.atomId}: quote mismatch for ${String(source.messageId)}`);
        return [];
      }
      return [{
        message_id: message.messageId,
        session_id: message.sessionId,
        turn_index: message.turnIndex,
        role: message.role,
        quote: source.verbatimQuote,
      }];
    });
    return [{
      atom_id: atom.atomId,
      description: atom.description,
      sources,
    }];
  });
  const excludedAnswerAtoms = audit.evidenceAtoms.flatMap((atom) =>
    atom.status === "supported" ? [] : [{
      atom_id: atom.atomId,
      description: atom.description,
      status: atom.status,
    }]);
  const unsupported = evidenceAtoms.length === 0
    || evidenceAtoms.some((atom) => atom.sources.length === 0)
    || (!options.allowExplicitExclusions && excludedAnswerAtoms.length > 0);
  const certified = !unsupported
    && invalidCitations.length === 0
    && (options.allowExplicitExclusions || audit.overallStatus === "supported");
  return {
    entry: {
      status: certified ? "certified" : "needs_review",
      evidence_atoms: evidenceAtoms,
      ...(excludedAnswerAtoms.length > 0 ? { excluded_answer_atoms: excludedAnswerAtoms } : {}),
    },
    invalidCitations,
  };
}

function safeName(questionId: string): string {
  return questionId.replaceAll("/", "__");
}

function callTrace<T>(call: StructuredCallResult<T>): Record<string, unknown> {
  return {
    value: call.value,
    output_text: call.outputText,
    usage: call.usage,
    latency_ms: call.latencyMs,
    request_id: call.requestId,
    retry_count: call.retryCount,
    input_sha256: call.inputSha256,
    cost_usd: call.estimatedCostUsd,
    prompt_messages: call.promptMessages,
  };
}

async function main(): Promise<void> {
  loadDotEnv(resolve(PROJECT_ROOT, ".env"));
  const args = parseArgs(process.argv.slice(2));
  const sourceRoot = projectPath(args["source-root"], DEFAULT_SOURCE_ROOT);
  const questionRunPath = projectPath(args.questions, DEFAULT_QUESTION_RUN);
  const outDir = projectPath(args.out, DEFAULT_OUT);
  const model = args.model ?? DEFAULT_MODEL;
  const primaryReasoning = (args["primary-reasoning"] ?? "medium") as ReasoningEffort;
  const reviewReasoning = (args["review-reasoning"] ?? "high") as ReasoningEffort;
  const dryRun = args["dry-run"] === "true";
  const adjudicate = args.adjudicate === "true";
  const finalizeExclusionsOnly = args["finalize-exclusions-only"] === "true";
  const concurrency = Number(args.concurrency ?? 8);
  const tokenBudget = Number(args["token-budget"] ?? 1_900_000);
  const maxCost = Number(args["max-cost"] ?? 2.5);
  const maxOutputTokens = Number(args["max-output"] ?? 12_000);
  const questions = JSON.parse(readFileSync(questionRunPath, "utf8")) as QuestionRun;
  const sourceQuestionIds = questions.cases?.map((item) => item.question_id)
    ?? questions.question_ids
    ?? [];
  const onlyIds = new Set((args["ids-filter"] ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  const filteredQuestionIds = onlyIds.size > 0
    ? sourceQuestionIds.filter((questionId) => onlyIds.has(questionId))
    : sourceQuestionIds;
  const limit = Number(args.limit ?? filteredQuestionIds.length);
  const questionIds = filteredQuestionIds.slice(0, limit);
  if (questionIds.length === 0) throw new Error("question run contains no selected question IDs");
  const prompts = new PromptLoader();
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const dispatch = new DispatchGate(tokenBudget, 60, concurrency);
  const costBudget = new CostBudget(maxCost);
  const casesDir = resolve(outDir, "cases");
  mkdirSync(casesDir, { recursive: true });
  const messageCache = new Map<number, MessageRecord[]>();
  const probeCache = new Map<number, ProbeFile>();

  if (dryRun) {
    const packsDir = resolve(outDir, "candidate-packs");
    mkdirSync(packsDir, { recursive: true });
    const packRows = questionIds.map((questionId) => {
      const parts = questionParts(questionId);
      let messages = messageCache.get(parts.conversationId);
      if (!messages) {
        messages = loadMessages(sourceRoot, parts.conversationId);
        messageCache.set(parts.conversationId, messages);
      }
      let probes = probeCache.get(parts.conversationId);
      if (!probes) {
        probes = JSON.parse(readFileSync(resolve(
          sourceRoot,
          String(parts.conversationId),
          "probing_questions/probing_questions.json",
        ), "utf8")) as ProbeFile;
        probeCache.set(parts.conversationId, probes);
      }
      const probe = probes[parts.ability]?.[parts.index];
      if (!probe) throw new Error(`missing probe ${questionId}`);
      const candidates = buildCandidates(probe, messages);
      const originalSourceIds = [...new Set(flattenNumericIds(probe.source_chat_ids))].sort((a, b) => a - b);
      const candidateIds = new Set(candidates.map((message) => message.messageId));
      const pack = {
        schema_version: 1,
        question_id: questionId,
        ability: parts.ability,
        probe_without_source_ids: sanitizeProbe(probe),
        original_source_message_ids: originalSourceIds,
        candidate_count: candidates.length,
        all_original_sources_in_candidates: originalSourceIds.every((messageId) => candidateIds.has(messageId)),
        candidates: candidates.map((message) => ({
          message_id: message.messageId,
          role: message.role,
          date: message.date,
          session_id: message.sessionId,
          turn_index: message.turnIndex,
          content: message.content,
        })),
      };
      const path = resolve(packsDir, `${safeName(questionId)}.json`);
      writeFileSync(path, `${JSON.stringify(pack, null, 2)}\n`);
      return { question_id: questionId, path, candidate_count: candidates.length };
    });
    const summary = {
      schema_version: 1,
      status: "candidate_packs_ready_no_model_calls",
      questions: packRows.length,
      mean_candidates: packRows.reduce((sum, row) => sum + row.candidate_count, 0) / packRows.length,
      packs: packRows,
    };
    writeFileSync(resolve(outDir, "dry-run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const resume = args.resume !== "false";
  const completedRows = new Map<string, Record<string, unknown>>();
  if (resume) {
    for (const questionId of questionIds) {
      const path = resolve(casesDir, `${safeName(questionId)}.json`);
      if (!existsSync(path)) continue;
      completedRows.set(questionId, JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>);
    }
  }
  const pendingQuestionIds = questionIds.filter((questionId) => !completedRows.has(questionId));
  console.log(JSON.stringify({
    event: "oracle_recertification_resume",
    selected: questionIds.length,
    completed: completedRows.size,
    pending: pendingQuestionIds.length,
  }));

  const newRows = await mapPool(pendingQuestionIds, concurrency, async (questionId) => {
    const parts = questionParts(questionId);
    let messages = messageCache.get(parts.conversationId);
    if (!messages) {
      messages = loadMessages(sourceRoot, parts.conversationId);
      messageCache.set(parts.conversationId, messages);
    }
    let probes = probeCache.get(parts.conversationId);
    if (!probes) {
      probes = JSON.parse(readFileSync(resolve(
        sourceRoot,
        String(parts.conversationId),
        "probing_questions/probing_questions.json",
      ), "utf8")) as ProbeFile;
      probeCache.set(parts.conversationId, probes);
    }
    const probe = probes[parts.ability]?.[parts.index];
    if (!probe) throw new Error(`missing probe ${questionId}`);
    const candidates = buildCandidates(probe, messages);
    const sanitizedProbe = JSON.stringify(sanitizeProbe(probe));
    const candidatesText = candidateJson(candidates);
    const primaryPrompt = await prompts.render("beam-evidence-recertify-v1", {
      probe_record: sanitizedProbe,
      candidate_messages: candidatesText,
    });
    const primary = await callStructured({
      openai,
      dispatch,
      costBudget,
      model,
      reasoning: primaryReasoning,
      prompt: primaryPrompt,
      schema: AuditSchema,
      schemaName: "beam_evidence_recertify_v1",
      maxOutputTokens,
    });
    const originalSourceIds = [...new Set(flattenNumericIds(probe.source_chat_ids))].sort((a, b) => a - b);
    const primaryChanged = sourceSet(primary.value) !== originalSourceIds.join(",");
    const primaryValidation = validateAudit(primary.value, candidates);
    let review: StructuredCallResult<Audit> | null = null;
    if (primaryChanged || primaryValidation.entry.status === "needs_review") {
      const reviewPrompt = await prompts.render("beam-evidence-recertify-review-v1", {
        probe_record: sanitizedProbe,
        candidate_messages: candidatesText,
        primary_audit: JSON.stringify(primary.value),
      });
      review = await callStructured({
        openai,
        dispatch,
        costBudget,
        model,
        reasoning: reviewReasoning,
        prompt: reviewPrompt,
        schema: AuditSchema,
        schemaName: "beam_evidence_recertify_review_v1",
        maxOutputTokens,
      });
    }
    const reviewerAgrees = review === null || sourceSet(review.value) === sourceSet(primary.value);
    const selectedAudit = review?.value ?? primary.value;
    const validation = validateAudit(selectedAudit, candidates);
    const entry: RecertifiedOracleEntry = {
      question_id: questionId,
      status: validation.entry.status === "certified" && reviewerAgrees
        ? "certified"
        : "needs_review",
      evidence_atoms: validation.entry.evidence_atoms,
    };
    const selectedIds = [...new Set(entry.evidence_atoms.flatMap((atom) =>
      atom.sources.map((source) => source.message_id),
    ))].sort((a, b) => a - b);
    const row = {
      question_id: questionId,
      ability: parts.ability,
      status: entry.status,
      original_source_message_ids: originalSourceIds,
      recertified_source_message_ids: selectedIds,
      changed: originalSourceIds.join(",") !== selectedIds.join(","),
      reviewer_required: review !== null,
      reviewer_agrees: reviewerAgrees,
      candidate_count: candidates.length,
      invalid_citations: validation.invalidCitations,
      oracle_entry: entry,
      primary: callTrace(primary),
      review: review ? callTrace(review) : null,
    };
    writeFileSync(resolve(casesDir, `${safeName(questionId)}.json`), `${JSON.stringify(row, null, 2)}\n`);
    console.log(JSON.stringify({
      event: "oracle_case_complete",
      question_id: questionId,
      status: entry.status,
      changed: row.changed,
      reviewer_agrees: reviewerAgrees,
      cost: costBudget.snapshot(),
    }));
    return row;
  });

  let rows = [...completedRows.values(), ...newRows] as Array<{
    question_id: string;
    ability: string;
    status: "certified" | "needs_review";
    changed: boolean;
    reviewer_required: boolean;
    reviewer_agrees: boolean;
    oracle_entry: RecertifiedOracleEntry;
    primary: { value: Audit; cost_usd?: number };
    review: { value: Audit; cost_usd?: number } | null;
    adjudication?: { value: Audit; cost_usd?: number } | null;
  }>;
  rows.sort((left, right) => left.question_id.localeCompare(right.question_id));

  if (adjudicate) {
    rows = await mapPool(rows, Math.min(concurrency, 4), async (row) => {
      if (row.status === "certified") return row;
      const parts = questionParts(row.question_id);
      let messages = messageCache.get(parts.conversationId);
      if (!messages) {
        messages = loadMessages(sourceRoot, parts.conversationId);
        messageCache.set(parts.conversationId, messages);
      }
      let probes = probeCache.get(parts.conversationId);
      if (!probes) {
        probes = JSON.parse(readFileSync(resolve(
          sourceRoot,
          String(parts.conversationId),
          "probing_questions/probing_questions.json",
        ), "utf8")) as ProbeFile;
        probeCache.set(parts.conversationId, probes);
      }
      const probe = probes[parts.ability]?.[parts.index];
      if (!probe) throw new Error(`missing probe ${row.question_id}`);
      const candidates = buildCandidates(probe, messages);
      if (row.adjudication) {
        const priorValidation = validateAudit(
          row.adjudication.value,
          candidates,
          { allowExplicitExclusions: true },
        );
        if (priorValidation.entry.status === "certified" || finalizeExclusionsOnly) {
          const entry: RecertifiedOracleEntry = {
            question_id: row.question_id,
            ...priorValidation.entry,
          };
          const finalized = {
            ...row,
            status: entry.status,
            invalid_citations: priorValidation.invalidCitations,
            oracle_entry: entry,
          };
          writeFileSync(
            resolve(casesDir, `${safeName(row.question_id)}.json`),
            `${JSON.stringify(finalized, null, 2)}\n`,
          );
          console.log(JSON.stringify({
            event: "oracle_explicit_exclusions_finalized",
            question_id: row.question_id,
            status: entry.status,
            excluded_answer_atoms: entry.excluded_answer_atoms?.length ?? 0,
          }));
          return finalized;
        }
      }
      const prompt = await prompts.render("beam-evidence-recertify-adjudicate-v1", {
        probe_record: JSON.stringify(sanitizeProbe(probe)),
        candidate_messages: candidateJson(candidates),
        primary_audit: JSON.stringify(row.primary.value),
        review_audit: JSON.stringify(row.review?.value ?? null),
        prior_adjudication: JSON.stringify(row.adjudication?.value ?? null),
        validation_feedback: JSON.stringify(
          (row as typeof row & { invalid_citations?: string[] }).invalid_citations ?? [],
        ),
      });
      const call = await callStructured({
        openai,
        dispatch,
        costBudget,
        model,
        reasoning: reviewReasoning,
        prompt,
        schema: AuditSchema,
        schemaName: "beam_evidence_recertify_adjudicate_v1",
        maxOutputTokens,
      });
      const validation = validateAudit(
        call.value,
        candidates,
        { allowExplicitExclusions: true },
      );
      const entry: RecertifiedOracleEntry = {
        question_id: row.question_id,
        status: validation.entry.status,
        evidence_atoms: validation.entry.evidence_atoms,
      };
      const updated = {
        ...row,
        status: entry.status,
        invalid_citations: validation.invalidCitations,
        oracle_entry: entry,
        adjudication: callTrace(call) as { value: Audit; cost_usd?: number },
      };
      writeFileSync(
        resolve(casesDir, `${safeName(row.question_id)}.json`),
        `${JSON.stringify(updated, null, 2)}\n`,
      );
      console.log(JSON.stringify({
        event: "oracle_case_adjudicated",
        question_id: row.question_id,
        status: entry.status,
        invalid_citations: validation.invalidCitations.length,
        cost: costBudget.snapshot(),
      }));
      return updated;
    });
  }

  const loggedCost = rows.reduce((total, row) =>
    total
    + (row.primary.cost_usd ?? 0)
    + (row.review?.cost_usd ?? 0)
    + (row.adjudication?.cost_usd ?? 0), 0);
  const oracle = {
    schema_version: 1,
    benchmark: "BEAM",
    tier: "1M",
    role: "versioned_evidence_oracle_for_compression_evaluation_only",
    source_question_run: questionRunPath,
    source_question_run_sha256: sha256(readFileSync(questionRunPath)),
    source_root: sourceRoot,
    model,
    primary_reasoning: primaryReasoning,
    review_reasoning: reviewReasoning,
    max_output_tokens: maxOutputTokens,
    adjudication_enabled: adjudicate,
    entries: rows.map((row) => row.oracle_entry),
  };
  const summary = {
    schema_version: 1,
    questions: rows.length,
    certified: rows.filter((row) => row.status === "certified").length,
    needs_review: rows.filter((row) => row.status === "needs_review").length,
    changed: rows.filter((row) => row.changed).length,
    reviewer_disagreements: rows.filter((row) => row.reviewer_required && !row.reviewer_agrees).length,
    adjudicated: rows.filter((row) => row.adjudication).length,
    new_call_cost: costBudget.snapshot(),
    logged_successful_call_cost_usd: loggedCost,
  };
  writeFileSync(resolve(outDir, "oracle-recertified-v1.json"), `${JSON.stringify(oracle, null, 2)}\n`);
  writeFileSync(resolve(outDir, "audit-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ event: "oracle_recertification_complete", out_dir: outDir, ...summary }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
