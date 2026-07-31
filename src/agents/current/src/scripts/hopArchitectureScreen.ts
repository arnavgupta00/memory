/**
 * Screen one alternative hop-retriever architecture on a frozen ID slice.
 *
 * Arms:
 * - stateful: coverage-guided sequential notes search with persistent evidence.
 * - parallel: one plan, four local search views, batched verification, set cover.
 * - hybrid: parallel candidate discovery, then permissive v1-style admission.
 * - ledger: occurrence-aware claim search, batched verification, set cover.
 *
 * All model-visible session references are deterministic per-case opaque handles.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type {
  FunctionTool,
  Response as OpenAIResponse,
} from "openai/resources/responses/responses";
import { z } from "zod";

import { Bm25Index } from "../retrieval/bm25.js";
import {
  buildNotesDocuments,
  loadAnnotations,
  type SessionAnnotation,
} from "../retrieval/notesIndex.js";
import {
  assertNoRawSessionIdLeak,
  buildOpaqueSessionSpace,
  type OpaqueSessionSpace,
} from "../retrieval/opaqueSessionIds.js";
import { tokenizeRetrievalText } from "../retrieval/tokenize.js";
import type { Bm25SearchResult, RetrievalDocument } from "../retrieval/types.js";
import { PromptLoader, type PromptEnvelope } from "../services/promptLoader.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const DEFAULT_IDS = resolve(
  PROJECT_ROOT,
  "src/agents/current/eval-slices/hop-screen90-v1.json",
);
const DEFAULT_DATASET = resolve(PROJECT_ROOT, "data/raw/longmemeval_s_cleaned.json");
const DEFAULT_ORACLE = resolve(PROJECT_ROOT, "data/raw/longmemeval_oracle.json");
const DEFAULT_ANNOTATIONS = resolve(
  PROJECT_ROOT,
  "runs/local-archive/backbone/session-annotations-v1",
);
const BAG_MAX = 12;
const POOL_MAX = 24;
const HOP_BUDGET = 6;
const OUTPUT_RESERVE = 1_200;
const LUNA_INPUT_PRICE = 1;
const LUNA_OUTPUT_PRICE = 6;

type Arm = "stateful" | "parallel" | "hybrid" | "ledger";
type Reasoning = "none" | "low" | "medium" | "high";

type RawTurn = {
  role: "user" | "assistant";
  content: string;
};

type RawCase = {
  question_id: string;
  question_type: string;
  question: string;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: RawTurn[][];
};

type SliceCase = {
  question_id: string;
  stratum: "hard" | "mid" | "easy";
  question_type: string;
};

type Slice = {
  name: string;
  question_ids: string[];
  cases: SliceCase[];
};

type CaseSpace = {
  raw: RawCase;
  rawSessionIds: string[];
  opaque: OpaqueSessionSpace;
  turnsByOpaqueId: Map<string, RawTurn[]>;
  dateByOpaqueId: Map<string, string>;
  goldReal: string[];
  goldOpaque: string[];
};

type Usage = {
  inputTokens: number;
  outputTokens: number;
  calls: number;
};

type Facet = {
  id: string;
  kind:
    | "lookup"
    | "prior_value"
    | "current_value"
    | "temporal_endpoint"
    | "aggregate_member"
    | "comparison"
    | "absence";
  description: string;
  query_terms: string[];
  required_evidence_count: number;
};

type QueryLane = {
  query: string;
  facet_ids: string[];
};

type FacetPlan = {
  facets: Facet[];
  queries: QueryLane[];
};

type CandidateAssessment = {
  session_id: string;
  facet_ids: string[];
  label:
    | "direct"
    | "supporting"
    | "prior_value"
    | "current_value"
    | "contradictory"
    | "topical_only";
  evidence: string;
};

type EvidenceCandidate = {
  sessionId: string;
  date: string;
  score: number;
  excerpts: Set<string>;
  facetIds: Set<string>;
  matchedTerms: Set<string>;
  ranks: Array<{ view: string; query: string; rank: number }>;
};

type ArmResult = {
  modelBag: string[];
  modelPool: string[];
  usage: Usage;
  trace: unknown[];
};

type CaseResult = {
  question_id: string;
  stratum: string;
  question_type: string;
  gold: string[];
  bag: string[];
  model_bag: string[];
  candidate_pool: string[];
  full_gold_in_bag: boolean;
  candidate_pool_full_gold: boolean;
  gold_recall: number;
  candidate_pool_gold_recall: number;
  input_tokens: number;
  output_tokens: number;
  api_calls: number;
  elapsed_ms: number;
  trace: unknown[];
  error?: string;
};

const FacetPlanSchema = z.strictObject({
  facets: z.array(
    z.strictObject({
      id: z.string().min(1).max(20),
      kind: z.enum([
        "lookup",
        "prior_value",
        "current_value",
        "temporal_endpoint",
        "aggregate_member",
        "comparison",
        "absence",
      ]),
      description: z.string().min(1).max(240),
      query_terms: z.array(z.string().min(1).max(100)).min(1).max(12),
      required_evidence_count: z.number().int().min(1).max(6),
    }),
  ).min(1).max(10),
  queries: z.array(
    z.strictObject({
      query: z.string().min(1).max(300),
      facet_ids: z.array(z.string().min(1).max(20)).min(1).max(10),
    }),
  ).min(1).max(10),
});

const CandidateAssessmentsSchema = z.strictObject({
  assessments: z.array(
    z.strictObject({
      session_id: z.string().min(1).max(40),
      facet_ids: z.array(z.string().min(1).max(20)).max(10),
      label: z.enum([
        "direct",
        "supporting",
        "prior_value",
        "current_value",
        "contradictory",
        "topical_only",
      ]),
      evidence: z.string().max(300),
    }),
  ).max(POOL_MAX),
  unresolved_facet_ids: z.array(z.string().min(1).max(20)).max(10),
});

const V1_ADMISSION_TOOL: FunctionTool = {
  type: "function",
  name: "add_sessions",
  description: "Add every promising session from the supplied search results.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      session_ids: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: BAG_MAX,
      },
    },
    required: ["session_ids"],
  },
};

const STATEFUL_TOOLS: FunctionTool[] = [
  {
    type: "function",
    name: "search_notes",
    description: "Search structured notes for concrete evidence supporting unresolved facets.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string" },
        top_k: { type: "integer", enum: [5, 10, 20] },
        facet_ids: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 10,
        },
      },
      required: ["query", "top_k", "facet_ids"],
    },
  },
  {
    type: "function",
    name: "add_sessions",
    description: "Admit sessions already present in the persistent evidence ledger.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        session_ids: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: BAG_MAX,
        },
        facet_ids: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 10,
        },
      },
      required: ["session_ids", "facet_ids"],
    },
  },
  {
    type: "function",
    name: "done",
    description: "Finish when facets are covered or targeted evidence is absent.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        reason: { type: "string" },
        unresolved_facet_ids: {
          type: "array",
          items: { type: "string" },
          maxItems: 10,
        },
      },
      required: ["reason", "unresolved_facet_ids"],
    },
  },
];

function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals <= 0) continue;
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function parseArgs(argv: string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      output[key] = "true";
    } else {
      output[key] = next;
      index += 1;
    }
  }
  return output;
}

function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

class TokenGate {
  readonly #tokenBudget: number;
  readonly #windowMs: number;
  readonly #maxConcurrency: number;
  #active = 0;
  #reservations: Array<{ at: number; tokens: number }> = [];

  constructor(tokenBudget: number, windowSeconds: number, maxConcurrency: number) {
    this.#tokenBudget = tokenBudget;
    this.#windowMs = windowSeconds * 1_000;
    this.#maxConcurrency = maxConcurrency;
  }

  async acquire(tokens: number): Promise<() => void> {
    for (;;) {
      const cutoff = Date.now() - this.#windowMs;
      this.#reservations = this.#reservations.filter((item) => item.at >= cutoff);
      const reserved = this.#reservations.reduce((sum, item) => sum + item.tokens, 0);
      if (
        this.#active < this.#maxConcurrency
        && reserved + tokens <= this.#tokenBudget
      ) {
        this.#active += 1;
        this.#reservations.push({ at: Date.now(), tokens });
        return () => {
          this.#active -= 1;
        };
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
}

function envelopeText(prompt: PromptEnvelope): string {
  return prompt.messages.map((message) => message.content).join("\n");
}

function addUsage(usage: Usage, response: OpenAIResponse): void {
  usage.inputTokens += response.usage?.input_tokens ?? 0;
  usage.outputTokens += response.usage?.output_tokens ?? 0;
  usage.calls += 1;
}

async function planFacets(args: {
  openai: OpenAI;
  prompts: PromptLoader;
  gate: TokenGate;
  model: string;
  reasoning: Reasoning;
  space: CaseSpace;
  usage: Usage;
}): Promise<FacetPlan> {
  const prompt = await args.prompts.render("hop-facet-plan-v1", {
    question: args.space.raw.question,
    question_date: args.space.raw.question_date,
  });
  const inputText = envelopeText(prompt);
  assertNoRawSessionIdLeak(inputText, args.space.rawSessionIds);
  const release = await args.gate.acquire(estimateTokens(inputText) + OUTPUT_RESERVE);
  try {
    const response = await args.openai.responses.parse({
      model: args.model,
      input: prompt.messages,
      text: { format: zodTextFormat(FacetPlanSchema, "hop_facet_plan_v1") },
      ...(args.reasoning === "none" ? {} : { reasoning: { effort: args.reasoning } }),
    });
    addUsage(args.usage, response);
    const parsed = response.output_parsed;
    if (!parsed) throw new Error("facet planner returned no structured output");
    const validIds = new Set(parsed.facets.map((facet) => facet.id));
    const queries = parsed.queries
      .map((query) => ({
        ...query,
        facet_ids: query.facet_ids.filter((id) => validIds.has(id)),
      }))
      .filter((query) => query.facet_ids.length > 0);
    return {
      facets: parsed.facets,
      queries: queries.length > 0
        ? queries
        : parsed.facets.map((facet) => ({
          query: facet.query_terms.join(" "),
          facet_ids: [facet.id],
        })),
    };
  } finally {
    release();
  }
}

async function assessCandidates(args: {
  promptName: "hop-multiview-verify-v1" | "hop-ledger-verify-v1";
  openai: OpenAI;
  prompts: PromptLoader;
  gate: TokenGate;
  model: string;
  reasoning: Reasoning;
  space: CaseSpace;
  plan: FacetPlan;
  catalog: string;
  usage: Usage;
}): Promise<{ assessments: CandidateAssessment[]; unresolved: string[] }> {
  const prompt = await args.prompts.render(args.promptName, {
    question: args.space.raw.question,
    question_date: args.space.raw.question_date,
    facets: formatFacets(args.plan.facets),
    candidate_catalog: args.catalog,
  });
  const inputText = envelopeText(prompt);
  assertNoRawSessionIdLeak(inputText, args.space.rawSessionIds);
  const release = await args.gate.acquire(estimateTokens(inputText) + OUTPUT_RESERVE);
  try {
    const response = await args.openai.responses.parse({
      model: args.model,
      input: prompt.messages,
      text: {
        format: zodTextFormat(CandidateAssessmentsSchema, "hop_candidate_assessments_v1"),
      },
      ...(args.reasoning === "none" ? {} : { reasoning: { effort: args.reasoning } }),
    });
    addUsage(args.usage, response);
    const parsed = response.output_parsed;
    if (!parsed) throw new Error("candidate verifier returned no structured output");
    return {
      assessments: parsed.assessments,
      unresolved: parsed.unresolved_facet_ids,
    };
  } finally {
    release();
  }
}

function formatFacets(facets: Facet[]): string {
  return facets
    .map(
      (facet) =>
        `${facet.id} [${facet.kind}] required=${String(facet.required_evidence_count)}: `
        + `${facet.description} | terms=${facet.query_terms.join(", ")}`,
    )
    .join("\n");
}

function normalizeQuery(query: string): string {
  return [...new Set(tokenizeRetrievalText(query))].sort().join(" ");
}

function clip(text: string, limit = 360): string {
  const normalized = text.replaceAll(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function overlapScore(text: string, queryTerms: Set<string>): number {
  const tokens = tokenizeRetrievalText(text);
  return tokens.filter((token) => queryTerms.has(token)).length;
}

function bestNoteExcerpt(
  annotation: SessionAnnotation | undefined,
  query: string,
): string {
  if (!annotation) return "(no structured notes)";
  const terms = new Set(tokenizeRetrievalText(query));
  const lines = [
    ...annotation.facts.map((fact) => `USER turn ${String(fact.turn_index)}: ${fact.text}`),
    ...annotation.events.map(
      (event) =>
        `USER turn ${String(event.turn_index)} event`
        + `${event.date_hint ? ` (${event.date_hint})` : ""}: ${event.text}`,
    ),
    ...annotation.keyphrases.map((phrase) => `keyphrase: ${phrase}`),
  ];
  const ranked = lines
    .map((line, index) => ({ line, index, score: overlapScore(line, terms) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 4)
    .map((item) => item.line);
  return clip(ranked.join(" | "));
}

function bestTurnExcerpt(
  turns: RawTurn[],
  role: "user" | "assistant" | "all",
  query: string,
): string {
  const terms = new Set(tokenizeRetrievalText(query));
  const ranked = turns
    .map((turn, index) => ({ turn, index }))
    .filter((item) => role === "all" || item.turn.role === role)
    .map((item) => ({
      ...item,
      score: overlapScore(item.turn.content, terms),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 3)
    .map(
      (item) =>
        `${item.turn.role.toUpperCase()} turn ${String(item.index)}: ${clip(item.turn.content, 260)}`,
    );
  return ranked.length > 0 ? clip(ranked.join(" | ")) : `(no ${role} evidence)`;
}

function fullGoldIn(ids: Iterable<string>, gold: string[]): boolean {
  const set = new Set(ids);
  return gold.length > 0 && gold.every((id) => set.has(id));
}

function recall(ids: Iterable<string>, gold: string[]): number {
  if (gold.length === 0) return 0;
  const set = new Set(ids);
  return gold.filter((id) => set.has(id)).length / gold.length;
}

function buildCaseSpace(args: {
  raw: RawCase;
  goldReal: string[];
  annotations: Map<string, SessionAnnotation>;
}): CaseSpace {
  const datesByRealId = new Map<string, string>();
  for (let index = 0; index < args.raw.haystack_session_ids.length; index += 1) {
    const sessionId = args.raw.haystack_session_ids[index];
    if (sessionId) datesByRealId.set(sessionId, args.raw.haystack_dates[index] ?? "");
  }
  const opaque = buildOpaqueSessionSpace({
    namespace: args.raw.question_id,
    sessionIds: args.raw.haystack_session_ids,
    datesBySessionId: datesByRealId,
    annotations: args.annotations,
  });
  const turnsByOpaqueId = new Map<string, RawTurn[]>();
  const dateByOpaqueId = new Map<string, string>();
  for (let index = 0; index < args.raw.haystack_session_ids.length; index += 1) {
    const realId = args.raw.haystack_session_ids[index];
    if (!realId) continue;
    const opaqueId = opaque.realToOpaque.get(realId);
    if (!opaqueId || turnsByOpaqueId.has(opaqueId)) continue;
    turnsByOpaqueId.set(opaqueId, args.raw.haystack_sessions[index] ?? []);
    dateByOpaqueId.set(opaqueId, args.raw.haystack_dates[index] ?? "");
  }
  return {
    raw: args.raw,
    rawSessionIds: [...new Set(args.raw.haystack_session_ids)],
    opaque,
    turnsByOpaqueId,
    dateByOpaqueId,
    goldReal: args.goldReal,
    goldOpaque: args.goldReal.flatMap((id) => {
      const mapped = opaque.realToOpaque.get(id);
      return mapped ? [mapped] : [];
    }),
  };
}

function makeRoleDocuments(
  space: CaseSpace,
  role: "user" | "assistant" | "all",
): RetrievalDocument[] {
  return [...new Set(space.opaque.sessionIds)].map((sessionId) => {
    const turns = space.turnsByOpaqueId.get(sessionId) ?? [];
    const text = turns
      .filter((turn) => role === "all" || turn.role === role)
      .map((turn, index) => `[${turn.role} turn ${String(index)}] ${turn.content}`)
      .join("\n");
    return {
      id: sessionId,
      text: `[source_view] ${role}\n${text}`,
      sessionId,
      date: space.dateByOpaqueId.get(sessionId) ?? "",
      startTurn: 0,
      endTurn: Math.max(turns.length - 1, 0),
    };
  });
}

function addRankedEvidence(args: {
  candidates: Map<string, EvidenceCandidate>;
  results: Bm25SearchResult[];
  view: string;
  query: QueryLane;
  space: CaseSpace;
}): void {
  for (const hit of args.results) {
    const sessionId = hit.documentId;
    let candidate = args.candidates.get(sessionId);
    if (!candidate) {
      candidate = {
        sessionId,
        date: args.space.dateByOpaqueId.get(sessionId) ?? "",
        score: 0,
        excerpts: new Set(),
        facetIds: new Set(),
        matchedTerms: new Set(),
        ranks: [],
      };
      args.candidates.set(sessionId, candidate);
    }
    candidate.score += 1 / (60 + hit.rank);
    for (const facetId of args.query.facet_ids) candidate.facetIds.add(facetId);
    for (const term of hit.matchedTerms) candidate.matchedTerms.add(term);
    candidate.ranks.push({ view: args.view, query: args.query.query, rank: hit.rank });
    const excerpt = args.view === "notes"
      ? bestNoteExcerpt(args.space.opaque.annotations.get(sessionId), args.query.query)
      : bestTurnExcerpt(
        args.space.turnsByOpaqueId.get(sessionId) ?? [],
        args.view as "user" | "assistant" | "all",
        args.query.query,
      );
    candidate.excerpts.add(`${args.view}: ${excerpt}`);
  }
}

function candidateCatalog(candidates: EvidenceCandidate[], heading = "candidate"): string {
  return candidates
    .map(
      (candidate, index) =>
        `${heading} ${String(index + 1)}: ${candidate.sessionId} `
        + `date=${candidate.date || "(unknown)"} fused=${candidate.score.toFixed(4)} `
        + `suggested_facets=[${[...candidate.facetIds].join(",")}]\n`
        + [...candidate.excerpts].slice(0, 6).map((excerpt) => `- ${excerpt}`).join("\n"),
    )
    .join("\n\n");
}

function selectMinimalCover(args: {
  plan: FacetPlan;
  candidates: EvidenceCandidate[];
  assessments: CandidateAssessment[];
}): string[] {
  const candidateById = new Map(args.candidates.map((item) => [item.sessionId, item]));
  const validFacetIds = new Set(args.plan.facets.map((facet) => facet.id));
  const remaining = new Map(
    args.plan.facets.map((facet) => [facet.id, facet.required_evidence_count]),
  );
  const usable = args.assessments
    .filter((item) => candidateById.has(item.session_id))
    .filter((item) => item.label !== "topical_only")
    .map((item) => ({
      ...item,
      facet_ids: [...new Set(item.facet_ids.filter((id) => validFacetIds.has(id)))],
    }));
  const selected: string[] = [];
  const selectedSet = new Set<string>();
  const labelWeight: Record<CandidateAssessment["label"], number> = {
    direct: 6,
    current_value: 6,
    prior_value: 5,
    supporting: 3,
    contradictory: 2,
    topical_only: 0,
  };

  while (selected.length < BAG_MAX) {
    let best: (typeof usable)[number] | undefined;
    let bestUtility = 0;
    for (const assessment of usable) {
      if (selectedSet.has(assessment.session_id)) continue;
      const newCoverage = assessment.facet_ids.filter(
        (facetId) => (remaining.get(facetId) ?? 0) > 0,
      ).length;
      if (newCoverage === 0) continue;
      const rankScore = candidateById.get(assessment.session_id)?.score ?? 0;
      const utility = newCoverage * 100 + labelWeight[assessment.label] * 10 + rankScore;
      if (utility > bestUtility) {
        bestUtility = utility;
        best = assessment;
      }
    }
    if (!best) break;
    selected.push(best.session_id);
    selectedSet.add(best.session_id);
    for (const facetId of best.facet_ids) {
      const count = remaining.get(facetId) ?? 0;
      if (count > 0) remaining.set(facetId, count - 1);
    }
    if ([...remaining.values()].every((count) => count <= 0)) break;
  }

  return selected;
}

function discoverParallelPool(args: {
  space: CaseSpace;
  plan: FacetPlan;
}): EvidenceCandidate[] {
  const notesDocs = buildNotesDocuments({
    sessionIds: args.space.opaque.sessionIds,
    datesBySessionId: args.space.opaque.datesBySessionId,
    annotations: args.space.opaque.annotations,
  });
  const views = new Map<string, Bm25Index>([
    ["notes", new Bm25Index(notesDocs)],
    ["user", new Bm25Index(makeRoleDocuments(args.space, "user"))],
    ["assistant", new Bm25Index(makeRoleDocuments(args.space, "assistant"))],
    ["all", new Bm25Index(makeRoleDocuments(args.space, "all"))],
  ]);
  const allFacetIds = args.plan.facets.map((facet) => facet.id);
  const lanes: QueryLane[] = [
    { query: args.space.raw.question, facet_ids: allFacetIds },
    ...args.plan.queries,
  ];
  const candidates = new Map<string, EvidenceCandidate>();
  for (const [view, index] of views) {
    for (const lane of lanes) {
      addRankedEvidence({
        candidates,
        results: index.search(lane.query, 10),
        view,
        query: lane,
        space: args.space,
      });
    }
  }
  return [...candidates.values()]
    .sort(
      (left, right) =>
        right.score - left.score
        || right.facetIds.size - left.facetIds.size
        || left.sessionId.localeCompare(right.sessionId),
    )
    .slice(0, POOL_MAX);
}

async function admitWithV1Prompt(args: {
  openai: OpenAI;
  prompts: PromptLoader;
  gate: TokenGate;
  model: string;
  reasoning: Reasoning;
  space: CaseSpace;
  pool: EvidenceCandidate[];
  usage: Usage;
}): Promise<{ admitted: string[]; requested: string[] }> {
  const prompt = await args.prompts.render("hop-retrieve-v1", {
    question: args.space.raw.question,
    question_date: args.space.raw.question_date,
    hop_budget: String(HOP_BUDGET),
    bag_max: String(BAG_MAX),
    bag_sessions: "(empty)",
    hop_number: "1",
    last_tool_results:
      `Parallel multi-view search returned ${String(args.pool.length)} hits. `
      + "This is the complete result set: add every promising session now.\n"
      + candidateCatalog(args.pool, "search hit"),
  });
  const inputText = envelopeText(prompt);
  assertNoRawSessionIdLeak(inputText, args.space.rawSessionIds);
  const release = await args.gate.acquire(estimateTokens(inputText) + OUTPUT_RESERVE);
  try {
    const response = await args.openai.responses.create({
      model: args.model,
      input: prompt.messages,
      tools: [V1_ADMISSION_TOOL],
      tool_choice: "required",
      parallel_tool_calls: false,
      ...(args.reasoning === "none" ? {} : { reasoning: { effort: args.reasoning } }),
    });
    addUsage(args.usage, response);
    const toolCall = response.output.find(
      (item): item is Extract<(typeof response.output)[number], { type: "function_call" }> =>
        item.type === "function_call",
    );
    if (!toolCall) throw new Error("v1 admission returned no tool call");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(toolCall.arguments || "{}") as Record<string, unknown>;
    } catch {
      throw new Error("v1 admission returned invalid tool arguments");
    }
    const requested = Array.isArray(parsed.session_ids)
      ? parsed.session_ids.map((id) => String(id))
      : [];
    const allowed = new Set(args.pool.map((candidate) => candidate.sessionId));
    const admitted = [...new Set(requested)]
      .filter((id) => allowed.has(id))
      .slice(0, BAG_MAX);
    return { admitted, requested };
  } finally {
    release();
  }
}

async function runParallel(args: {
  openai: OpenAI;
  prompts: PromptLoader;
  gate: TokenGate;
  model: string;
  reasoning: Reasoning;
  space: CaseSpace;
}): Promise<ArmResult> {
  const usage: Usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
  const plan = await planFacets({ ...args, usage });
  const pool = discoverParallelPool({ space: args.space, plan });
  const verified = await assessCandidates({
    ...args,
    promptName: "hop-multiview-verify-v1",
    plan,
    catalog: candidateCatalog(pool),
    usage,
  });
  const modelBag = selectMinimalCover({
    plan,
    candidates: pool,
    assessments: verified.assessments,
  });
  return {
    modelBag,
    modelPool: pool.map((item) => item.sessionId),
    usage,
    trace: [
      { plan },
      {
        candidate_pool: pool.map((item) => ({
          session_id: item.sessionId,
          score: item.score,
          facet_ids: [...item.facetIds],
          ranks: item.ranks,
        })),
      },
      { assessments: verified.assessments, unresolved: verified.unresolved },
    ],
  };
}

async function runHybrid(args: {
  openai: OpenAI;
  prompts: PromptLoader;
  gate: TokenGate;
  model: string;
  reasoning: Reasoning;
  space: CaseSpace;
}): Promise<ArmResult> {
  const usage: Usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
  const plan = await planFacets({ ...args, usage });
  const pool = discoverParallelPool({ space: args.space, plan });
  const selection = await admitWithV1Prompt({ ...args, pool, usage });
  return {
    modelBag: selection.admitted,
    modelPool: pool.map((item) => item.sessionId),
    usage,
    trace: [
      { plan },
      {
        candidate_pool: pool.map((item) => ({
          session_id: item.sessionId,
          score: item.score,
          facet_ids: [...item.facetIds],
          ranks: item.ranks,
        })),
      },
      {
        v1_admission: {
          requested: selection.requested,
          admitted: selection.admitted,
        },
      },
    ],
  };
}

type Claim = {
  id: string;
  sessionId: string;
  date: string;
  turnIndex: number;
  role: "user" | "assistant";
  kind: "raw" | "fact" | "event";
  dateHint: string;
  text: string;
};

function sentenceClaims(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 3)
    .map((sentence) => clip(sentence, 500));
}

function buildClaims(space: CaseSpace): Claim[] {
  const claims: Claim[] = [];
  const seen = new Set<string>();
  let sequence = 0;
  const add = (claim: Omit<Claim, "id">): void => {
    const key = [
      claim.sessionId,
      claim.turnIndex,
      claim.role,
      claim.text.toLocaleLowerCase(),
    ].join("\0");
    if (seen.has(key)) return;
    seen.add(key);
    sequence += 1;
    claims.push({ ...claim, id: `claim_${String(sequence).padStart(5, "0")}` });
  };

  for (const sessionId of new Set(space.opaque.sessionIds)) {
    const date = space.dateByOpaqueId.get(sessionId) ?? "";
    const annotation = space.opaque.annotations.get(sessionId);
    for (const fact of annotation?.facts ?? []) {
      add({
        sessionId,
        date,
        turnIndex: fact.turn_index,
        role: "user",
        kind: "fact",
        dateHint: "",
        text: fact.text,
      });
    }
    for (const event of annotation?.events ?? []) {
      add({
        sessionId,
        date,
        turnIndex: event.turn_index,
        role: "user",
        kind: "event",
        dateHint: event.date_hint,
        text: event.text,
      });
    }
    const turns = space.turnsByOpaqueId.get(sessionId) ?? [];
    for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
      const turn = turns[turnIndex];
      if (!turn) continue;
      for (const sentence of sentenceClaims(turn.content)) {
        add({
          sessionId,
          date,
          turnIndex,
          role: turn.role,
          kind: "raw",
          dateHint: "",
          text: sentence,
        });
      }
    }
  }
  return claims;
}

async function runLedger(args: {
  openai: OpenAI;
  prompts: PromptLoader;
  gate: TokenGate;
  model: string;
  reasoning: Reasoning;
  space: CaseSpace;
}): Promise<ArmResult> {
  const usage: Usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
  const plan = await planFacets({ ...args, usage });
  const claims = buildClaims(args.space);
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const index = new Bm25Index(
    claims.map((claim) => ({
      id: claim.id,
      text:
        `[role] ${claim.role}\n[session_date] ${claim.date}\n`
        + `[event_date] ${claim.dateHint}\n[kind] ${claim.kind}\n${claim.text}`,
      sessionId: claim.sessionId,
      date: claim.date,
      startTurn: claim.turnIndex,
      endTurn: claim.turnIndex,
    })),
  );
  const candidates = new Map<string, EvidenceCandidate>();
  const allFacetIds = plan.facets.map((facet) => facet.id);
  const lanes = [{ query: args.space.raw.question, facet_ids: allFacetIds }, ...plan.queries];
  for (const lane of lanes) {
    for (const hit of index.search(lane.query, 30)) {
      const claim = claimById.get(hit.documentId);
      if (!claim) continue;
      let candidate = candidates.get(claim.sessionId);
      if (!candidate) {
        candidate = {
          sessionId: claim.sessionId,
          date: claim.date,
          score: 0,
          excerpts: new Set(),
          facetIds: new Set(),
          matchedTerms: new Set(),
          ranks: [],
        };
        candidates.set(claim.sessionId, candidate);
      }
      candidate.score += 1 / (60 + hit.rank);
      for (const facetId of lane.facet_ids) candidate.facetIds.add(facetId);
      for (const term of hit.matchedTerms) candidate.matchedTerms.add(term);
      candidate.ranks.push({ view: "claim", query: lane.query, rank: hit.rank });
      candidate.excerpts.add(
        `claim role=${claim.role} date=${claim.date || "(unknown)"} `
        + `turn=${String(claim.turnIndex)} kind=${claim.kind}`
        + `${claim.dateHint ? ` event_date=${claim.dateHint}` : ""}: ${clip(claim.text, 300)}`,
      );
      for (const neighbor of claims) {
        if (neighbor.sessionId !== claim.sessionId) continue;
        if (Math.abs(neighbor.turnIndex - claim.turnIndex) > 1) continue;
        candidate.excerpts.add(
          `neighbor role=${neighbor.role} turn=${String(neighbor.turnIndex)}: `
          + clip(neighbor.text, 240),
        );
      }
    }
  }
  const pool = [...candidates.values()]
    .sort(
      (left, right) =>
        right.score - left.score
        || right.facetIds.size - left.facetIds.size
        || left.sessionId.localeCompare(right.sessionId),
    )
    .slice(0, POOL_MAX);
  const verified = await assessCandidates({
    ...args,
    promptName: "hop-ledger-verify-v1",
    plan,
    catalog: candidateCatalog(pool, "claim candidate"),
    usage,
  });
  const modelBag = selectMinimalCover({
    plan,
    candidates: pool,
    assessments: verified.assessments,
  });
  return {
    modelBag,
    modelPool: pool.map((item) => item.sessionId),
    usage,
    trace: [
      { plan, claim_count: claims.length },
      {
        candidate_pool: pool.map((item) => ({
          session_id: item.sessionId,
          score: item.score,
          facet_ids: [...item.facetIds],
          ranks: item.ranks,
        })),
      },
      { assessments: verified.assessments, unresolved: verified.unresolved },
    ],
  };
}

function formatEvidenceLedger(entries: Map<string, EvidenceCandidate>): string {
  if (entries.size === 0) return "(empty)";
  return [...entries.values()]
    .sort((left, right) => right.score - left.score || left.sessionId.localeCompare(right.sessionId))
    .map(
      (entry) =>
        `${entry.sessionId} date=${entry.date || "(unknown)"} `
        + `best_score=${entry.score.toFixed(3)} searched_facets=[${[...entry.facetIds].join(",")}]\n`
        + [...entry.excerpts].slice(0, 4).map((excerpt) => `- ${excerpt}`).join("\n"),
    )
    .join("\n\n");
}

function coverageStatus(
  facets: Facet[],
  coveredCounts: Map<string, number>,
): { covered: string; unresolved: string; unresolvedIds: string[] } {
  const covered: string[] = [];
  const unresolved: string[] = [];
  const unresolvedIds: string[] = [];
  for (const facet of facets) {
    const count = coveredCounts.get(facet.id) ?? 0;
    const line =
      `${facet.id} ${String(count)}/${String(facet.required_evidence_count)} `
      + facet.description;
    if (count >= facet.required_evidence_count) covered.push(line);
    else {
      unresolved.push(line);
      unresolvedIds.push(facet.id);
    }
  }
  return {
    covered: covered.length > 0 ? covered.join("\n") : "(none)",
    unresolved: unresolved.length > 0 ? unresolved.join("\n") : "(none)",
    unresolvedIds,
  };
}

async function runStateful(args: {
  openai: OpenAI;
  prompts: PromptLoader;
  gate: TokenGate;
  model: string;
  reasoning: Reasoning;
  space: CaseSpace;
}): Promise<ArmResult> {
  const usage: Usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
  const plan = await planFacets({ ...args, usage });
  const documents = buildNotesDocuments({
    sessionIds: args.space.opaque.sessionIds,
    datesBySessionId: args.space.opaque.datesBySessionId,
    annotations: args.space.opaque.annotations,
  });
  const index = new Bm25Index(documents);
  const evidence = new Map<string, EvidenceCandidate>();
  const queries: Array<{ query: string; facet_ids: string[]; hits: number }> = [];
  const queryKeys = new Set<string>();
  const bag: string[] = [];
  const bagSet = new Set<string>();
  const facetSessions = new Map<string, Set<string>>();
  const coveredCounts = new Map<string, number>();
  const validFacetIds = new Set(plan.facets.map((facet) => facet.id));
  const trace: unknown[] = [{ plan }];
  let lastToolResults = "(none)";
  let searchHops = 0;
  let turns = 0;
  let done = false;

  while (!done && turns < HOP_BUDGET * 3 + 5) {
    turns += 1;
    const status = coverageStatus(plan.facets, coveredCounts);
    const prompt = await args.prompts.render("hop-stateful-v1", {
      question: args.space.raw.question,
      question_date: args.space.raw.question_date,
      hop_budget: String(HOP_BUDGET),
      bag_max: String(BAG_MAX),
      facets: formatFacets(plan.facets),
      suggested_queries: plan.queries
        .map(
          (lane, indexLane) =>
            `${String(indexLane + 1)}. [${lane.facet_ids.join(",")}] ${lane.query}`,
        )
        .join("\n"),
      search_history: queries.length > 0
        ? queries
          .map(
            (item, indexQuery) =>
              `${String(indexQuery + 1)}. [${item.facet_ids.join(",")}] `
              + `${item.query} -> ${String(item.hits)} hits`,
          )
          .join("\n")
        : "(empty)",
      evidence_ledger: formatEvidenceLedger(evidence),
      covered_facets: status.covered,
      unresolved_facets: status.unresolved,
      bag_sessions: bag.length > 0 ? bag.join("\n") : "(empty)",
      last_tool_results: lastToolResults,
    });
    const inputText = envelopeText(prompt);
    assertNoRawSessionIdLeak(inputText, args.space.rawSessionIds);
    const release = await args.gate.acquire(estimateTokens(inputText) + OUTPUT_RESERVE);
    let response: OpenAIResponse;
    try {
      response = await args.openai.responses.create({
        model: args.model,
        input: prompt.messages,
        tools: STATEFUL_TOOLS,
        tool_choice: "required",
        parallel_tool_calls: false,
        ...(args.reasoning === "none" ? {} : { reasoning: { effort: args.reasoning } }),
      });
      addUsage(usage, response);
    } finally {
      release();
    }
    const toolCall = response.output.find(
      (item): item is Extract<(typeof response.output)[number], { type: "function_call" }> =>
        item.type === "function_call",
    );
    if (!toolCall) {
      trace.push({ turn: turns, error: "no_tool_call" });
      break;
    }
    let toolArgs: Record<string, unknown>;
    try {
      toolArgs = JSON.parse(toolCall.arguments || "{}") as Record<string, unknown>;
    } catch {
      lastToolResults = "error: invalid JSON tool arguments";
      trace.push({ turn: turns, tool: toolCall.name, error: lastToolResults });
      continue;
    }

    if (toolCall.name === "search_notes") {
      if (searchHops >= HOP_BUDGET) {
        lastToolResults = "error: search budget exhausted; add from ledger or finish";
        trace.push({ turn: turns, tool: toolCall.name, args: toolArgs, error: lastToolResults });
        continue;
      }
      const query = typeof toolArgs.query === "string" ? toolArgs.query : "";
      const key = normalizeQuery(query);
      if (!key || queryKeys.has(key)) {
        lastToolResults = "error: duplicate or empty query; use a distinct unresolved facet";
        trace.push({ turn: turns, tool: toolCall.name, args: toolArgs, error: lastToolResults });
        continue;
      }
      const requestedTopK = Number(toolArgs.top_k);
      const topK = [5, 10, 20].includes(requestedTopK) ? requestedTopK : 10;
      const facetIds = Array.isArray(toolArgs.facet_ids)
        ? toolArgs.facet_ids
          .filter((item): item is string => typeof item === "string")
          .filter((id) => validFacetIds.has(id))
        : [];
      queryKeys.add(key);
      searchHops += 1;
      const hits = index.search(query, topK);
      queries.push({ query, facet_ids: facetIds, hits: hits.length });
      for (const hit of hits) {
        let entry = evidence.get(hit.documentId);
        if (!entry) {
          entry = {
            sessionId: hit.documentId,
            date: args.space.dateByOpaqueId.get(hit.documentId) ?? "",
            score: hit.score,
            excerpts: new Set(),
            facetIds: new Set(),
            matchedTerms: new Set(),
            ranks: [],
          };
          evidence.set(hit.documentId, entry);
        }
        entry.score = Math.max(entry.score, hit.score);
        entry.excerpts.add(
          `query="${query}": `
          + bestNoteExcerpt(args.space.opaque.annotations.get(hit.documentId), query),
        );
        for (const facetId of facetIds) entry.facetIds.add(facetId);
        for (const term of hit.matchedTerms) entry.matchedTerms.add(term);
        entry.ranks.push({ view: "notes", query, rank: hit.rank });
      }
      lastToolResults = hits.length === 0
        ? "(no hits)"
        : hits
          .map(
            (hit) =>
              `${String(hit.rank)}. ${hit.documentId} score=${hit.score.toFixed(3)} `
              + `terms=[${hit.matchedTerms.join(",")}]\n`
              + bestNoteExcerpt(args.space.opaque.annotations.get(hit.documentId), query),
          )
          .join("\n\n");
      trace.push({
        turn: turns,
        hop: searchHops,
        tool: toolCall.name,
        args: toolArgs,
        hits: hits.map((hit) => ({
          session_id: hit.documentId,
          rank: hit.rank,
          score: hit.score,
        })),
      });
      continue;
    }

    if (toolCall.name === "add_sessions") {
      const sessionIds = Array.isArray(toolArgs.session_ids)
        ? toolArgs.session_ids.filter((item): item is string => typeof item === "string")
        : [];
      const facetIds = Array.isArray(toolArgs.facet_ids)
        ? toolArgs.facet_ids
          .filter((item): item is string => typeof item === "string")
          .filter((id) => validFacetIds.has(id))
        : [];
      const added: string[] = [];
      for (const sessionId of sessionIds) {
        if (!evidence.has(sessionId) || bagSet.has(sessionId) || bag.length >= BAG_MAX) continue;
        bag.push(sessionId);
        bagSet.add(sessionId);
        added.push(sessionId);
        for (const facetId of facetIds) {
          const sessions = facetSessions.get(facetId) ?? new Set<string>();
          sessions.add(sessionId);
          facetSessions.set(facetId, sessions);
          coveredCounts.set(facetId, sessions.size);
        }
      }
      lastToolResults =
        `added=[${added.join(",")}] bag_size=${String(bag.length)} `
        + `rejected=[${sessionIds.filter((id) => !added.includes(id)).join(",")}]`;
      trace.push({ turn: turns, tool: toolCall.name, args: toolArgs, added });
      continue;
    }

    if (toolCall.name === "done") {
      done = true;
      trace.push({ turn: turns, tool: toolCall.name, args: toolArgs });
      continue;
    }

    lastToolResults = `error: unknown tool ${toolCall.name}`;
    trace.push({ turn: turns, tool: toolCall.name, args: toolArgs, error: lastToolResults });
  }

  return {
    modelBag: bag,
    modelPool: [...evidence.keys()],
    usage,
    trace,
  };
}

function summarize(cases: CaseResult[]): Record<string, unknown> {
  const groups: Record<string, CaseResult[]> = { all: cases };
  for (const item of cases) {
    (groups[item.stratum] ??= []).push(item);
  }
  const byType: Record<string, CaseResult[]> = {};
  for (const item of cases) (byType[item.question_type] ??= []).push(item);
  const one = (list: CaseResult[]): Record<string, number> => ({
    n: list.length,
    full_gold_in_bag: list.filter((item) => item.full_gold_in_bag).length,
    candidate_pool_full_gold: list.filter((item) => item.candidate_pool_full_gold).length,
    mean_gold_recall:
      list.reduce((sum, item) => sum + item.gold_recall, 0) / Math.max(list.length, 1),
    mean_candidate_pool_gold_recall:
      list.reduce((sum, item) => sum + item.candidate_pool_gold_recall, 0)
      / Math.max(list.length, 1),
    mean_bag_size:
      list.reduce((sum, item) => sum + item.bag.length, 0) / Math.max(list.length, 1),
    mean_pool_size:
      list.reduce((sum, item) => sum + item.candidate_pool.length, 0)
      / Math.max(list.length, 1),
    errors: list.filter((item) => item.error).length,
  });
  return {
    ...Object.fromEntries(Object.entries(groups).map(([name, list]) => [name, one(list)])),
    by_question_type: Object.fromEntries(
      Object.entries(byType).sort().map(([name, list]) => [name, one(list)]),
    ),
  };
}

async function main(): Promise<void> {
  loadDotEnv(resolve(PROJECT_ROOT, ".env"));
  const cli = parseArgs(process.argv.slice(2));
  const arm = cli.arm as Arm | undefined;
  if (!arm || !["stateful", "parallel", "hybrid", "ledger"].includes(arm)) {
    throw new Error("--arm must be stateful, parallel, hybrid, or ledger");
  }
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");
  const idsPath = resolve(PROJECT_ROOT, cli.ids ?? DEFAULT_IDS);
  const datasetPath = resolve(PROJECT_ROOT, cli.dataset ?? DEFAULT_DATASET);
  const oraclePath = resolve(PROJECT_ROOT, cli.oracle ?? DEFAULT_ORACLE);
  const annotationsPath = resolve(PROJECT_ROOT, cli.annotations ?? DEFAULT_ANNOTATIONS);
  const concurrency = Number(cli.concurrency ?? "72");
  const tokenBudget = Number(cli["token-budget"] ?? "1800000");
  const windowSeconds = Number(cli["window-seconds"] ?? "60");
  const model = cli.model ?? "gpt-5.6-luna";
  const reasoning = (cli.reasoning ?? "low") as Reasoning;
  const limit = cli.limit ? Number(cli.limit) : undefined;
  const outPath = resolve(
    PROJECT_ROOT,
    cli.out ?? `runs/local-archive/backbone/hop-screen90-${arm}-v1.json`,
  );

  const slice = JSON.parse(readFileSync(idsPath, "utf8")) as Slice;
  const selected = limit === undefined ? slice.cases : slice.cases.slice(0, limit);
  const dataset = JSON.parse(readFileSync(datasetPath, "utf8")) as RawCase[];
  const oracle = JSON.parse(readFileSync(oraclePath, "utf8")) as Array<{
    question_id: string;
    answer_session_ids: string[];
  }>;
  const byId = new Map(dataset.map((item) => [item.question_id, item]));
  const goldById = new Map(oracle.map((item) => [item.question_id, item.answer_session_ids]));
  const annotations = loadAnnotations(annotationsPath);
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 2 });
  const prompts = new PromptLoader();
  const gate = new TokenGate(tokenBudget, windowSeconds, concurrency);
  const results = Array<CaseResult | undefined>(selected.length);
  let cursor = 0;
  const started = Date.now();

  console.log(
    `hop-architecture-screen arm=${arm} cases=${String(selected.length)} `
    + `model=${model} reasoning=${reasoning} concurrency=${String(concurrency)} `
    + `token_budget=${String(tokenBudget)}`,
  );

  async function runOne(indexCase: number, sliceCase: SliceCase): Promise<void> {
    const raw = byId.get(sliceCase.question_id);
    const goldReal = goldById.get(sliceCase.question_id) ?? [];
    const caseStarted = Date.now();
    if (!raw) {
      results[indexCase] = {
        question_id: sliceCase.question_id,
        stratum: sliceCase.stratum,
        question_type: sliceCase.question_type,
        gold: goldReal,
        bag: [],
        model_bag: [],
        candidate_pool: [],
        full_gold_in_bag: false,
        candidate_pool_full_gold: false,
        gold_recall: 0,
        candidate_pool_gold_recall: 0,
        input_tokens: 0,
        output_tokens: 0,
        api_calls: 0,
        elapsed_ms: 0,
        trace: [],
        error: "missing dataset case",
      };
      return;
    }
    const space = buildCaseSpace({ raw, goldReal, annotations });
    try {
      const armResult = arm === "stateful"
        ? await runStateful({ openai, prompts, gate, model, reasoning, space })
        : arm === "parallel"
          ? await runParallel({ openai, prompts, gate, model, reasoning, space })
          : arm === "hybrid"
            ? await runHybrid({ openai, prompts, gate, model, reasoning, space })
            : await runLedger({ openai, prompts, gate, model, reasoning, space });
      const bag = armResult.modelBag.flatMap((id) => {
        const realId = space.opaque.opaqueToReal.get(id);
        return realId ? [realId] : [];
      });
      const pool = armResult.modelPool.flatMap((id) => {
        const realId = space.opaque.opaqueToReal.get(id);
        return realId ? [realId] : [];
      });
      results[indexCase] = {
        question_id: sliceCase.question_id,
        stratum: sliceCase.stratum,
        question_type: sliceCase.question_type,
        gold: goldReal,
        bag,
        model_bag: armResult.modelBag,
        candidate_pool: pool,
        full_gold_in_bag: fullGoldIn(bag, goldReal),
        candidate_pool_full_gold: fullGoldIn(pool, goldReal),
        gold_recall: recall(bag, goldReal),
        candidate_pool_gold_recall: recall(pool, goldReal),
        input_tokens: armResult.usage.inputTokens,
        output_tokens: armResult.usage.outputTokens,
        api_calls: armResult.usage.calls,
        elapsed_ms: Date.now() - caseStarted,
        trace: armResult.trace,
      };
    } catch (error) {
      results[indexCase] = {
        question_id: sliceCase.question_id,
        stratum: sliceCase.stratum,
        question_type: sliceCase.question_type,
        gold: goldReal,
        bag: [],
        model_bag: [],
        candidate_pool: [],
        full_gold_in_bag: false,
        candidate_pool_full_gold: false,
        gold_recall: 0,
        candidate_pool_gold_recall: 0,
        input_tokens: 0,
        output_tokens: 0,
        api_calls: 0,
        elapsed_ms: Date.now() - caseStarted,
        trace: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function worker(): Promise<void> {
    while (cursor < selected.length) {
      const indexCase = cursor;
      cursor += 1;
      const sliceCase = selected[indexCase];
      if (!sliceCase) continue;
      await runOne(indexCase, sliceCase);
      const done = results.filter((item) => item !== undefined).length;
      if (done % 5 === 0 || done === selected.length) {
        console.log(
          `progress ${String(done)}/${String(selected.length)} `
          + `${((Date.now() - started) / 1_000).toFixed(0)}s`,
        );
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, Math.max(selected.length, 1)) },
      () => worker(),
    ),
  );
  const finished = results.filter((item): item is CaseResult => item !== undefined);
  const inputTokens = finished.reduce((sum, item) => sum + item.input_tokens, 0);
  const outputTokens = finished.reduce((sum, item) => sum + item.output_tokens, 0);
  const payload = {
    created_at: new Date().toISOString(),
    arm,
    ids_path: idsPath,
    model,
    reasoning,
    bag_max: BAG_MAX,
    pool_max: POOL_MAX,
    session_id_visibility: "opaque_per_case_v1",
    rate_limit: {
      concurrency,
      token_budget: tokenBudget,
      window_seconds: windowSeconds,
    },
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      api_calls: finished.reduce((sum, item) => sum + item.api_calls, 0),
      estimated_cost_usd:
        (inputTokens * LUNA_INPUT_PRICE + outputTokens * LUNA_OUTPUT_PRICE) / 1_000_000,
      elapsed_ms: Date.now() - started,
    },
    aggregate: summarize(finished),
    cases: finished,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`wrote ${outPath}`);
  console.log(JSON.stringify({ usage: payload.usage, aggregate: payload.aggregate }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
