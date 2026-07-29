/**
 * Offline hop-retrieve gate over session-annotate-v1 notes.
 *
 * Bounded LLM loop (bm25_notes / grep_notes / add_sessions / done) on the frozen
 * hop27 slice. Compares against phase-1 window BM25 and notes-only BM25 baselines.
 *
 * Usage:
 *   pnpm --dir src/agents/current exec node --import tsx \
 *     src/scripts/hopRetrieveGate.ts \
 *     --ids runs/local-archive/backbone/hop27-ids.json \
 *     --annotations runs/local-archive/backbone/session-annotations-v1 \
 *     --hops 3 --model gpt-5.4-nano-2026-03-17 --reasoning medium \
 *     --concurrency 8 --out runs/local-archive/backbone/hop-gate-nano-h3.json
 *
 * Baselines only (no LLM):
 *   ... hopRetrieveGate.ts --baselines-only --out .../hop-gate-baselines.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import OpenAI from "openai";
import type {
  FunctionTool,
  Response as OpenAIResponse,
} from "openai/resources/responses/responses";

import {
  buildNotesBm25Index,
  grepNotes,
  loadAnnotations,
  searchNotesBm25,
  type NotesHit,
  type SessionAnnotation,
} from "../retrieval/notesIndex.js";
import { PromptLoader } from "../services/promptLoader.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const DEFAULT_IDS = resolve(PROJECT_ROOT, "runs/local-archive/backbone/hop27-ids.json");
const DEFAULT_ANNOTATIONS = resolve(
  PROJECT_ROOT,
  "runs/local-archive/backbone/session-annotations-v1",
);
const DEFAULT_DATASET = resolve(PROJECT_ROOT, "data/raw/longmemeval_s_cleaned.json");
const DEFAULT_ORACLE = resolve(PROJECT_ROOT, "data/raw/longmemeval_oracle.json");
const DEFAULT_PHASE1 = resolve(
  PROJECT_ROOT,
  "runs/local-archive/backbone/rank-gate-answerable-phase1-none.json",
);
const TOKEN_BUDGET = 200_000;
const WINDOW_SECONDS = 60;
const OUTPUT_CEILING = 2_500;
const BAG_MAX = 12;
const ALLOWED_TOP_K = new Set([5, 10, 20]);

type RawCase = {
  question_id: string;
  question_type: string;
  question: string;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
};

type Hop27Case = {
  question_id: string;
  stratum: "hard" | "mid" | "easy";
  question_type: string;
  phase1_worst_rank: number | null;
  phase1_gold_ranks: number[];
};

type Hop27Ids = {
  name: string;
  question_ids: string[];
  cases: Hop27Case[];
};

type Phase1Case = {
  question_id: string;
  worst_rank: number | null;
  gold_ranks: number[];
};

type HopTraceStep = {
  hop: number;
  tool: string;
  args: Record<string, unknown>;
  result_summary: string;
  hits?: NotesHit[];
  added?: string[];
};

type CaseResult = {
  question_id: string;
  stratum: string;
  question_type: string;
  gold: string[];
  bag: string[];
  hops_used: number;
  turns: number;
  done_reason: string | null;
  full_gold_in_bag: boolean;
  gold_recall: number;
  gold_in_bag_count: number;
  phase1_worst_rank: number | null;
  phase1_in_top5: boolean;
  phase1_in_top12: boolean;
  notes_bm25_top5: string[];
  notes_bm25_top12: string[];
  notes_bm25_full_gold_top5: boolean;
  notes_bm25_full_gold_top12: boolean;
  input_tokens: number;
  output_tokens: number;
  error?: string | undefined;
  steps: HopTraceStep[];
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
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = "true";
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function estimateInputTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

class TokenBudgetGate {
  readonly #budget: number;
  readonly #windowMs: number;
  #reservations: Array<{ at: number; tokens: number }> = [];
  #active = 0;
  readonly #maxConcurrency: number;
  readonly #queue: Array<() => void> = [];

  constructor(budget: number, windowSeconds: number, maxConcurrency: number) {
    this.#budget = budget;
    this.#windowMs = windowSeconds * 1000;
    this.#maxConcurrency = maxConcurrency;
  }

  async acquire(tokens: number): Promise<() => void> {
    for (;;) {
      this.#prune();
      const reserved = this.#reservations.reduce((sum, item) => sum + item.tokens, 0);
      if (this.#active < this.#maxConcurrency && reserved + tokens <= this.#budget) {
        this.#reservations.push({ at: Date.now(), tokens });
        this.#active += 1;
        return () => {
          this.#active -= 1;
          this.#pump();
        };
      }
      await new Promise<void>((resolveWait) => {
        this.#queue.push(resolveWait);
        setTimeout(resolveWait, 250);
      });
    }
  }

  #prune(): void {
    const cutoff = Date.now() - this.#windowMs;
    this.#reservations = this.#reservations.filter((item) => item.at >= cutoff);
  }

  #pump(): void {
    const waiter = this.#queue.shift();
    if (waiter) waiter();
  }
}

const TOOLS: FunctionTool[] = [
  {
    type: "function",
    name: "bm25_notes",
    description: "Lexical BM25 search over session annotation notes.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string" },
        top_k: { type: "integer", enum: [5, 10, 20] },
      },
      required: ["query", "top_k"],
    },
  },
  {
    type: "function",
    name: "grep_notes",
    description: "Exact/substring match of 1–5 literal patterns over notes.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        patterns: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 5,
        },
      },
      required: ["patterns"],
    },
  },
  {
    type: "function",
    name: "add_sessions",
    description: "Add session IDs from the LAST tool results into the bag.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        session_ids: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["session_ids"],
    },
  },
  {
    type: "function",
    name: "done",
    description: "Stop early when the bag is sufficient.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        reason: { type: "string" },
      },
      required: ["reason"],
    },
  },
];

function formatHits(hits: NotesHit[]): string {
  if (hits.length === 0) return "(no hits)";
  return hits
    .map(
      (hit) =>
        `${String(hit.rank)}. ${hit.sessionId} score=${hit.score.toFixed(3)} `
        + `terms=[${hit.matchedTerms.join(", ")}] :: ${hit.snippet}`,
    )
    .join("\n");
}

function fullGoldIn(bag: Iterable<string>, gold: string[]): boolean {
  const set = new Set(bag);
  return gold.length > 0 && gold.every((id) => set.has(id));
}

function goldRecall(bag: Iterable<string>, gold: string[]): number {
  if (gold.length === 0) return 0;
  const set = new Set(bag);
  return gold.filter((id) => set.has(id)).length / gold.length;
}

function phase1InTopK(goldRanks: number[], k: number): boolean {
  if (goldRanks.length === 0) return false;
  return goldRanks.every((rank) => rank >= 1 && rank <= k);
}

function summarizeStratum(cases: CaseResult[]): Record<string, unknown> {
  const by: Record<string, CaseResult[]> = { hard: [], mid: [], easy: [], all: cases };
  for (const item of cases) {
    (by[item.stratum] ??= []).push(item);
  }
  const out: Record<string, unknown> = {};
  for (const [name, list] of Object.entries(by)) {
    if (list.length === 0) continue;
    const n = list.length;
    out[name] = {
      n,
      full_gold_in_bag: list.filter((c) => c.full_gold_in_bag).length,
      full_gold_in_bag_rate: list.filter((c) => c.full_gold_in_bag).length / n,
      mean_gold_recall: list.reduce((s, c) => s + c.gold_recall, 0) / n,
      mean_hops: list.reduce((s, c) => s + c.hops_used, 0) / n,
      mean_bag_size: list.reduce((s, c) => s + c.bag.length, 0) / n,
      phase1_top5: list.filter((c) => c.phase1_in_top5).length,
      phase1_top12: list.filter((c) => c.phase1_in_top12).length,
      notes_bm25_top5: list.filter((c) => c.notes_bm25_full_gold_top5).length,
      notes_bm25_top12: list.filter((c) => c.notes_bm25_full_gold_top12).length,
      errors: list.filter((c) => c.error).length,
    };
  }
  return out;
}

function resolveQuestionIds(
  hop27: Hop27Ids,
  args: Record<string, string>,
): Hop27Case[] {
  let cases = hop27.cases;
  if (args.stratum) {
    const wanted = new Set(args.stratum.split(",").map((s) => s.trim()));
    cases = cases.filter((c) => wanted.has(c.stratum));
  }
  if (args.limit) {
    cases = cases.slice(0, Number(args.limit));
  }
  if (args.ids_filter) {
    const wanted = new Set(args.ids_filter.split(",").map((s) => s.trim()));
    cases = cases.filter((c) => wanted.has(c.question_id));
  }
  return cases;
}

async function runHopAgent(args: {
  openai: OpenAI;
  prompts: PromptLoader;
  gate: TokenBudgetGate;
  model: string;
  reasoning: "none" | "low" | "medium" | "high";
  hopBudget: number;
  promptName: string;
  question: string;
  questionDate: string;
  sessionIds: string[];
  datesBySessionId: Map<string, string>;
  annotations: Map<string, SessionAnnotation>;
}): Promise<{
  bag: string[];
  hopsUsed: number;
  turns: number;
  doneReason: string | null;
  steps: HopTraceStep[];
  inputTokens: number;
  outputTokens: number;
}> {
  const index = buildNotesBm25Index({
    sessionIds: args.sessionIds,
    datesBySessionId: args.datesBySessionId,
    annotations: args.annotations,
  });
  const bag: string[] = [];
  const bagSet = new Set<string>();
  let lastHits: NotesHit[] = [];
  let lastToolResults = "(none — first hop)";
  let hopsUsed = 0;
  let turns = 0;
  let doneReason: string | null = null;
  let rejectedOverBudgetSearches = 0;
  const steps: HopTraceStep[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  const maxTurns = args.hopBudget * 3 + 4;

  while (turns < maxTurns && !doneReason) {
    turns += 1;
    const prompt = await args.prompts.render(args.promptName, {
      question: args.question,
      question_date: args.questionDate,
      hop_budget: String(args.hopBudget),
      bag_max: String(BAG_MAX),
      bag_sessions: bag.length === 0 ? "(empty)" : bag.join("\n"),
      hop_number: String(hopsUsed + 1),
      last_tool_results: lastToolResults,
    });
    const inputText = prompt.messages.map((m) => m.content).join("\n");
    const release = await args.gate.acquire(estimateInputTokens(inputText) + OUTPUT_CEILING);
    let response: OpenAIResponse;
    try {
      response = await args.openai.responses.create({
        model: args.model,
        input: prompt.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        tools: TOOLS,
        tool_choice: "required",
        parallel_tool_calls: false,
        ...(args.reasoning !== "none" ? { reasoning: { effort: args.reasoning } } : {}),
      });
    } finally {
      release();
    }

    inputTokens += response.usage?.input_tokens ?? 0;
    outputTokens += response.usage?.output_tokens ?? 0;

    const toolCall = response.output.find(
      (item): item is Extract<(typeof response.output)[number], { type: "function_call" }> =>
        item.type === "function_call",
    );
    if (!toolCall) {
      doneReason = "no_tool_call";
      break;
    }

    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = JSON.parse(toolCall.arguments || "{}") as Record<string, unknown>;
    } catch {
      steps.push({
        hop: hopsUsed,
        tool: toolCall.name,
        args: { raw: toolCall.arguments },
        result_summary: "invalid JSON args",
      });
      lastToolResults = "error: invalid JSON arguments; call a tool again";
      continue;
    }

    const name = toolCall.name;

    if (name === "bm25_notes" || name === "grep_notes") {
      if (hopsUsed >= args.hopBudget) {
        rejectedOverBudgetSearches += 1;
        lastToolResults =
          "error: hop budget exhausted; call add_sessions on last hits or done";
        steps.push({
          hop: hopsUsed,
          tool: name,
          args: parsedArgs,
          result_summary: lastToolResults,
        });
        if (rejectedOverBudgetSearches >= 2) {
          doneReason = "hop_budget_exhausted";
          break;
        }
        continue;
      }
      hopsUsed += 1;
      let hits: NotesHit[] = [];
      if (name === "bm25_notes") {
        const query = String(parsedArgs.query ?? "");
        const topKRaw = Number(parsedArgs.top_k ?? 10);
        const topK = ALLOWED_TOP_K.has(topKRaw) ? topKRaw : 10;
        hits = searchNotesBm25({
          index,
          query,
          topK,
          annotations: args.annotations,
        });
      } else {
        const patterns = Array.isArray(parsedArgs.patterns)
          ? parsedArgs.patterns.map((p) => String(p))
          : [];
        hits = grepNotes({
          sessionIds: args.sessionIds,
          annotations: args.annotations,
          patterns,
          limit: 20,
        });
      }
      lastHits = hits;
      lastToolResults = formatHits(hits);
      if (hopsUsed >= args.hopBudget) {
        lastToolResults +=
          "\n(hop budget exhausted — next call must be add_sessions or done)";
      }
      steps.push({
        hop: hopsUsed,
        tool: name,
        args: parsedArgs,
        result_summary: `${String(hits.length)} hits`,
        hits,
      });
      continue;
    }

    if (name === "add_sessions") {
      const allowed = new Set(lastHits.map((h) => h.sessionId));
      const requested = Array.isArray(parsedArgs.session_ids)
        ? parsedArgs.session_ids.map((id) => String(id))
        : [];
      const added: string[] = [];
      for (const sid of requested) {
        if (!allowed.has(sid)) continue;
        if (bagSet.has(sid)) continue;
        if (bag.length >= BAG_MAX) break;
        bagSet.add(sid);
        bag.push(sid);
        added.push(sid);
      }
      lastToolResults =
        `added=${JSON.stringify(added)} bag_size=${String(bag.length)} `
        + `rejected=${JSON.stringify(requested.filter((id) => !added.includes(id)))}`;
      steps.push({
        hop: hopsUsed,
        tool: name,
        args: parsedArgs,
        result_summary: lastToolResults,
        added,
      });
      continue;
    }

    if (name === "done") {
      doneReason = String(parsedArgs.reason ?? "done");
      steps.push({
        hop: hopsUsed,
        tool: name,
        args: parsedArgs,
        result_summary: doneReason,
      });
      break;
    }

    lastToolResults = `error: unknown tool ${name}`;
    steps.push({
      hop: hopsUsed,
      tool: name,
      args: parsedArgs,
      result_summary: lastToolResults,
    });
  }

  if (!doneReason && hopsUsed >= args.hopBudget) {
    doneReason = "hop_budget_exhausted";
  } else if (!doneReason && turns >= maxTurns) {
    doneReason = "max_turns";
  }

  return {
    bag,
    hopsUsed,
    turns,
    doneReason,
    steps,
    inputTokens,
    outputTokens,
  };
}

function notesBm25Baseline(args: {
  question: string;
  sessionIds: string[];
  datesBySessionId: Map<string, string>;
  annotations: Map<string, SessionAnnotation>;
  gold: string[];
}): {
  top5: string[];
  top12: string[];
  fullGoldTop5: boolean;
  fullGoldTop12: boolean;
} {
  const index = buildNotesBm25Index({
    sessionIds: args.sessionIds,
    datesBySessionId: args.datesBySessionId,
    annotations: args.annotations,
  });
  const hits = searchNotesBm25({
    index,
    query: args.question,
    topK: 20,
    annotations: args.annotations,
  });
  const ranked = hits.map((h) => h.sessionId);
  const top5 = ranked.slice(0, 5);
  const top12 = ranked.slice(0, 12);
  return {
    top5,
    top12,
    fullGoldTop5: fullGoldIn(top5, args.gold),
    fullGoldTop12: fullGoldIn(top12, args.gold),
  };
}

async function main(): Promise<void> {
  loadDotEnv(resolve(PROJECT_ROOT, ".env"));
  const args = parseArgs(process.argv.slice(2));
  const idsPath = resolve(PROJECT_ROOT, args.ids ?? DEFAULT_IDS);
  const annotationsDir = resolve(PROJECT_ROOT, args.annotations ?? DEFAULT_ANNOTATIONS);
  const datasetPath = resolve(PROJECT_ROOT, args.dataset ?? DEFAULT_DATASET);
  const oraclePath = resolve(PROJECT_ROOT, args.oracle ?? DEFAULT_ORACLE);
  const phase1Path = resolve(PROJECT_ROOT, args.phase1 ?? DEFAULT_PHASE1);
  const hopBudget = Number(args.hops ?? "3");
  const model = args.model ?? "gpt-5.4-nano-2026-03-17";
  const reasoning = (args.reasoning ?? "medium") as "none" | "low" | "medium" | "high";
  const promptName = args.prompt ?? "hop-retrieve-v1";
  const concurrency = Number(args.concurrency ?? "8");
  const baselinesOnly = args["baselines-only"] === "true";
  const outPath = resolve(
    PROJECT_ROOT,
    args.out
      ?? (baselinesOnly
        ? "runs/local-archive/backbone/hop-gate-baselines.json"
        : `runs/local-archive/backbone/hop-gate-${model.replaceAll(/[^a-zA-Z0-9._-]/g, "_")}-h${String(hopBudget)}.json`),
  );

  const hop27 = JSON.parse(readFileSync(idsPath, "utf8")) as Hop27Ids;
  const dataset = JSON.parse(readFileSync(datasetPath, "utf8")) as RawCase[];
  const oracleList = JSON.parse(readFileSync(oraclePath, "utf8")) as Array<{
    question_id: string;
    answer_session_ids: string[];
  }>;
  const phase1 = JSON.parse(readFileSync(phase1Path, "utf8")) as { cases: Phase1Case[] };
  const byId = new Map(dataset.map((item) => [item.question_id, item]));
  const oracle = new Map(oracleList.map((item) => [item.question_id, item.answer_session_ids]));
  const phase1ById = new Map(phase1.cases.map((item) => [item.question_id, item]));
  const annotations = loadAnnotations(annotationsDir);
  const selected = resolveQuestionIds(hop27, args);

  console.log(
    `hop-retrieve-gate ids=${String(selected.length)} hops=${String(hopBudget)} `
      + `model=${baselinesOnly ? "none" : model} reasoning=${baselinesOnly ? "n/a" : reasoning} `
      + `prompt=${promptName} concurrency=${String(concurrency)} `
      + `annotations=${String(annotations.size)} baselines_only=${String(baselinesOnly)}`,
  );

  const openai = baselinesOnly
    ? null
    : new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 2 });
  if (!baselinesOnly && !process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required");
  }
  const prompts = new PromptLoader();
  const gate = new TokenBudgetGate(TOKEN_BUDGET, WINDOW_SECONDS, concurrency);
  const results: CaseResult[] = new Array(selected.length);
  let cursor = 0;
  const started = Date.now();

  async function runOne(index: number, hopCase: Hop27Case): Promise<void> {
    const raw = byId.get(hopCase.question_id);
    const gold = oracle.get(hopCase.question_id) ?? [];
    if (!raw) {
      results[index] = {
        question_id: hopCase.question_id,
        stratum: hopCase.stratum,
        question_type: hopCase.question_type,
        gold,
        bag: [],
        hops_used: 0,
        turns: 0,
        done_reason: null,
        full_gold_in_bag: false,
        gold_recall: 0,
        gold_in_bag_count: 0,
        phase1_worst_rank: hopCase.phase1_worst_rank,
        phase1_in_top5: false,
        phase1_in_top12: false,
        notes_bm25_top5: [],
        notes_bm25_top12: [],
        notes_bm25_full_gold_top5: false,
        notes_bm25_full_gold_top12: false,
        input_tokens: 0,
        output_tokens: 0,
        error: "missing dataset case",
        steps: [],
      };
      return;
    }

    const datesBySessionId = new Map<string, string>();
    for (let i = 0; i < raw.haystack_session_ids.length; i += 1) {
      const sid = raw.haystack_session_ids[i];
      const date = raw.haystack_dates[i];
      if (sid) datesBySessionId.set(sid, date ?? "");
    }

    const p1 = phase1ById.get(hopCase.question_id);
    const goldRanks = p1?.gold_ranks ?? hopCase.phase1_gold_ranks;
    const notesBase = notesBm25Baseline({
      question: raw.question,
      sessionIds: raw.haystack_session_ids,
      datesBySessionId,
      annotations,
      gold,
    });

    let bag: string[] = [];
    let hopsUsed = 0;
    let turns = 0;
    let doneReason: string | null = baselinesOnly ? "baselines_only" : null;
    let steps: HopTraceStep[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let error: string | undefined;

    if (!baselinesOnly && openai) {
      try {
        const agent = await runHopAgent({
          openai,
          prompts,
          gate,
          model,
          reasoning,
          hopBudget,
          promptName,
          question: raw.question,
          questionDate: raw.question_date,
          sessionIds: raw.haystack_session_ids,
          datesBySessionId,
          annotations,
        });
        bag = agent.bag;
        hopsUsed = agent.hopsUsed;
        turns = agent.turns;
        doneReason = agent.doneReason;
        steps = agent.steps;
        inputTokens = agent.inputTokens;
        outputTokens = agent.outputTokens;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    }

    results[index] = {
      question_id: hopCase.question_id,
      stratum: hopCase.stratum,
      question_type: hopCase.question_type,
      gold,
      bag,
      hops_used: hopsUsed,
      turns,
      done_reason: doneReason,
      full_gold_in_bag: fullGoldIn(bag, gold),
      gold_recall: goldRecall(bag, gold),
      gold_in_bag_count: gold.filter((id) => bag.includes(id)).length,
      phase1_worst_rank: p1?.worst_rank ?? hopCase.phase1_worst_rank,
      phase1_in_top5: phase1InTopK(goldRanks, 5),
      phase1_in_top12: phase1InTopK(goldRanks, 12),
      notes_bm25_top5: notesBase.top5,
      notes_bm25_top12: notesBase.top12,
      notes_bm25_full_gold_top5: notesBase.fullGoldTop5,
      notes_bm25_full_gold_top12: notesBase.fullGoldTop12,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      error,
      steps,
    };
  }

  async function worker(): Promise<void> {
    while (cursor < selected.length) {
      const index = cursor;
      cursor += 1;
      const hopCase = selected[index];
      if (!hopCase) continue;
      await runOne(index, hopCase);
      const done = results.filter(Boolean).length;
      if (done % 4 === 0 || done === selected.length) {
        const elapsed = ((Date.now() - started) / 1000).toFixed(0);
        console.log(`progress ${String(done)}/${String(selected.length)} ${elapsed}s`);
      }
    }
  }

  const workers = Math.min(baselinesOnly ? 1 : concurrency, Math.max(selected.length, 1));
  await Promise.all(Array.from({ length: workers }, () => worker()));

  const finished = results.filter((item): item is CaseResult => !!item);
  const aggregate = summarizeStratum(finished);
  const payload = {
    created_at: new Date().toISOString(),
    ids_path: idsPath,
    annotations_dir: annotationsDir,
    phase1_path: phase1Path,
    model: baselinesOnly ? null : model,
    reasoning: baselinesOnly ? null : reasoning,
    prompt: promptName,
    hop_budget: hopBudget,
    bag_max: BAG_MAX,
    baselines_only: baselinesOnly,
    aggregate,
    cases: finished,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload, null, 2));

  const hard = (aggregate.hard ?? {}) as Record<string, number>;
  const easy = (aggregate.easy ?? {}) as Record<string, number>;
  console.log(
    `wrote ${outPath}\n`
      + `hard full_gold_in_bag=${String(hard.full_gold_in_bag ?? 0)}/`
      + `${String(hard.n ?? 0)} phase1_top12=${String(hard.phase1_top12 ?? 0)} `
      + `notes_top12=${String(hard.notes_bm25_top12 ?? 0)}\n`
      + `easy full_gold_in_bag=${String(easy.full_gold_in_bag ?? 0)}/`
      + `${String(easy.n ?? 0)} phase1_top12=${String(easy.phase1_top12 ?? 0)}\n`
      + `elapsed_s=${((Date.now() - started) / 1000).toFixed(1)}`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
