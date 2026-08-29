import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import OpenAI from "openai";

import {
  CompressionPlanSchema,
  CompressionWorkerSchema,
  buildDiscoveryUnion,
  compressionPlanHash,
  evaluateCompressionCoverage,
  formatDiscoverySessions,
  formatWorkerSessions,
  reduceCompressionClaims,
  type CompressionPlan,
  type CompressionWorkerOutput,
  type DiscoveryUnion,
  type RecertifiedOracleEntry,
  type ReducedCompressionPackage,
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
import { loadArchitectureCases } from "../benchmarks/architectureDataset.js";
import { PromptLoader } from "../services/promptLoader.js";

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
const DEFAULT_SMOKE = resolve(
  PROJECT_ROOT,
  "src/agents/current/eval-slices/beam-1m/beam-1m-compression-smoke12-v1.json",
);
const DEFAULT_ORACLE = resolve(
  PROJECT_ROOT,
  "runs/beam-1m-compression-oracle-recertification-20260808/oracle-recertified-v1.json",
);
const DEFAULT_OUT = resolve(
  PROJECT_ROOT,
  "runs/beam-1m-compression-smoke12-20260808",
);
const DEFAULT_PLANNER_MODEL = "gpt-5.6-luna";
const DEFAULT_WORKER_MODEL = "gpt-5.4-nano-2026-03-17";

type TraceCase = {
  question_id: string;
  trace?: Array<Record<string, unknown>>;
};
type TraceRun = { cases: TraceCase[] };
type SmokeManifest = { question_ids: string[] };
type OracleFile = { entries: RecertifiedOracleEntry[] };
type PlannerRun = {
  question_id: string;
  reasoning: ReasoningEffort;
  plan: CompressionPlan;
  call: StructuredCallResult<CompressionPlan>;
};
type WorkerBatchRun = {
  batch_index: number;
  session_ids: string[];
  output: CompressionWorkerOutput;
  call: StructuredCallResult<CompressionWorkerOutput>;
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

function parseReasoningList(value: string): ReasoningEffort[] {
  const efforts = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (efforts.length === 0 || efforts.some((item) => !["low", "medium", "high"].includes(item))) {
    throw new Error("--planner-reasoning must contain low, medium, or high");
  }
  return [...new Set(efforts)] as ReasoningEffort[];
}

function projectPath(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  return isAbsolute(value) ? value : resolve(PROJECT_ROOT, value);
}

function safeName(questionId: string): string {
  return questionId.replaceAll("/", "__");
}

function batch<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
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
    estimatedCostUsd: call.estimatedCostUsd,
    promptMessages: call.promptMessages,
  };
}

function loadPlanner(path: string): PlannerRun {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    question_id: string;
    reasoning: ReasoningEffort;
    plan: CompressionPlan;
    call: StructuredCallResult<CompressionPlan>;
  };
  return { ...parsed, plan: CompressionPlanSchema.parse(parsed.plan) };
}

function loadWorkerJsonl(path: string): WorkerBatchRun[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    const parsed = JSON.parse(line) as WorkerBatchRun;
    return [{ ...parsed, output: CompressionWorkerSchema.parse(parsed.output) }];
  });
}

function sumUsage(calls: Array<{ usage: TokenUsage; estimatedCostUsd: number; latencyMs: number }>): {
    input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
    output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  cost_usd: number;
  latency_ms_sum: number;
} {
  return calls.reduce((total, call) => ({
    input_tokens: total.input_tokens + (call.usage.input_tokens ?? 0),
    cached_input_tokens: total.cached_input_tokens + (call.usage.cached_input_tokens ?? 0),
    cache_write_tokens: total.cache_write_tokens + (call.usage.cache_write_tokens ?? 0),
    output_tokens: total.output_tokens + (call.usage.output_tokens ?? 0),
    reasoning_tokens: total.reasoning_tokens + (call.usage.reasoning_tokens ?? 0),
    total_tokens: total.total_tokens + (call.usage.total_tokens ?? 0),
    cost_usd: total.cost_usd + call.estimatedCostUsd,
    latency_ms_sum: total.latency_ms_sum + call.latencyMs,
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

function discoveryCeiling(discovery: DiscoveryUnion, oracle: RecertifiedOracleEntry): {
  covered_atoms: number;
  total_atoms: number;
  atom_recall: number;
  full_story: boolean;
} {
  const sessions = new Set(discovery.sessions.map((session) => session.realSessionId));
  const covered = oracle.evidence_atoms.filter((atom) =>
    atom.sources.some((source) => sessions.has(source.session_id)),
  ).length;
  return {
    covered_atoms: covered,
    total_atoms: oracle.evidence_atoms.length,
    atom_recall: oracle.evidence_atoms.length === 0 ? 1 : covered / oracle.evidence_atoms.length,
    full_story: covered === oracle.evidence_atoms.length,
  };
}

function packageOutput(pkg: ReducedCompressionPackage): Record<string, unknown> {
  return {
    schema_version: 1,
    policy: "lossless_source_validation_no_semantic_ranking_no_top_k",
    claims: pkg.claims,
    rejected_claims: pkg.rejectedClaims,
    represented_real_session_ids: pkg.representedRealSessionIds,
    covered_facet_ids: pkg.coveredFacetIds,
    uncovered_must_facet_ids: pkg.uncoveredMustFacetIds,
    character_count: pkg.characterCount,
    estimated_tokens: pkg.estimatedTokens,
  };
}

async function main(): Promise<void> {
  loadDotEnv(resolve(PROJECT_ROOT, ".env"));
  const args = parseArgs(process.argv.slice(2));
  const datasetPath = projectPath(args.dataset, DEFAULT_DATASET);
  const tracePath = projectPath(args.trace, DEFAULT_TRACE);
  const retryPath = projectPath(args.retry, DEFAULT_RETRY);
  const smokePath = projectPath(args.ids, DEFAULT_SMOKE);
  const oraclePath = projectPath(args.oracle, DEFAULT_ORACLE);
  const outDir = projectPath(args.out, DEFAULT_OUT);
  const plannerModel = args["planner-model"] ?? DEFAULT_PLANNER_MODEL;
  const workerModel = args["worker-model"] ?? DEFAULT_WORKER_MODEL;
  const plannerReasonings = parseReasoningList(args["planner-reasoning"] ?? "medium,high");
  const workerReasoning = (args["worker-reasoning"] ?? "low") as ReasoningEffort;
  const workerBatchSize = Number(args["worker-batch-size"] ?? 1);
  const plannerConcurrency = Number(args["planner-concurrency"] ?? 2);
  const workerConcurrency = Number(args["worker-concurrency"] ?? 128);
  const tokenBudget = Number(args["token-budget"] ?? 1_900_000);
  const maxCost = Number(args["max-cost"] ?? 7.5);
  const plannerMaxOutput = Number(args["planner-max-output"] ?? 8_000);
  const workerMaxOutput = Number(args["worker-max-output"] ?? Math.max(3_000, workerBatchSize * 2_000));
  const plannersOnly = args["planners-only"] === "true";
  if (![1, 4, 8].includes(workerBatchSize)) throw new Error("worker batch size must be 1, 4, or 8");

  const rawCases = loadArchitectureCases(datasetPath);
  const rawById = new Map(rawCases.map((item) => [item.question_id, item]));
  const trace = JSON.parse(readFileSync(tracePath, "utf8")) as TraceRun;
  const retry = JSON.parse(readFileSync(retryPath, "utf8")) as TraceRun;
  const traceById = new Map(trace.cases.map((item) => [item.question_id, item]));
  for (const item of retry.cases) traceById.set(item.question_id, item);
  const smoke = JSON.parse(readFileSync(smokePath, "utf8")) as SmokeManifest;
  const oracleFile = JSON.parse(readFileSync(oraclePath, "utf8")) as OracleFile;
  const oracleById = new Map(oracleFile.entries.map((entry) => [entry.question_id, entry]));
  const cases = smoke.question_ids.map((questionId) => {
    const raw = rawById.get(questionId);
    const traced = traceById.get(questionId);
    const oracle = oracleById.get(questionId);
    if (!raw || !traced || !oracle) throw new Error(`missing smoke input for ${questionId}`);
    if (oracle.status !== "certified") throw new Error(`oracle is not certified for ${questionId}`);
    return { raw, discovery: buildDiscoveryUnion(raw, traced), oracle };
  });

  mkdirSync(outDir, { recursive: true });
  const preflight = {
    schema_version: 1,
    questions: cases.length,
    planner_model: plannerModel,
    planner_reasonings: plannerReasonings,
    worker_model: workerModel,
    worker_reasoning: workerReasoning,
    worker_batch_size: workerBatchSize,
    deterministic_policy: "validation_and_lossless_assembly_only",
    total_discovery_sessions: cases.reduce((sum, item) => sum + item.discovery.sessions.length, 0),
    mean_discovery_sessions: cases.reduce((sum, item) => sum + item.discovery.sessions.length, 0) / cases.length,
    total_discovery_characters: cases.reduce((sum, item) => sum + item.discovery.sessions.reduce(
      (caseSum, session) => caseSum + session.turns.reduce((sessionSum, turn) => sessionSum + turn.content.length, 0),
      0,
    ), 0),
    discovery_ceiling: cases.map((item) => ({
      question_id: item.raw.question_id,
      sessions: item.discovery.sessions.length,
      ...discoveryCeiling(item.discovery, item.oracle),
    })),
  };
  writeFileSync(resolve(outDir, "preflight.json"), `${JSON.stringify(preflight, null, 2)}\n`);

  const prompts = new PromptLoader();
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const dispatch = new DispatchGate(tokenBudget, 60, Math.max(plannerConcurrency, workerConcurrency));
  const costBudget = new CostBudget(maxCost);
  const configurationRows: Array<Record<string, unknown>> = [];

  for (const plannerReasoning of plannerReasonings) {
    const configName = `luna-${plannerReasoning}-nano-${workerReasoning}-b${String(workerBatchSize)}`;
    const configDir = resolve(outDir, configName);
    mkdirSync(configDir, { recursive: true });

    const plannerRuns = await mapPool(cases, plannerConcurrency, async (item) => {
      const caseDir = resolve(configDir, "cases", safeName(item.raw.question_id));
      mkdirSync(caseDir, { recursive: true });
      const plannerPath = resolve(caseDir, "planner.json");
      if (existsSync(plannerPath)) return loadPlanner(plannerPath);
      const prompt = await prompts.render("beam-compression-plan-v1", {
        question: item.raw.question,
        question_date: item.raw.question_date,
        discovery_sessions: formatDiscoverySessions(item.discovery.sessions),
      });
      const call = await callStructured({
        openai,
        dispatch,
        costBudget,
        model: plannerModel,
        reasoning: plannerReasoning,
        prompt,
        schema: CompressionPlanSchema,
        schemaName: "beam_compression_plan_v1",
        maxOutputTokens: plannerMaxOutput,
        rawSessionIdsForLeakCheck: item.discovery.rawSessionIds,
      });
      const run: PlannerRun = {
        question_id: item.raw.question_id,
        reasoning: plannerReasoning,
        plan: call.value,
        call,
      };
      writeFileSync(plannerPath, `${JSON.stringify({
        question_id: run.question_id,
        reasoning: run.reasoning,
        plan: run.plan,
        plan_sha256: compressionPlanHash(run.plan),
        call: callJson(call),
      }, null, 2)}\n`);
      console.log(JSON.stringify({
        event: "compression_planner_complete",
        config: configName,
        question_id: item.raw.question_id,
        facets: run.plan.evidenceFacets.length,
        branches: run.plan.storyBranches.length,
        cost: costBudget.snapshot(),
      }));
      return run;
    });
    const planById = new Map(plannerRuns.map((run) => [run.question_id, run]));
    if (plannersOnly) {
      configurationRows.push({
        schema_version: 1,
        config: configName,
        status: "planner_complete_workers_not_started",
        questions: plannerRuns.length,
        planner_usage: sumUsage(plannerRuns.map((run) => run.call)),
      });
      continue;
    }

    const caseResults = await mapPool(cases, Math.min(cases.length, 12), async (item) => {
      const planner = planById.get(item.raw.question_id);
      if (!planner) throw new Error(`missing plan ${item.raw.question_id}`);
      const caseDir = resolve(configDir, "cases", safeName(item.raw.question_id));
      const workersPath = resolve(caseDir, "workers.jsonl");
      const sessionBatches = batch(item.discovery.sessions, workerBatchSize);
      const existing = loadWorkerJsonl(workersPath);
      const existingByIndex = new Map(existing.map((run) => [run.batch_index, run]));
      const missing = sessionBatches.map((sessions, batchIndex) => ({ sessions, batchIndex }))
        .filter((entry) => !existingByIndex.has(entry.batchIndex));
      const completed = await mapPool(missing, workerConcurrency, async ({ sessions, batchIndex }) => {
        const prompt = await prompts.render("beam-compression-worker-v1", {
          question: item.raw.question,
          question_date: item.raw.question_date,
          compression_plan: JSON.stringify(planner.plan),
          worker_sessions: formatWorkerSessions(sessions),
        });
        const call = await callStructured({
          openai,
          dispatch,
          costBudget,
          model: workerModel,
          reasoning: workerReasoning,
          prompt,
          schema: CompressionWorkerSchema,
          schemaName: "beam_compression_worker_v1",
          maxOutputTokens: workerMaxOutput,
          rawSessionIdsForLeakCheck: item.discovery.rawSessionIds,
        });
        const run: WorkerBatchRun = {
          batch_index: batchIndex,
          session_ids: sessions.map((session) => session.opaqueSessionId),
          output: call.value,
          call,
        };
        appendFileSync(workersPath, `${JSON.stringify({
          batch_index: run.batch_index,
          session_ids: run.session_ids,
          output: run.output,
          call: callJson(call),
        })}\n`);
        return run;
      });
      const workerRuns = [...existing, ...completed].sort((left, right) => left.batch_index - right.batch_index);
      if (workerRuns.length !== sessionBatches.length) {
        throw new Error(`${item.raw.question_id} has incomplete worker outputs`);
      }
      const pkg = reduceCompressionClaims({
        plan: planner.plan,
        discovery: item.discovery,
        workerOutputs: workerRuns.map((run) => run.output),
      });
      const coverage = evaluateCompressionCoverage(pkg, item.oracle);
      const rawCharacters = item.discovery.sessions.reduce((sum, session) =>
        sum + session.turns.reduce((turnSum, turn) => turnSum + turn.content.length, 0),
      0);
      const metrics = {
        question_id: item.raw.question_id,
        ability: item.raw.question_type,
        discovery_sessions: item.discovery.sessions.length,
        discovery_raw_characters: rawCharacters,
        discovery_estimated_tokens: Math.ceil(rawCharacters / 4),
        discovery_ceiling: discoveryCeiling(item.discovery, item.oracle),
        extracted_claims: pkg.claims.length,
        represented_sessions: pkg.representedRealSessionIds.length,
        rejected_claims: pkg.rejectedClaims.length,
        uncovered_must_facets: pkg.uncoveredMustFacetIds,
        compressed_characters: pkg.characterCount,
        compressed_estimated_tokens: pkg.estimatedTokens,
        compression_ratio: pkg.characterCount === 0 ? null : rawCharacters / pkg.characterCount,
        coverage,
        planner_usage: sumUsage([planner.call]),
        worker_usage: sumUsage(workerRuns.map((run) => run.call)),
      };
      writeFileSync(resolve(caseDir, "compressed-package.json"), `${JSON.stringify(packageOutput(pkg), null, 2)}\n`);
      writeFileSync(resolve(caseDir, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
      console.log(JSON.stringify({
        event: "compression_case_complete",
        config: configName,
        question_id: item.raw.question_id,
        full_story: coverage.fullStory,
        atom_recall: coverage.atomRecall,
        compression_ratio: metrics.compression_ratio,
        cost: costBudget.snapshot(),
      }));
      return metrics;
    });

    const totalAtoms = caseResults.reduce((sum, row) => sum + row.coverage.totalAtoms, 0);
    const coveredAtoms = caseResults.reduce((sum, row) => sum + row.coverage.coveredAtoms, 0);
    const discoveryAtoms = caseResults.reduce((sum, row) => sum + row.discovery_ceiling.covered_atoms, 0);
    const plannerUsage = sumUsage(plannerRuns.map((run) => run.call));
    const workerUsage = caseResults.reduce((total, row) => ({
      input_tokens: total.input_tokens + row.worker_usage.input_tokens,
      cached_input_tokens: total.cached_input_tokens + row.worker_usage.cached_input_tokens,
      cache_write_tokens: total.cache_write_tokens + row.worker_usage.cache_write_tokens,
      output_tokens: total.output_tokens + row.worker_usage.output_tokens,
      reasoning_tokens: total.reasoning_tokens + row.worker_usage.reasoning_tokens,
      total_tokens: total.total_tokens + row.worker_usage.total_tokens,
      cost_usd: total.cost_usd + row.worker_usage.cost_usd,
      latency_ms_sum: total.latency_ms_sum + row.worker_usage.latency_ms_sum,
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
    const rawCharacters = caseResults.reduce((sum, row) => sum + row.discovery_raw_characters, 0);
    const compressedCharacters = caseResults.reduce((sum, row) => sum + row.compressed_characters, 0);
    const summary = {
      schema_version: 1,
      config: configName,
      questions: caseResults.length,
      planner_model: plannerModel,
      planner_reasoning: plannerReasoning,
      worker_model: workerModel,
      worker_reasoning: workerReasoning,
      worker_batch_size: workerBatchSize,
      discovery_atom_recall: totalAtoms === 0 ? 1 : discoveryAtoms / totalAtoms,
      discovery_full_story: caseResults.filter((row) => row.discovery_ceiling.full_story).length,
      compressed_atom_recall: totalAtoms === 0 ? 1 : coveredAtoms / totalAtoms,
      compressed_full_story: caseResults.filter((row) => row.coverage.fullStory).length,
      total_atoms: totalAtoms,
      covered_atoms: coveredAtoms,
      mean_discovery_sessions: caseResults.reduce((sum, row) => sum + row.discovery_sessions, 0) / caseResults.length,
      mean_represented_sessions: caseResults.reduce((sum, row) => sum + row.represented_sessions, 0) / caseResults.length,
      total_extracted_claims: caseResults.reduce((sum, row) => sum + row.extracted_claims, 0),
      total_rejected_claims: caseResults.reduce((sum, row) => sum + row.rejected_claims, 0),
      compression_ratio: compressedCharacters === 0 ? null : rawCharacters / compressedCharacters,
      planner_usage: plannerUsage,
      worker_usage: workerUsage,
      cases: caseResults,
    };
    writeFileSync(resolve(configDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    configurationRows.push(summary);
  }

  const comparison = {
    schema_version: 1,
    benchmark: "BEAM",
    tier: "1M",
    cohort: smokePath,
    oracle: oraclePath,
    cost_ceiling_usd: maxCost,
    cost: costBudget.snapshot(),
    advancement_gate: {
      metric: "case_level_complete_recertified_evidence_story",
      threshold: 0.85,
      denominator: cases.length,
      required_cases: Math.ceil(cases.length * 0.85),
      downstream_answering_allowed: configurationRows.some((row) =>
        Number(row.compressed_full_story) >= Math.ceil(cases.length * 0.85),
      ),
    },
    configurations: configurationRows,
  };
  writeFileSync(resolve(outDir, "comparison.json"), `${JSON.stringify(comparison, null, 2)}\n`);
  console.log(JSON.stringify({ event: "compression_smoke_complete", out_dir: outDir, ...comparison }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
