/**
 * Compare downstream readers over one frozen hop-retriever bag per question.
 *
 * The script never reads oracle/gold fields. It hydrates only session IDs in
 * each frozen bag, interleaves arm/case tasks, and emits standard judgeable run
 * directories.
 *
 * Arms:
 *   1a - unchanged select-v4 -> existing package builder -> answer-v8
 *   1b - notes-aware selector + deterministic coverage/adjacency repair
 *   2  - deterministic balanced raw-turn package (no selector call)
 *   3  - parallel per-session extraction -> deterministic raw-turn reduction
 *   4  - every raw turn from the frozen bag -> answer (no deletion cap)
 *   5  - parallel per-session extraction -> exact-deduped claim package (no deletion cap)
 *
 * Usage:
 *   pnpm --dir src/agents/current exec node --import tsx \
 *     src/scripts/hopBagDownstreamGate.ts \
 *     --hop-run runs/local-archive/backbone/hop-gate-luna-h6-v1-answerable135.json \
 *     --out-prefix hop-bag-downstream-answerable135-v1 \
 *     --concurrency 128 --token-budget 2000000
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

import {
  loadArchitectureCases,
  type ArchitectureCase as RawCase,
} from "../benchmarks/architectureDataset.js";
import {
  buildContextPackage,
  tokenizeForPackage,
} from "../nodes/selectContext.js";
import { renderAnswerPrompt, renderSelectPrompt } from "../answer/renderAnswerPrompt.js";
import { sessionToFullSpan } from "../retrieval/seriesExpand.js";
import {
  DEFAULT_RETRIEVAL_OPTIONS,
  type RetrievalResult,
  type SelectedSpan,
} from "../retrieval/types.js";
import {
  formatNotesDocumentText,
  loadAnnotations,
  type SessionAnnotation,
} from "../retrieval/notesIndex.js";
import {
  assertNoRawSessionIdLeak,
  buildOpaqueSessionSpace,
} from "../retrieval/opaqueSessionIds.js";
import {
  isBroadHistoryQuestion,
  retainMappedSession,
} from "../retrieval/retrievalProfile.js";
import { PromptLoader, type PromptEnvelope } from "../services/promptLoader.js";
import {
  AnswerOutputSchema,
  SelectOutputSchema,
  type ContextPackage,
  type ContextPackageItem,
  type SelectOutput,
  type TimestampedSession,
  UNAVAILABLE_MEMORY_HYPOTHESIS,
} from "../types.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const DEFAULT_HOP_RUN = resolve(
  PROJECT_ROOT,
  "runs/local-archive/backbone/hop-gate-luna-h6-v1-answerable135.json",
);
const DEFAULT_DATASET = resolve(PROJECT_ROOT, "data/raw/longmemeval_s_cleaned.json");
const DEFAULT_ORACLE = resolve(PROJECT_ROOT, "data/raw/longmemeval_oracle.json");
const DEFAULT_ANNOTATIONS = resolve(
  PROJECT_ROOT,
  "runs/local-archive/backbone/session-annotations-v1",
);
const DEFAULT_MODEL = "gpt-5.4-nano-2026-03-17";
const ANSWER_PROMPT = "answer-v8-preference";
const PACKAGE_MAX_TURNS = 40;
const PACKAGE_CHAR_BUDGET = 40_000;
const RAW_EXCERPT_MAX_CHARS = 4_000;
const ALL_ARMS = ["1a", "1b", "2", "3", "4", "5"] as const;
type Arm = (typeof ALL_ARMS)[number];
type ReasoningEffort = "low" | "medium" | "high";

type FrozenHopCase = {
  question_id: string;
  bag: string[];
};
type FrozenHopRun = {
  model?: string;
  reasoning?: string;
  prompt?: string;
  hop_budget?: number;
  arm?: string;
  cases: FrozenHopCase[];
};
type Ref = { turnIndex: number; why: string };

const SessionExtractSchema = z.strictObject({
  candidateStatus: z.enum(["found", "none_found"]),
  missingRisk: z.string(),
  claims: z
    .array(
      z.strictObject({
        turnIndex: z.number().int().nonnegative(),
        fact: z.string(),
        why: z.string(),
      }),
    )
    .max(24),
});

type TokenUsage = {
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  reasoning_tokens: number | null;
};
type Generation = {
  text: string;
  model: string;
  provider: "openai";
  usage: TokenUsage;
  latency_ms: number;
  request_id: string | null;
  retry_count: number;
};
type ModelCall = {
  sequence: number;
  role: string;
  kind: "generation";
  provider: "openai";
  model: string;
  input_sha256: string;
  item_count: 1;
  parameters: Record<string, unknown>;
  usage: TokenUsage;
  latency_ms: number;
  request_id: string | null;
  retry_count: number;
};
type ModelIoRecord = {
  sequence: number;
  role: string;
  model: string;
  reasoning: ReasoningEffort;
  prompt_messages: PromptEnvelope["messages"];
  output_text: string;
  parsed_output: unknown;
  usage: TokenUsage;
  latency_ms: number;
  request_id: string | null;
  retry_count: number;
};
type StructuredCall<T> = {
  value: T;
  generation: Generation;
  call: ModelCall;
  io: ModelIoRecord;
};

function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      out[key] = "true";
    } else {
      out[key] = next;
      index += 1;
    }
  }
  return out;
}

function assertSlug(value: string, label: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`${label} may contain only letters, numbers, dots, underscores, and dashes`);
  }
}

function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

function promptText(prompt: PromptEnvelope): string {
  return prompt.messages.map((message) => `<${message.role}>\n${message.content}`).join("\n\n");
}

function estimateInputTokens(prompt: PromptEnvelope): number {
  return Math.ceil(Buffer.byteLength(promptText(prompt), "utf8") / 3);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function retryDelay(error: unknown, attempt: number): number | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!/rate|429|timeout|5\d\d|ECONNRESET|ETIMEDOUT|empty structured/i.test(message)) {
    return null;
  }
  const retryMatch = message.match(/try again in ([0-9.]+)\s*(ms|s)/i);
  let waitMs = 1000 * 2 ** attempt;
  if (retryMatch) {
    const amount = Number(retryMatch[1]);
    waitMs = retryMatch[2]?.toLowerCase() === "ms" ? amount : amount * 1000;
    waitMs = Math.max(500, waitMs + 250);
  }
  if (/429|rate limit/i.test(message)) waitMs = Math.max(waitMs, 2000);
  return Math.min(waitMs, 60_000);
}

class DispatchGate {
  readonly #budget: number;
  readonly #windowMs: number;
  readonly #maxConcurrency: number;
  #reservations: Array<{ at: number; tokens: number }> = [];
  #active = 0;

  constructor(budget: number, windowSeconds: number, maxConcurrency: number) {
    this.#budget = budget;
    this.#windowMs = windowSeconds * 1000;
    this.#maxConcurrency = maxConcurrency;
  }

  async acquire(tokens: number): Promise<() => void> {
    if (tokens > this.#budget) {
      throw new Error(`single request reservation ${String(tokens)} exceeds token budget`);
    }
    for (;;) {
      const now = Date.now();
      this.#reservations = this.#reservations.filter(
        (reservation) => now - reservation.at < this.#windowMs,
      );
      const reserved = this.#reservations.reduce((sum, reservation) => sum + reservation.tokens, 0);
      if (this.#active < this.#maxConcurrency && reserved + tokens <= this.#budget) {
        this.#active += 1;
        this.#reservations.push({ at: now, tokens });
        return () => {
          this.#active -= 1;
        };
      }
      await sleep(100);
    }
  }
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function run(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) throw new Error("task pool contains a sparse item");
      results[index] = await worker(item, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return results;
}

async function callStructured<T>(args: {
  openai: OpenAI;
  gate: DispatchGate;
  model: string;
  prompt: PromptEnvelope;
  rawSessionIdsForLeakCheck?: string[];
  schema: z.ZodType<T>;
  schemaName: string;
  role: string;
  reasoning: ReasoningEffort;
  maxOutputTokens: number;
  outputReservation: number;
  sequence: number;
}): Promise<StructuredCall<T>> {
  const serializedPrompt = promptText(args.prompt);
  assertNoRawSessionIdLeak(
    serializedPrompt,
    args.rawSessionIdsForLeakCheck ?? [],
  );
  let lastError: unknown;
  for (let attempt = 0; attempt <= 6; attempt += 1) {
    const reservation = estimateInputTokens(args.prompt) + args.outputReservation;
    const release = await args.gate.acquire(reservation);
    const started = performance.now();
    try {
      const response = await args.openai.responses.parse(
        {
          model: args.model,
          input: args.prompt.messages,
          max_output_tokens: args.maxOutputTokens,
          reasoning: { effort: args.reasoning },
          text: { format: zodTextFormat(args.schema, args.schemaName) },
        },
        { timeout: 300_000 },
      );
      const parsed = response.output_parsed;
      if (parsed === null || parsed === undefined) {
        throw new Error("empty structured output");
      }
      const value = args.schema.parse(parsed);
      const latency = performance.now() - started;
      const usage: TokenUsage = {
        input_tokens: response.usage?.input_tokens ?? null,
        output_tokens: response.usage?.output_tokens ?? null,
        total_tokens: response.usage?.total_tokens ?? null,
        reasoning_tokens: response.usage?.output_tokens_details.reasoning_tokens ?? null,
      };
      const retryCount = attempt;
      const requestId = response._request_id ?? null;
      return {
        value,
        generation: {
          text: response.output_text,
          model: args.model,
          provider: "openai",
          usage,
          latency_ms: latency,
          request_id: requestId,
          retry_count: retryCount,
        },
        call: {
          sequence: args.sequence,
          role: args.role,
          kind: "generation",
          provider: "openai",
          model: args.model,
          input_sha256: sha256(promptText(args.prompt)),
          item_count: 1,
          parameters: {
            temperature: 1,
            reasoning_effort: args.reasoning,
            max_output_tokens: args.maxOutputTokens,
          },
          usage,
          latency_ms: latency,
          request_id: requestId,
          retry_count: retryCount,
        },
        io: {
          sequence: args.sequence,
          role: args.role,
          model: args.model,
          reasoning: args.reasoning,
          prompt_messages: args.prompt.messages,
          output_text: response.output_text,
          parsed_output: value,
          usage,
          latency_ms: latency,
          request_id: requestId,
          retry_count: retryCount,
        },
      };
    } catch (error) {
      lastError = error;
      const waitMs = retryDelay(error, attempt);
      if (waitMs === null || attempt === 6) break;
      await sleep(waitMs);
    } finally {
      release();
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function hydrateBag(raw: RawCase, bag: string[]): {
  sessions: TimestampedSession[];
  missingSessionIds: string[];
} {
  const byId = new Map<string, TimestampedSession>();
  for (let index = 0; index < raw.haystack_session_ids.length; index += 1) {
    const sessionId = raw.haystack_session_ids[index];
    if (!sessionId || byId.has(sessionId)) continue;
    byId.set(sessionId, {
      session_id: sessionId,
      date: raw.haystack_dates[index] ?? "",
      turns: raw.haystack_sessions[index] ?? [],
    });
  }
  const missingSessionIds: string[] = [];
  const sessions: TimestampedSession[] = [];
  for (const sessionId of new Set(bag)) {
    const session = byId.get(sessionId);
    if (session) sessions.push(session);
    else missingSessionIds.push(sessionId);
  }
  sessions.sort(
    (left, right) =>
      left.date.localeCompare(right.date) || left.session_id.localeCompare(right.session_id),
  );
  return { sessions, missingSessionIds };
}

function spansForSessions(sessions: TimestampedSession[]): SelectedSpan[] {
  return sessions.map(sessionToFullSpan);
}

function retrievalForSpans(spans: SelectedSpan[]): RetrievalResult {
  const characterCount = spans.reduce((sum, span) => sum + span.characterCount, 0);
  return {
    windows: [],
    ranked: [],
    spans,
    characterCount,
    estimatedTokens: Math.ceil(characterCount / 4),
    options: DEFAULT_RETRIEVAL_OPTIONS,
  };
}

function overlapCount(left: Set<string>, right: Iterable<string>): number {
  let count = 0;
  for (const token of right) {
    if (left.has(token)) count += 1;
  }
  return count;
}

function inferShape(question: string): ContextPackage["queryShape"] {
  const normalized = question.toLowerCase();
  if (
    /\b(how long|before|after|first|last|earliest|latest|chronolog|in what order|when did)\b/.test(
      normalized,
    )
  ) {
    return "order";
  }
  if (
    /\b(how many|total|sum|combined|altogether|list all|which .* most|what .* did i|compare)\b/.test(
      normalized,
    )
  ) {
    return "aggregate";
  }
  if (
    /\b(now|currently|changed|change in|updated|used to|previously|compared with|compared to)\b/.test(
      normalized,
    )
  ) {
    return "update-conflict";
  }
  return "lookup";
}

function makeAnchorRefs(
  question: string,
  session: TimestampedSession,
  annotation: SessionAnnotation | undefined,
): Ref[] {
  const questionTokens = tokenizeForPackage(question);
  const asksAssistant =
    /\b(you|assistant)\b.*\b(said|say|recommend|suggest|explain|advis)/i.test(question)
    || /\bwhat did you\b/i.test(question);
  const asksQuantity = /\b(how many|total|sum|amount|number|count)\b/i.test(question);
  const scores = new Map<number, { score: number; why: string }>();
  const record = (turnIndex: number, text: string, source: string): void => {
    if (turnIndex < 0 || turnIndex >= session.turns.length) return;
    const turn = session.turns[turnIndex];
    if (!turn) return;
    let score = overlapCount(questionTokens, tokenizeForPackage(`${text}\n${turn.content}`)) * 10;
    if (asksAssistant && turn.role === "assistant") score += 8;
    if (asksQuantity && /\d/.test(`${text} ${turn.content}`)) score += 3;
    if (source !== "raw lexical") score += 2;
    const previous = scores.get(turnIndex);
    if (!previous || score > previous.score) {
      scores.set(turnIndex, { score, why: `${source}; lexical score ${String(score)}` });
    }
  };
  for (const fact of annotation?.facts ?? []) {
    record(fact.turn_index, fact.text, "annotation fact anchor");
  }
  for (const event of annotation?.events ?? []) {
    record(event.turn_index, `${event.text} ${event.date_hint}`, "annotation event anchor");
  }
  for (let turnIndex = 0; turnIndex < session.turns.length; turnIndex += 1) {
    const turn = session.turns[turnIndex];
    if (turn) record(turnIndex, turn.content, "raw lexical");
  }
  return [...scores.entries()]
    .sort(
      ([leftIndex, left], [rightIndex, right]) =>
        right.score - left.score || leftIndex - rightIndex,
    )
    .slice(0, 10)
    .map(([turnIndex, value]) => ({ turnIndex, why: value.why }));
}

function adjacentIndexes(session: TimestampedSession, turnIndex: number): number[] {
  const turn = session.turns[turnIndex];
  if (!turn) return [];
  const candidates =
    turn.role === "user"
      ? [turnIndex, turnIndex + 1, turnIndex - 1]
      : [turnIndex - 1, turnIndex, turnIndex + 1];
  const unique: number[] = [];
  for (const index of candidates) {
    if (index < 0 || index >= session.turns.length || unique.includes(index)) continue;
    unique.push(index);
  }
  return unique;
}

function buildBalancedPackage(args: {
  question: string;
  sessions: TimestampedSession[];
  refsBySession: Map<string, Ref[]>;
  missingRisk: string;
}): ContextPackage {
  const items: ContextPackageItem[] = [];
  const seen = new Set<string>();
  let characterCount = 0;
  const addTurn = (
    session: TimestampedSession,
    turnIndex: number,
    ref: Ref,
    tier: ContextPackageItem["tier"],
    why: string,
  ): boolean => {
    if (items.length >= PACKAGE_MAX_TURNS) return false;
    const key = `${session.session_id}:${String(turnIndex)}`;
    if (seen.has(key)) return true;
    const turn = session.turns[turnIndex];
    if (!turn) return true;
    const text =
      turn.content.length <= RAW_EXCERPT_MAX_CHARS
        ? turn.content
        : turn.content.slice(0, RAW_EXCERPT_MAX_CHARS);
    if (characterCount + text.length > PACKAGE_CHAR_BUDGET && items.length > 0) {
      return false;
    }
    seen.add(key);
    characterCount += text.length;
    items.push({
      sessionId: session.session_id,
      turnIndex,
      date: session.date,
      role: turn.role,
      text,
      why:
        turn.content.length > RAW_EXCERPT_MAX_CHARS
          ? `${why}; verbatim prefix capped at ${String(RAW_EXCERPT_MAX_CHARS)} chars`
          : why,
      tier,
    });
    return true;
  };
  const addBlock = (session: TimestampedSession, ref: Ref): boolean => {
    for (const turnIndex of adjacentIndexes(session, ref.turnIndex)) {
      if (
        !addTurn(
          session,
          turnIndex,
          ref,
          turnIndex === ref.turnIndex ? "selected" : "supporting",
          turnIndex === ref.turnIndex ? ref.why : "adjacent conversational context",
        )
      ) {
        return false;
      }
    }
    return true;
  };

  // Coverage round: reserve one bounded raw excerpt per candidate session before
  // any adjacency or breadth can consume the shared package budget.
  const positions = new Map<string, number>();
  for (const session of args.sessions) {
    const refs = args.refsBySession.get(session.session_id) ?? [];
    const first = refs[0];
    positions.set(session.session_id, first ? 1 : 0);
    if (first && !addTurn(session, first.turnIndex, first, "selected", first.why)) break;
  }

  // Pair each coverage anchor with its neighboring conversational turn.
  for (const session of args.sessions) {
    const first = (args.refsBySession.get(session.session_id) ?? [])[0];
    if (!first) continue;
    for (const turnIndex of adjacentIndexes(session, first.turnIndex)) {
      if (turnIndex === first.turnIndex) continue;
      if (
        !addTurn(
          session,
          turnIndex,
          first,
          "supporting",
          "adjacent conversational context",
        )
      ) {
        break;
      }
    }
  }

  // Breadth rounds: add the next-best block from each session in rotation.
  for (;;) {
    let progressed = false;
    for (const session of args.sessions) {
      const refs = args.refsBySession.get(session.session_id) ?? [];
      const position = positions.get(session.session_id) ?? 0;
      const next = refs[position];
      if (!next) continue;
      positions.set(session.session_id, position + 1);
      progressed = true;
      if (!addBlock(session, next)) {
        progressed = false;
        break;
      }
    }
    if (!progressed || items.length >= PACKAGE_MAX_TURNS) break;
  }

  const sorted = [...items].sort((left, right) => {
    const tier = (left.tier === "selected" ? 0 : 1) - (right.tier === "selected" ? 0 : 1);
    return (
      tier
      || left.date.localeCompare(right.date)
      || left.sessionId.localeCompare(right.sessionId)
      || left.turnIndex - right.turnIndex
    );
  });
  return {
    queryShape: inferShape(args.question),
    setBoundary: "facts bearing on the question across the frozen candidate-session bag",
    candidateStatus: sorted.length > 0 ? "found" : "none_found",
    missingRisk: args.missingRisk,
    items: sorted,
    characterCount,
    estimatedTokens: Math.ceil(characterCount / 4),
  };
}

function buildDeterministicPackage(
  question: string,
  sessions: TimestampedSession[],
  annotations: Map<string, SessionAnnotation>,
): ContextPackage {
  const refsBySession = new Map<string, Ref[]>();
  for (const session of sessions) {
    refsBySession.set(
      session.session_id,
      makeAnchorRefs(question, session, annotations.get(session.session_id)),
    );
  }
  return buildBalancedPackage({
    question,
    sessions,
    refsBySession,
    missingRisk: "the frozen retriever bag may omit a required session",
  });
}

function buildFullRawPackage(
  question: string,
  sessions: TimestampedSession[],
): ContextPackage {
  const items = sessions
    .flatMap((session) =>
      session.turns.map((turn, turnIndex): ContextPackageItem => ({
        sessionId: session.session_id,
        turnIndex,
        date: session.date,
        role: turn.role,
        text: turn.content,
        why: "raw turn retained from the complete K=81 candidate reservoir",
        tier: "selected",
      })),
    )
    .sort(
      (left, right) =>
        left.date.localeCompare(right.date)
        || left.sessionId.localeCompare(right.sessionId)
        || left.turnIndex - right.turnIndex,
    );
  const characterCount = items.reduce((sum, item) => sum + item.text.length, 0);
  return {
    queryShape: inferShape(question),
    setBoundary: "all raw turns from every session in the frozen candidate reservoir",
    candidateStatus: items.length > 0 ? "found" : "none_found",
    missingRisk: "the frozen candidate reservoir may omit a required session; no downstream session or turn was deleted",
    items,
    characterCount,
    estimatedTokens: Math.ceil(characterCount / 4),
  };
}

function buildExtractedClaimPackage(args: {
  question: string;
  extracted: Array<{
    session: TimestampedSession;
    result: StructuredCall<z.infer<typeof SessionExtractSchema>>;
  }>;
}): ContextPackage {
  const items: ContextPackageItem[] = [];
  const seenFacts = new Set<string>();
  for (const { session, result } of args.extracted) {
    for (const claim of result.value.claims) {
      const source = session.turns[claim.turnIndex];
      if (!source) continue;
      const canonical = claim.fact
        .normalize("NFKC")
        .toLocaleLowerCase("en-US")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
      if (!canonical || seenFacts.has(canonical)) continue;
      seenFacts.add(canonical);
      items.push({
        sessionId: session.session_id,
        turnIndex: claim.turnIndex,
        date: session.date,
        role: source.role,
        text: claim.fact.trim(),
        why: `per-session extractor: ${claim.why}`,
        tier: "selected",
      });
    }
  }
  items.sort(
    (left, right) =>
      left.date.localeCompare(right.date)
      || left.sessionId.localeCompare(right.sessionId)
      || left.turnIndex - right.turnIndex,
  );
  const characterCount = items.reduce((sum, item) => sum + item.text.length, 0);
  return {
    queryShape: inferShape(args.question),
    setBoundary: "all question-bearing claims extracted independently from every session in the frozen candidate reservoir",
    candidateStatus: items.length > 0 ? "found" : "none_found",
    missingRisk: "the frozen candidate reservoir or the independent claim extractors may omit required evidence; no extracted claim was rank-truncated",
    items,
    characterCount,
    estimatedTokens: Math.ceil(characterCount / 4),
  };
}

function formatBagCatalog(
  sessions: TimestampedSession[],
  annotations: Map<string, SessionAnnotation>,
): string {
  if (sessions.length === 0) return "(empty candidate bag)";
  return sessions
    .map((session) => {
      const notes = formatNotesDocumentText(
        session.session_id,
        session.date,
        annotations.get(session.session_id),
      );
      const turns = session.turns
        .map((turn, turnIndex) => {
          const preview =
            turn.content.length <= 900 ? turn.content : `${turn.content.slice(0, 899)}…`;
          return `[${turn.role} sessionId=${session.session_id} turnIndex=${String(turnIndex)}]\n${preview}`;
        })
        .join("\n\n");
      return `### session ${session.session_id} | date ${session.date}\n## NOTES\n${notes}\n## RAW TURNS\n${turns}`;
    })
    .join("\n\n");
}

function repairSelectOutput(args: {
  question: string;
  output: SelectOutput;
  sessions: TimestampedSession[];
  annotations: Map<string, SessionAnnotation>;
}): SelectOutput {
  const byId = new Map(args.sessions.map((session) => [session.session_id, session]));
  const refs: Array<{ sessionId: string; turnIndex: number; why: string }> = [];
  const seen = new Set<string>();
  const add = (sessionId: string, turnIndex: number, why: string): void => {
    if (refs.length >= PACKAGE_MAX_TURNS) return;
    const session = byId.get(sessionId);
    if (!session || !session.turns[turnIndex]) return;
    const key = `${sessionId}:${String(turnIndex)}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ sessionId, turnIndex, why });
  };
  for (const item of args.output.items) {
    const session = byId.get(item.sessionId);
    if (!session || !session.turns[item.turnIndex]) continue;
    for (const turnIndex of adjacentIndexes(session, item.turnIndex)) {
      add(
        item.sessionId,
        turnIndex,
        turnIndex === item.turnIndex ? item.why : "deterministic adjacent-turn repair",
      );
    }
  }

  const inferred = inferShape(args.question);
  const needsBagCoverage =
    args.output.queryShape === "aggregate"
    || args.output.queryShape === "order"
    || inferred === "aggregate"
    || inferred === "order";
  if (needsBagCoverage) {
    for (const session of args.sessions) {
      const anchor = makeAnchorRefs(
        args.question,
        session,
        args.annotations.get(session.session_id),
      )[0];
      if (!anchor) continue;
      for (const turnIndex of adjacentIndexes(session, anchor.turnIndex)) {
        add(
          session.session_id,
          turnIndex,
          turnIndex === anchor.turnIndex
            ? "deterministic candidate-session coverage repair"
            : "deterministic adjacent-turn repair",
        );
      }
    }
  }

  // Empty/invalid selector output falls back to one anchored block per bag session.
  if (refs.length === 0) {
    for (const session of args.sessions) {
      const anchor = makeAnchorRefs(
        args.question,
        session,
        args.annotations.get(session.session_id),
      )[0];
      if (!anchor) continue;
      for (const turnIndex of adjacentIndexes(session, anchor.turnIndex)) {
        add(
          session.session_id,
          turnIndex,
          turnIndex === anchor.turnIndex
            ? "deterministic empty-selector fallback"
            : "deterministic adjacent-turn repair",
        );
      }
    }
  }
  return {
    queryShape: args.output.queryShape,
    setBoundary: args.output.setBoundary,
    candidateStatus: refs.length > 0 ? "found" : "none_found",
    missingRisk:
      refs.length > 0
        ? `${args.output.missingRisk}; frozen bag may omit a required session`
        : args.output.missingRisk,
    items: refs,
  };
}

function formatSingleSession(session: TimestampedSession): string {
  const turns = session.turns
    .map(
      (turn, turnIndex) =>
        `[${turn.role} sessionId=${session.session_id} turnIndex=${String(turnIndex)}]\n${turn.content}`,
    )
    .join("\n\n");
  return `### session ${session.session_id} | date ${session.date}\n${turns}`;
}

function contextTrace(pkg: ContextPackage): Record<string, unknown> {
  return {
    query_shape: pkg.queryShape,
    set_boundary: pkg.setBoundary,
    candidate_status: pkg.candidateStatus,
    missing_risk: pkg.missingRisk,
    item_count: pkg.items.length,
    character_count: pkg.characterCount,
    estimated_tokens: pkg.estimatedTokens,
    items: pkg.items.map((item) => ({
      session_id: item.sessionId,
      turn_index: item.turnIndex,
      date: item.date,
      role: item.role,
      why: item.why,
      tier: item.tier,
    })),
  };
}

function packageSessionCoverage(pkg: ContextPackage, sessions: TimestampedSession[]): number {
  const represented = new Set(pkg.items.map((item) => item.sessionId));
  return sessions.filter((session) => represented.has(session.session_id)).length;
}

async function preparePackage(args: {
  arm: Arm;
  raw: RawCase;
  sessions: TimestampedSession[];
  annotations: Map<string, SessionAnnotation>;
  rawSessionIdsForLeakCheck: string[];
  readerModel: string;
  readerReasoning: ReasoningEffort;
  prompts: PromptLoader;
  openai: OpenAI;
  gate: DispatchGate;
}): Promise<{
  pkg: ContextPackage;
  calls: ModelCall[];
  modelIo: ModelIoRecord[];
  intermediate: unknown;
  warnings: string[];
}> {
  const spans = spansForSessions(args.sessions);
  if (args.arm === "1a") {
    const retrieval = retrievalForSpans(spans);
    const prompt = await renderSelectPrompt(
      {
        question: args.raw.question,
        questionDate: args.raw.question_date,
        retrieval,
        packageMaxTurns: PACKAGE_MAX_TURNS,
        promptName: "select-v4",
      },
      args.prompts,
    );
    const selected = await callStructured({
      openai: args.openai,
      gate: args.gate,
      model: args.readerModel,
      prompt,
      rawSessionIdsForLeakCheck: args.rawSessionIdsForLeakCheck,
      schema: SelectOutputSchema,
      schemaName: "select_v1",
      role: "select",
      reasoning: args.readerReasoning,
      maxOutputTokens: 8000,
      outputReservation: 3000,
      sequence: 1,
    });
    const built = buildContextPackage({
      selectOutput: selected.value,
      sessions: args.sessions,
      spans,
      packageMaxTurns: PACKAGE_MAX_TURNS,
      packageCharBudget: PACKAGE_CHAR_BUDGET,
      packageSupportingEnabled: true,
      question: args.raw.question,
      siblingSessionsEnabled: true,
      siblingSessionMax: 12,
      fullSessionEnabled: true,
      sessionTurnMax: 24,
      lexicalFloorEnabled: false,
    });
    return {
      pkg: built.package,
      calls: [selected.call],
      modelIo: [selected.io],
      intermediate: selected.value,
      warnings: built.warnings,
    };
  }

  if (args.arm === "1b") {
    const prompt = await args.prompts.render("hop-bag-select-v1", {
      question: args.raw.question,
      question_date: args.raw.question_date,
      bag_catalog: formatBagCatalog(args.sessions, args.annotations),
      package_max_turns: String(PACKAGE_MAX_TURNS),
    });
    const selected = await callStructured({
      openai: args.openai,
      gate: args.gate,
      model: args.readerModel,
      prompt,
      rawSessionIdsForLeakCheck: args.rawSessionIdsForLeakCheck,
      schema: SelectOutputSchema,
      schemaName: "select_v1",
      role: "select",
      reasoning: args.readerReasoning,
      maxOutputTokens: 8000,
      outputReservation: 3000,
      sequence: 1,
    });
    const repaired = repairSelectOutput({
      question: args.raw.question,
      output: selected.value,
      sessions: args.sessions,
      annotations: args.annotations,
    });
    const built = buildContextPackage({
      selectOutput: repaired,
      sessions: args.sessions,
      spans,
      packageMaxTurns: PACKAGE_MAX_TURNS,
      packageCharBudget: PACKAGE_CHAR_BUDGET,
      packageSupportingEnabled: true,
      question: args.raw.question,
      siblingSessionsEnabled: true,
      siblingSessionMax: 12,
      fullSessionEnabled: true,
      sessionTurnMax: 24,
      lexicalFloorEnabled: false,
    });
    return {
      pkg: built.package,
      calls: [selected.call],
      modelIo: [selected.io],
      intermediate: { raw: selected.value, repaired },
      warnings: built.warnings,
    };
  }

  if (args.arm === "2") {
    return {
      pkg: buildDeterministicPackage(args.raw.question, args.sessions, args.annotations),
      calls: [],
      modelIo: [],
      intermediate: { method: "deterministic-balanced-raw-turn-package" },
      warnings: [],
    };
  }

  if (args.arm === "4") {
    return {
      pkg: buildFullRawPackage(args.raw.question, args.sessions),
      calls: [],
      modelIo: [],
      intermediate: { method: "complete-candidate-reservoir-raw-turn-package" },
      warnings: [],
    };
  }

  const extracted = await Promise.all(
    args.sessions.map(async (session, index) => {
      const prompt = await args.prompts.render("hop-session-extract-v1", {
        question: args.raw.question,
        question_date: args.raw.question_date,
        session_memory: formatSingleSession(session),
      });
      const result = await callStructured({
        openai: args.openai,
        gate: args.gate,
        model: args.readerModel,
        prompt,
        rawSessionIdsForLeakCheck: args.rawSessionIdsForLeakCheck,
        schema: SessionExtractSchema,
        schemaName: "hop_session_extract_v1",
        role: "session_extract",
        reasoning: args.readerReasoning,
        maxOutputTokens: 8000,
        outputReservation: args.arm === "5" ? 1000 : 3000,
        sequence: index + 1,
      });
      return { session, result };
    }),
  );
  if (args.arm === "5") {
    return {
      pkg: buildExtractedClaimPackage({ question: args.raw.question, extracted }),
      calls: extracted.map(({ result }) => result.call),
      modelIo: extracted.map(({ result }) => result.io),
      intermediate: extracted.map(({ session, result }) => ({
        session_id: session.session_id,
        output: result.value,
      })),
      warnings: [],
    };
  }
  const broadHistory = isBroadHistoryQuestion(args.raw.question);
  const packageSessions = broadHistory
    ? extracted
      .filter(({ result }) => retainMappedSession({
        question: args.raw.question,
        candidateStatus: result.value.candidateStatus,
        claimCount: result.value.claims.length,
      }))
      .map(({ session }) => session)
    : args.sessions;
  const refsBySession = new Map<string, Ref[]>();
  for (const { session, result } of extracted) {
    const refs: Ref[] = [];
    const seen = new Set<number>();
    for (const claim of result.value.claims) {
      if (!session.turns[claim.turnIndex] || seen.has(claim.turnIndex)) continue;
      seen.add(claim.turnIndex);
      refs.push({
        turnIndex: claim.turnIndex,
        why: `per-session extractor: ${claim.why || claim.fact}`,
      });
    }
    if (refs.length === 0 && !broadHistory) {
      const fallback = makeAnchorRefs(
        args.raw.question,
        session,
        args.annotations.get(session.session_id),
      )[0];
      if (fallback) refs.push({ ...fallback, why: "empty-extractor deterministic fallback" });
    }
    refsBySession.set(session.session_id, refs);
  }
  const pkg = buildBalancedPackage({
    question: args.raw.question,
    sessions: packageSessions,
    refsBySession,
    missingRisk: broadHistory
      ? "broad-history lexical candidates were filtered independently; diffuse or implicit events may still be missing"
      : "each session was mapped independently; the frozen bag may omit required sessions",
  });
  return {
    pkg,
    calls: extracted.map(({ result }) => result.call),
    modelIo: extracted.map(({ result }) => result.io),
    intermediate: extracted.map(({ session, result }) => ({
      session_id: session.session_id,
      output: result.value,
    })),
    warnings: [],
  };
}

function pricingForModel(model: string): {
  input: number | null;
  output: number | null;
} {
  if (model.startsWith("gpt-5.6-luna")) return { input: 1, output: 6 };
  if (model.startsWith("gpt-5.4-nano")) return { input: 0.2, output: 1.25 };
  return { input: null, output: null };
}

function configForArm(args: {
  runId: string;
  arm: Arm;
  concurrency: number;
  tokenBudget: number;
  opaqueSessionIds: boolean;
  captureModelIo: boolean;
  readerModel: string;
  readerReasoning: ReasoningEffort;
  answerModel: string;
  answerReasoning: ReasoningEffort;
  benchmark: string;
}): unknown {
  const models: Record<string, unknown> = {};
  const readerPricing = pricingForModel(args.readerModel);
  const answerPricing = pricingForModel(args.answerModel);
  if (args.arm === "1a" || args.arm === "1b") {
    models.select = {
      kind: "generation",
      provider: "openai",
      model: args.readerModel,
      temperature: 1,
      reasoning_effort: args.readerReasoning,
      max_output_tokens: 8000,
      timeout_seconds: 300,
      concurrency: args.concurrency,
      max_retries: 6,
      input_price_per_million: readerPricing.input,
      output_price_per_million: readerPricing.output,
    };
  }
  if (args.arm === "3" || args.arm === "5") {
    models.session_extract = {
      kind: "generation",
      provider: "openai",
      model: args.readerModel,
      temperature: 1,
      reasoning_effort: args.readerReasoning,
      max_output_tokens: 8000,
      timeout_seconds: 300,
      concurrency: args.concurrency,
      max_retries: 6,
      input_price_per_million: readerPricing.input,
      output_price_per_million: readerPricing.output,
    };
  }
  const providerModels = [...new Set([args.readerModel, args.answerModel])];
  return {
    name: args.runId,
    mode: "full-context",
    agent: {
      backend: "node",
      entrypoint: "src/agents/current/dist/host.js",
      provider_model_limits: providerModels.map((model) => ({
          provider: "openai",
          model,
          max_concurrency: args.concurrency,
          token_budget: args.tokenBudget,
          window_seconds: 60,
      })),
      models,
      options: {
        frozen_hop_bag: true,
        session_id_visibility: args.opaqueSessionIds
          ? "opaque_per_case_v1"
          : "raw_legacy",
        downstream_arm: args.arm,
        answer_prompt: ANSWER_PROMPT,
        package_max_turns: PACKAGE_MAX_TURNS,
        package_char_budget: PACKAGE_CHAR_BUDGET,
      },
    },
    answer: {
      provider: "openai",
      model: args.answerModel,
      temperature: 1,
      reasoning_effort: args.answerReasoning,
      max_output_tokens: 16000,
      timeout_seconds: 300,
      concurrency: args.concurrency,
      max_retries: 6,
      input_price_per_million: answerPricing.input,
      output_price_per_million: answerPricing.output,
    },
    judge: {
      provider: "openai",
      model: args.benchmark === "BEAM-1M" ? "gpt-4.1-mini" : "gpt-4o-2024-08-06",
      temperature: 0,
    },
    selection: { strategy: "question-ids" },
    execution: {
      case_concurrency: args.concurrency,
      capture_model_io: args.captureModelIo,
      auto_export_final_svg: false,
    },
  };
}

function yamlForRun(args: {
  runId: string;
  arm: Arm;
  hopRun: string;
  concurrency: number;
  tokenBudget: number;
  opaqueSessionIds: boolean;
  captureModelIo: boolean;
  readerModel: string;
  readerReasoning: ReasoningEffort;
  answerModel: string;
  answerReasoning: ReasoningEffort;
  benchmark: string;
}): string {
  return [
    `name: ${args.runId}`,
    "mode: full-context",
    ...(args.benchmark === "LongMemEval" ? [] : [`benchmark: ${args.benchmark}`]),
    "experiment:",
    `  downstream_arm: ${args.arm}`,
    `  frozen_hop_run: ${args.hopRun}`,
    `  answer_prompt: ${ANSWER_PROMPT}`,
    `  reader_model: ${args.readerModel}`,
    `  reader_reasoning: ${args.readerReasoning}`,
    `  answer_model: ${args.answerModel}`,
    `  answer_reasoning: ${args.answerReasoning}`,
    `  request_concurrency: ${String(args.concurrency)}`,
    `  token_budget_per_minute: ${String(args.tokenBudget)}`,
    `  session_id_visibility: ${
      args.opaqueSessionIds ? "opaque_per_case_v1" : "raw_legacy"
    }`,
    `  capture_model_io: ${String(args.captureModelIo)}`,
    `  package_max_turns: ${String(PACKAGE_MAX_TURNS)}`,
    `  package_char_budget: ${String(PACKAGE_CHAR_BUDGET)}`,
    "",
  ].join("\n");
}

function gitState(): { commit: string; dirty: boolean } {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
  }).trim();
  const dirty =
    execFileSync("git", ["status", "--porcelain"], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
    }).trim().length > 0;
  return { commit, dirty };
}

function datasetHashes(paths: string[]): Record<string, string> {
  return Object.fromEntries(
    paths.map((path) => {
      const absolute = resolve(path);
      const fileName = path.slice(path.lastIndexOf("/") + 1);
      return [fileName, sha256(readFileSync(absolute))];
    }),
  );
}

async function main(): Promise<void> {
  loadDotEnv(resolve(PROJECT_ROOT, ".env"));
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");
  const args = parseArgs(process.argv.slice(2));
  const hopRunPath = resolve(PROJECT_ROOT, args["hop-run"] ?? DEFAULT_HOP_RUN);
  const datasetPath = resolve(PROJECT_ROOT, args.dataset ?? DEFAULT_DATASET);
  const oraclePath = resolve(PROJECT_ROOT, args.oracle ?? DEFAULT_ORACLE);
  const annotationsPath = resolve(PROJECT_ROOT, args.annotations ?? DEFAULT_ANNOTATIONS);
  const runsDir = resolve(PROJECT_ROOT, args["runs-dir"] ?? "runs");
  const benchmark = args.benchmark ?? "LongMemEval";
  const outPrefix = args["out-prefix"] ?? "hop-bag-downstream-answerable135-v1";
  assertSlug(outPrefix, "out-prefix");
  const concurrency = Number(args.concurrency ?? "128");
  const tokenBudget = Number(args["token-budget"] ?? "2000000");
  const opaqueSessionIds = args["opaque-session-ids"] !== "false";
  const captureModelIo = args["capture-model-io"] === "true";
  const readerModel = args["reader-model"] ?? DEFAULT_MODEL;
  const readerReasoning = (args["reader-reasoning"] ?? "low") as ReasoningEffort;
  const answerModel = args["answer-model"] ?? DEFAULT_MODEL;
  const answerReasoning = (args["answer-reasoning"] ?? "medium") as ReasoningEffort;
  const limit = args.limit ? Number(args.limit) : null;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 256) {
    throw new Error("--concurrency must be an integer in 1..256");
  }
  if (!Number.isFinite(tokenBudget) || tokenBudget < 1) {
    throw new Error("--token-budget must be positive");
  }
  const allowedReasoning = new Set<ReasoningEffort>(["low", "medium", "high"]);
  if (!allowedReasoning.has(readerReasoning)) {
    throw new Error("--reader-reasoning must be low, medium, or high");
  }
  if (!allowedReasoning.has(answerReasoning)) {
    throw new Error("--answer-reasoning must be low, medium, or high");
  }
  const requestedArms = (args.arms ?? ALL_ARMS.join(","))
    .split(",")
    .map((arm) => arm.trim())
    .filter((arm): arm is Arm => ALL_ARMS.includes(arm as Arm));
  if (requestedArms.length === 0) {
    throw new Error(`--arms must include one of ${ALL_ARMS.join(",")}`);
  }
  if (new Set(requestedArms).size !== requestedArms.length) {
    throw new Error("--arms contains duplicates");
  }

  const hopRun = JSON.parse(readFileSync(hopRunPath, "utf8")) as FrozenHopRun;
  const rawCases = loadArchitectureCases(datasetPath);
  const rawById = new Map(rawCases.map((raw) => [raw.question_id, raw]));
  const selectedHopCases = limit === null ? hopRun.cases : hopRun.cases.slice(0, limit);
  if (selectedHopCases.length === 0) throw new Error("no frozen hop cases selected");
  const questionIds = selectedHopCases.map((item) => item.question_id);
  if (new Set(questionIds).size !== questionIds.length) {
    throw new Error("frozen hop run contains duplicate question IDs");
  }
  for (const questionId of questionIds) {
    if (!rawById.has(questionId)) throw new Error(`dataset is missing ${questionId}`);
  }
  const annotations = loadAnnotations(annotationsPath);
  const prompts = new PromptLoader();
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
  const gate = new DispatchGate(tokenBudget, 60, concurrency);
  const createdAt = new Date().toISOString();
  const repoGit = gitState();
  const hashes = datasetHashes([datasetPath, oraclePath]);
  const hopRunRel = hopRunPath.startsWith(`${PROJECT_ROOT}/`)
    ? hopRunPath.slice(PROJECT_ROOT.length + 1)
    : hopRunPath;

  type ArmState = {
    runId: string;
    root: string;
    completed: number;
    failed: number;
    manifest: Record<string, unknown>;
  };
  const states = new Map<Arm, ArmState>();
  for (const arm of requestedArms) {
    const runId = `${outPrefix}-${arm}`;
    const root = resolve(runsDir, runId);
    if (existsSync(root)) {
      throw new Error(`output run already exists: ${runId}`);
    }
    mkdirSync(resolve(root, "agent-artifacts/cases"), { recursive: true });
    writeFileSync(resolve(root, "predictions.jsonl"), "");
    writeFileSync(resolve(root, "errors.jsonl"), "");
    writeFileSync(
      resolve(root, "config.yaml"),
      yamlForRun({
        runId,
        arm,
        hopRun: hopRunRel,
        concurrency,
        tokenBudget,
        opaqueSessionIds,
        captureModelIo,
        readerModel,
        readerReasoning,
        answerModel,
        answerReasoning,
        benchmark,
      }),
    );
    const config = configForArm({
      runId,
      arm,
      concurrency,
      tokenBudget,
      opaqueSessionIds,
      captureModelIo,
      readerModel,
      readerReasoning,
      answerModel,
      answerReasoning,
      benchmark,
    });
    const manifest: Record<string, unknown> = {
      schema_version: 2,
      run_id: runId,
      status: "running",
      created_at: createdAt,
      updated_at: createdAt,
      config_source: `runs/${runId}/config.yaml`,
      config,
      config_fingerprint: sha256(JSON.stringify(config)),
      git: repoGit,
      dataset_hashes: hashes,
      benchmark,
      dataset_path: datasetPath,
      oracle_path: oraclePath,
      annotations_path: annotationsPath,
      dataset_mode: "full-context",
      selected_question_ids: questionIds,
      selected_count: questionIds.length,
      selection: {
        strategy: "question-ids",
        population_count: rawCases.length,
        sample_count: questionIds.length,
        is_canary: false,
      },
      completed_count: 0,
      failure_count: 0,
      experiment: {
        frozen_hop_run: hopRunRel,
        frozen_hop_model: hopRun.model,
        frozen_hop_reasoning: hopRun.reasoning,
        frozen_hop_prompt: hopRun.prompt,
        frozen_hop_budget: hopRun.hop_budget,
        session_id_visibility: opaqueSessionIds
          ? "opaque_per_case_v1"
          : "raw_legacy",
        capture_model_io: captureModelIo,
        reader_model: readerModel,
        reader_reasoning: readerReasoning,
        answer_model: answerModel,
        answer_reasoning: answerReasoning,
        downstream_arm: arm,
        benchmark,
      },
    };
    writeFileSync(resolve(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    states.set(arm, { runId, root, completed: 0, failed: 0, manifest });
  }

  const tasks: Array<{ arm: Arm; hopCase: FrozenHopCase; caseIndex: number }> = [];
  for (let caseIndex = 0; caseIndex < selectedHopCases.length; caseIndex += 1) {
    const hopCase = selectedHopCases[caseIndex];
    if (!hopCase) continue;
    const rotated = requestedArms.map(
      (_arm, offset) => requestedArms[(caseIndex + offset) % requestedArms.length],
    ).filter((arm): arm is Arm => arm !== undefined);
    for (const arm of rotated) {
      tasks.push({ arm, hopCase, caseIndex });
    }
  }

  const started = Date.now();
  let globalDone = 0;
  console.log(
    JSON.stringify({
      event: "start",
      cases: selectedHopCases.length,
      arms: requestedArms,
      tasks: tasks.length,
      concurrency,
      token_budget: tokenBudget,
      session_id_visibility: opaqueSessionIds
        ? "opaque_per_case_v1"
        : "raw_legacy",
      capture_model_io: captureModelIo,
      reader_model: readerModel,
      reader_reasoning: readerReasoning,
      answer_model: answerModel,
      answer_reasoning: answerReasoning,
      hop_run: hopRunRel,
      out_prefix: outPrefix,
    }),
  );

  await mapPool(tasks, concurrency, async ({ arm, hopCase }) => {
    const state = states.get(arm);
    if (!state) throw new Error(`missing state for arm ${arm}`);
    const raw = rawById.get(hopCase.question_id);
    if (!raw) throw new Error(`dataset is missing ${hopCase.question_id}`);
    const hydrated = hydrateBag(raw, hopCase.bag);
    let modelSessions = hydrated.sessions;
    let modelAnnotations = annotations;
    const rawSessionIdsForLeakCheck = opaqueSessionIds
      ? [...new Set(raw.haystack_session_ids)]
      : [];
    if (opaqueSessionIds) {
      const datesBySessionId = new Map<string, string>();
      for (let index = 0; index < raw.haystack_session_ids.length; index += 1) {
        const sessionId = raw.haystack_session_ids[index];
        if (sessionId) {
          datesBySessionId.set(sessionId, raw.haystack_dates[index] ?? "");
        }
      }
      const opaqueSpace = buildOpaqueSessionSpace({
        namespace: raw.question_id,
        sessionIds: raw.haystack_session_ids,
        datesBySessionId,
        annotations,
      });
      modelSessions = hydrated.sessions.flatMap((session) => {
        const opaqueId = opaqueSpace.realToOpaque.get(session.session_id);
        return opaqueId ? [{ ...session, session_id: opaqueId }] : [];
      });
      modelAnnotations = opaqueSpace.annotations;
    }
    const caseDir = resolve(state.root, "agent-artifacts/cases", raw.question_id);
    mkdirSync(caseDir, { recursive: true });
    try {
      const prepared = await preparePackage({
        arm,
        raw,
        sessions: modelSessions,
        annotations: modelAnnotations,
        rawSessionIdsForLeakCheck,
        readerModel,
        readerReasoning,
        prompts,
        openai,
        gate,
      });
      const answerPrompt = await renderAnswerPrompt(
        {
          question: raw.question,
          questionDate: raw.question_date,
          retrieval: retrievalForSpans(spansForSessions(modelSessions)),
          contextPackage: prepared.pkg,
          promptName: ANSWER_PROMPT,
        },
        prompts,
      );
      const answer = await callStructured({
        openai,
        gate,
        model: answerModel,
        prompt: answerPrompt,
        rawSessionIdsForLeakCheck,
        schema: AnswerOutputSchema,
        schemaName: "answer_v1",
        role: "answer",
        reasoning: answerReasoning,
        maxOutputTokens: 16_000,
        outputReservation: 7000,
        sequence: prepared.calls.length + 1,
      });
      const validRefs = new Set(
        prepared.pkg.items.map((item) => `${item.sessionId}:${String(item.turnIndex)}`),
      );
      const evidence = answer.value.evidence
        .filter(
          (item) =>
            item.turnIndex === null
            || validRefs.has(`${item.sessionId}:${String(item.turnIndex)}`),
        )
        .map((item) => ({
          session_id: item.sessionId,
          turn_index: item.turnIndex,
        }));
      const invalidEvidenceCount = answer.value.evidence.length - evidence.length;
      const hypothesis =
        answer.value.supportStatus === "insufficient" && !answer.value.hypothesis.trim()
          ? UNAVAILABLE_MEMORY_HYPOTHESIS
          : answer.value.hypothesis;
      const modelCalls = [...prepared.calls, answer.call].sort(
        (left, right) => left.sequence - right.sequence,
      );
      const prediction = {
        question_id: raw.question_id,
        question_type: raw.question_type,
        hypothesis,
        evidence,
        trace: {
          architecture_id: `hop-bag-downstream-${arm}`,
          downstream_arm: arm,
          frozen_hop_bag: [...new Set(hopCase.bag)],
          frozen_hop_bag_size: new Set(hopCase.bag).size,
          hydrated_bag_size: modelSessions.length,
          missing_bag_session_ids: hydrated.missingSessionIds,
          session_id_visibility: opaqueSessionIds
            ? "opaque_per_case_v1"
            : "raw_legacy",
          package_session_coverage: packageSessionCoverage(prepared.pkg, modelSessions),
          package_warnings: prepared.warnings,
          invalid_answer_evidence_count: invalidEvidenceCount,
          support_status: answer.value.supportStatus,
          answer_call_count: 1,
          select_call_count: arm === "1a" || arm === "1b" ? 1 : 0,
          extract_call_count: arm === "3" || arm === "5" ? prepared.calls.length : 0,
          context_package: contextTrace(prepared.pkg),
        },
        generation: answer.generation,
        model_calls: modelCalls,
      };
      writeFileSync(
        resolve(caseDir, "context-package.json"),
        `${JSON.stringify(prepared.pkg, null, 2)}\n`,
      );
      writeFileSync(
        resolve(caseDir, "intermediate.json"),
        `${JSON.stringify(prepared.intermediate, null, 2)}\n`,
      );
      if (captureModelIo) {
        writeFileSync(
          resolve(caseDir, "model-io.json"),
          `${JSON.stringify([...prepared.modelIo, answer.io], null, 2)}\n`,
        );
      }
      appendFileSync(resolve(state.root, "predictions.jsonl"), `${JSON.stringify(prediction)}\n`);
      state.completed += 1;
    } catch (error) {
      state.failed += 1;
      appendFileSync(
        resolve(state.root, "errors.jsonl"),
        `${JSON.stringify({
          question_id: raw.question_id,
          error_type: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        })}\n`,
      );
      console.error(
        JSON.stringify({
          event: "case_failed",
          arm,
          question_id: raw.question_id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    globalDone += 1;
    const now = new Date().toISOString();
    state.manifest.updated_at = now;
    state.manifest.completed_count = state.completed;
    state.manifest.failure_count = state.failed;
    writeFileSync(
      resolve(state.root, "manifest.json"),
      `${JSON.stringify(state.manifest, null, 2)}\n`,
    );
    if (globalDone % 20 === 0 || globalDone === tasks.length) {
      const elapsedSeconds = (Date.now() - started) / 1000;
      console.log(
        JSON.stringify({
          event: "progress",
          done: globalDone,
          total: tasks.length,
          elapsed_s: Math.round(elapsedSeconds),
          rate_per_min: Number(((globalDone / elapsedSeconds) * 60).toFixed(1)),
          by_arm: Object.fromEntries(
            [...states.entries()].map(([name, current]) => [
              name,
              { completed: current.completed, failed: current.failed },
            ]),
          ),
        }),
      );
    }
  });

  const completedAt = new Date().toISOString();
  for (const state of states.values()) {
    const complete = state.completed === questionIds.length && state.failed === 0;
    state.manifest.status = complete ? "completed" : "partial";
    state.manifest.updated_at = completedAt;
    state.manifest.completed_at = complete ? completedAt : null;
    state.manifest.completed_count = state.completed;
    state.manifest.failure_count = state.failed;
    writeFileSync(
      resolve(state.root, "manifest.json"),
      `${JSON.stringify(state.manifest, null, 2)}\n`,
    );
  }
  console.log(
    JSON.stringify({
      event: "done",
      elapsed_s: Math.round((Date.now() - started) / 1000),
      runs: Object.fromEntries(
        [...states.entries()].map(([arm, state]) => [
          arm,
          {
            run_id: state.runId,
            completed: state.completed,
            failed: state.failed,
            status: state.completed === questionIds.length && state.failed === 0
              ? "completed"
              : "partial",
          },
        ]),
      ),
    }),
  );
  if ([...states.values()].some((state) => state.failed > 0)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
