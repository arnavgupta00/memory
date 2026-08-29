import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import OpenAI from "openai";

import { renderAnswerPrompt } from "../answer/renderAnswerPrompt.js";
import { loadArchitectureCases } from "../benchmarks/architectureDataset.js";
import { buildDiscoveryUnion, type DiscoveryUnion } from "../compression/beamCompression.js";
import {
  type RawEvidencePackage,
} from "../compression/beamCompressionAlternatives.js";
import {
  CostBudget,
  DispatchGate,
  callStructured,
  estimateInputTokens,
  loadDotEnv,
  mapPool,
  type StructuredCallResult,
} from "../compression/structuredCall.js";
import { DEFAULT_RETRIEVAL_OPTIONS, type RetrievalResult } from "../retrieval/types.js";
import { PromptLoader } from "../services/promptLoader.js";
import {
  AnswerOutputSchema,
  UNAVAILABLE_MEMORY_HYPOTHESIS,
  type ContextPackage,
  type ContextPackageItem,
} from "../types.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const DEFAULT_DATASET = resolve(
  PROJECT_ROOT,
  "runs/beam-1m-canary-a-architecture-0008-20260731-r2/input/dataset.json",
);
const DEFAULT_TRACE = resolve(
  PROJECT_ROOT,
  "runs/beam-1m-recall-gate-0008.4-20260802/full-balanced.json",
);
const DEFAULT_RETRY = resolve(
  PROJECT_ROOT,
  "runs/beam-1m-recall-gate-0008.4-20260802/full-balanced-retry7.json",
);
const DEFAULT_IDS = resolve(
  PROJECT_ROOT,
  "src/agents/current/eval-slices/beam-1m/beam-1m-compression-answer-ab8-v1.json",
);
const DEFAULT_EXPLORER = resolve(
  PROJECT_ROOT,
  "runs/beam-1m-compression-answer-ab8-20260809/compression/coverage-explorer",
);
const DEFAULT_OUT = resolve(PROJECT_ROOT, "runs/beam-1m-compression-answer-ab8-20260809/answers");
const MODEL = "gpt-5.6-luna";
const MAX_OUTPUT_TOKENS = 64_000;
const ARMS = ["raw-union", "coverage-explorer"] as const;
type TraceCase = { question_id: string; trace?: Array<Record<string, unknown>> };
type TraceRun = { cases: TraceCase[] };
type Manifest = { question_ids: string[] };

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

function safeName(value: string): string {
  return value.replaceAll("/", "__");
}

function inferShape(question: string): ContextPackage["queryShape"] {
  const normalized = question.toLowerCase();
  if (/\b(how long|before|after|first|last|earliest|latest|chronolog|in what order|when did)\b/.test(normalized)) {
    return "order";
  }
  if (/\b(how many|total|sum|combined|altogether|list all|which .* most|what .* did i|compare|summary|summarize)\b/.test(normalized)) {
    return "aggregate";
  }
  if (/\b(now|currently|changed|change in|updated|used to|previously|compared with|compared to)\b/.test(normalized)) {
    return "update-conflict";
  }
  return "lookup";
}

function emptyRetrieval(): RetrievalResult {
  return {
    windows: [],
    ranked: [],
    spans: [],
    characterCount: 0,
    estimatedTokens: 0,
    options: DEFAULT_RETRIEVAL_OPTIONS,
  };
}

function packageFromItems(args: {
  question: string;
  items: ContextPackageItem[];
  setBoundary: string;
  missingRisk: string;
}): ContextPackage {
  const items = [...args.items].sort(
    (left, right) =>
      left.date.localeCompare(right.date)
      || left.sessionId.localeCompare(right.sessionId)
      || left.turnIndex - right.turnIndex,
  );
  const characterCount = items.reduce((sum, item) => sum + item.text.length, 0);
  return {
    queryShape: inferShape(args.question),
    setBoundary: args.setBoundary,
    candidateStatus: items.length > 0 ? "found" : "none_found",
    missingRisk: args.missingRisk,
    items,
    characterCount,
    estimatedTokens: Math.ceil(characterCount / 4),
  };
}

function rawUnionPackage(question: string, discovery: DiscoveryUnion): ContextPackage {
  return packageFromItems({
    question,
    setBoundary: "all raw turns from every session in the complete discovery union",
    missingRisk: "upstream discovery may omit required evidence; no discovered session or turn was deleted",
    items: discovery.sessions.flatMap((session) =>
      session.turns.map((turn, turnIndex): ContextPackageItem => ({
        sessionId: session.opaqueSessionId,
        turnIndex,
        date: session.date,
        role: turn.role,
        text: turn.content,
        why: "raw turn retained from the complete discovery union",
        tier: "selected",
      })),
    ),
  });
}

function explorerPackage(question: string, source: RawEvidencePackage): ContextPackage {
  const seen = new Set<string>();
  const items: ContextPackageItem[] = [];
  for (const segment of source.segments) {
    for (let offset = 0; offset < segment.turns.length; offset += 1) {
      const turn = segment.turns[offset];
      if (!turn) continue;
      const turnIndex = segment.turnStart + offset;
      const key = `${segment.sessionId}:${String(turnIndex)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        sessionId: segment.sessionId,
        turnIndex,
        date: segment.date,
        role: turn.role,
        text: turn.content,
        why: "raw source turn retained by the coverage explorer",
        tier: "selected",
      });
    }
  }
  return packageFromItems({
    question,
    setBoundary: "losslessly rehydrated raw turns selected by the coverage explorer",
    missingRisk: "upstream discovery or coverage exploration may omit required evidence",
    items,
  });
}

function representedSessions(pkg: ContextPackage): number {
  return new Set(pkg.items.map((item) => item.sessionId)).size;
}

function callArtifact<T>(call: StructuredCallResult<T>): Record<string, unknown> {
  return {
    value: call.value,
    outputText: call.outputText,
    usage: call.usage,
    latencyMs: call.latencyMs,
    requestId: call.requestId,
    retryCount: call.retryCount,
    inputSha256: call.inputSha256,
    estimatedCostUsd: call.estimatedCostUsd,
    promptMessages: call.promptMessages,
  };
}

async function main(): Promise<void> {
  loadDotEnv(resolve(PROJECT_ROOT, ".env"));
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");
  const argv = parseArgs(process.argv.slice(2));
  const datasetPath = projectPath(argv.dataset, DEFAULT_DATASET);
  const tracePath = projectPath(argv.trace, DEFAULT_TRACE);
  const retryPath = projectPath(argv.retry, DEFAULT_RETRY);
  const idsPath = projectPath(argv.ids, DEFAULT_IDS);
  const explorerRoot = projectPath(argv.explorer, DEFAULT_EXPLORER);
  const outDir = projectPath(argv.out, DEFAULT_OUT);
  const concurrency = Number(argv.concurrency ?? 8);
  const tokenBudget = Number(argv["token-budget"] ?? 1_900_000);
  const expectedCases = Number(argv["expected-cases"] ?? 8);
  if (!Number.isInteger(expectedCases) || expectedCases < 1) throw new Error("--expected-cases must be positive");

  const rawCases = loadArchitectureCases(datasetPath);
  const rawById = new Map(rawCases.map((item) => [item.question_id, item]));
  const base = JSON.parse(readFileSync(tracePath, "utf8")) as TraceRun;
  const retry = JSON.parse(readFileSync(retryPath, "utf8")) as TraceRun;
  const traceById = new Map(base.cases.map((item) => [item.question_id, item]));
  for (const item of retry.cases) traceById.set(item.question_id, item);
  const manifest = JSON.parse(readFileSync(idsPath, "utf8")) as Manifest;
  if (manifest.question_ids.length !== expectedCases) {
    throw new Error(`expected ${String(expectedCases)} questions; found ${String(manifest.question_ids.length)}`);
  }
  const inputs = manifest.question_ids.map((questionId) => {
    const raw = rawById.get(questionId);
    const trace = traceById.get(questionId);
    if (!raw || !trace) throw new Error(`missing input for ${questionId}`);
    return { raw, discovery: buildDiscoveryUnion(raw, trace) };
  });

  mkdirSync(outDir, { recursive: true });
  const prompts = new PromptLoader();
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const dispatch = new DispatchGate(tokenBudget, 60, concurrency);
  const costBudget = new CostBudget(1_000_000);
  const tasks = inputs.flatMap((item, caseIndex) =>
    ARMS.map((arm, armIndex) => ({ item, arm, order: caseIndex * ARMS.length + ((caseIndex + armIndex) % ARMS.length) })),
  ).sort((left, right) => left.order - right.order);

  const rows = await mapPool(tasks, concurrency, async ({ item, arm }) => {
    const questionId = item.raw.question_id;
    const caseName = safeName(questionId);
    const caseDir = resolve(outDir, arm, "cases", caseName);
    mkdirSync(caseDir, { recursive: true });
    const pkg = arm === "raw-union"
      ? rawUnionPackage(item.raw.question, item.discovery)
      : explorerPackage(
        item.raw.question,
        JSON.parse(readFileSync(
          resolve(explorerRoot, "cases", caseName, "raw-evidence-package.json"),
          "utf8",
        )) as RawEvidencePackage,
      );
    const prompt = await renderAnswerPrompt({
      question: item.raw.question,
      questionDate: item.raw.question_date,
      retrieval: emptyRetrieval(),
      contextPackage: pkg,
      promptName: "answer-v8-preference",
    }, prompts);
    const contextMetrics = {
      question_id: questionId,
      ability: item.raw.question_type,
      arm,
      discovery_sessions: item.discovery.sessions.length,
      represented_sessions: representedSessions(pkg),
      context_items: pkg.items.length,
      context_characters: pkg.characterCount,
      context_estimated_tokens: pkg.estimatedTokens,
      final_prompt_estimated_input_tokens: estimateInputTokens(prompt),
    };
    writeFileSync(resolve(caseDir, "context-package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    writeFileSync(resolve(caseDir, "context-metrics.json"), `${JSON.stringify(contextMetrics, null, 2)}\n`);

    const callPath = resolve(caseDir, "answer.call.json");
    let call: StructuredCallResult<ReturnType<typeof AnswerOutputSchema.parse>>;
    if (existsSync(callPath)) {
      const stored = JSON.parse(readFileSync(callPath, "utf8")) as StructuredCallResult<unknown>;
      call = { ...stored, value: AnswerOutputSchema.parse(stored.value) };
    } else {
      call = await callStructured({
        openai,
        dispatch,
        costBudget,
        model: MODEL,
        reasoning: "high",
        prompt,
        schema: AnswerOutputSchema,
        schemaName: "beam_compression_answer_ab_v1",
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        rawSessionIdsForLeakCheck: item.raw.haystack_session_ids,
        promptCache: false,
      });
      writeFileSync(callPath, `${JSON.stringify(callArtifact(call), null, 2)}\n`);
    }
    const hypothesis = call.value.supportStatus === "insufficient" && !call.value.hypothesis.trim()
      ? UNAVAILABLE_MEMORY_HYPOTHESIS
      : call.value.hypothesis;
    const row = {
      ...contextMetrics,
      hypothesis,
      support_status: call.value.supportStatus,
      answer_usage: call.usage,
      answer_cost_usd: call.estimatedCostUsd,
      answer_latency_ms: call.latencyMs,
      answer_request_id: call.requestId,
    };
    writeFileSync(resolve(caseDir, "result.json"), `${JSON.stringify(row, null, 2)}\n`);
    console.log(JSON.stringify({
      event: "beam_compression_answer_complete",
      arm,
      question_id: questionId,
      represented_sessions: contextMetrics.represented_sessions,
      prompt_tokens: call.usage.input_tokens,
    }));
    return row;
  });

  for (const arm of ARMS) {
    const armRows = rows.filter((row) => row.arm === arm);
    writeFileSync(
      resolve(outDir, `predictions-${arm}.jsonl`),
      `${armRows.map((row) => JSON.stringify({ question_id: row.question_id, hypothesis: row.hypothesis })).join("\n")}\n`,
    );
  }
  const summary = {
    schema_version: 1,
    benchmark: "BEAM",
    tier: "1M",
    cohort: idsPath,
    answer_model: MODEL,
    answer_reasoning: "high",
    arms: ARMS.map((arm) => {
      const armRows = rows.filter((row) => row.arm === arm);
      const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
      return {
        arm,
        questions: armRows.length,
        mean_discovery_sessions: mean(armRows.map((row) => row.discovery_sessions)),
        mean_represented_sessions: mean(armRows.map((row) => row.represented_sessions)),
        mean_context_items: mean(armRows.map((row) => row.context_items)),
        mean_context_estimated_tokens: mean(armRows.map((row) => row.context_estimated_tokens)),
        mean_actual_answer_input_tokens: mean(armRows.map((row) => row.answer_usage.input_tokens ?? 0)),
        total_answer_cost_usd: armRows.reduce((sum, row) => sum + row.answer_cost_usd, 0),
      };
    }),
    cases: rows,
  };
  writeFileSync(resolve(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
