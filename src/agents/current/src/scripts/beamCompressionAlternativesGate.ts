import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import OpenAI from "openai";
import type { z } from "zod";

import {
  buildDiscoveryUnion,
  type DiscoveryUnion,
  type RecertifiedOracleEntry,
} from "../compression/beamCompression.js";
import {
  ConservativeRouterOutputSchema,
  CoverageAuditOutputSchema,
  CoverageLedgerSchema,
  ShardScoutOutputSchema,
  StoryCompilerOutputSchema,
  applyConservativeRouter,
  discoveryCharacterCount,
  evaluateRawEvidenceCoverage,
  explorerPointers,
  formatAlternativeSessions,
  materializeRetainedSessions,
  materializeSourcePointers,
  packageSha256,
  shardCatalog,
  shardDiscoverySessions,
  type CoverageLedger,
  type DiscoveryShard,
  type RawEvidencePackage,
  type ShardScoutOutput,
  type SourcePointer,
} from "../compression/beamCompressionAlternatives.js";
import {
  CostBudget,
  DispatchGate,
  callStructured,
  estimateInputTokens,
  loadDotEnv,
  mapPool,
  usageCost,
  type ReasoningEffort,
  type StructuredCallResult,
} from "../compression/structuredCall.js";
import { loadArchitectureCases, type ArchitectureCase } from "../benchmarks/architectureDataset.js";
import { PromptLoader, type PromptEnvelope } from "../services/promptLoader.js";

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
  "src/agents/current/eval-slices/beam-1m/beam-1m-compression-micro4-v1.json",
);
const DEFAULT_ORACLE = resolve(
  PROJECT_ROOT,
  "runs/beam-1m-compression-oracle-recertification-20260808/oracle-recertified-v1.json",
);
const DEFAULT_OUT = resolve(
  PROJECT_ROOT,
  "runs/beam-1m-compression-alternatives-micro4-20260809",
);
const DEFAULT_MODEL = "gpt-5.6-luna";
// These are API safety ceilings, not target lengths or experiment budgets.
// Structured reasoning can consume the allowance before emitting JSON, so use
// one deliberately generous ceiling for every architecture call.
const ARCHITECTURE_MAX_OUTPUT_TOKENS = 64_000;
const ROUTER_MAX_OUTPUT_TOKENS = ARCHITECTURE_MAX_OUTPUT_TOKENS;
const STORY_COMPILER_MAX_OUTPUT_TOKENS = ARCHITECTURE_MAX_OUTPUT_TOKENS;
const COVERAGE_LEDGER_MAX_OUTPUT_TOKENS = ARCHITECTURE_MAX_OUTPUT_TOKENS;
const COVERAGE_AUDIT_MAX_OUTPUT_TOKENS = ARCHITECTURE_MAX_OUTPUT_TOKENS;
const SHARD_SCOUT_MAX_OUTPUT_TOKENS = ARCHITECTURE_MAX_OUTPUT_TOKENS;

type ArmName = "session-router" | "story-compiler" | "coverage-explorer";
type TraceCase = { question_id: string; trace?: Array<Record<string, unknown>> };
type TraceRun = { cases: TraceCase[] };
type MicroManifest = { question_ids: string[] };
type OracleFile = { entries: RecertifiedOracleEntry[] };
type CaseInput = {
  raw: ArchitectureCase;
  discovery: DiscoveryUnion;
  oracle: RecertifiedOracleEntry;
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

function safeName(value: string): string {
  return value.replaceAll("/", "__");
}

function armList(value: string): ArmName[] {
  if (value === "all") return ["session-router", "story-compiler", "coverage-explorer"];
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  const allowed = new Set<ArmName>(["session-router", "story-compiler", "coverage-explorer"]);
  if (values.length === 0 || values.some((item) => !allowed.has(item as ArmName))) {
    throw new Error("--arm must be session-router, story-compiler, coverage-explorer, or all");
  }
  return [...new Set(values)] as ArmName[];
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

function loadCall<T>(path: string, schema: z.ZodType<T>): StructuredCallResult<T> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as StructuredCallResult<T>;
  return { ...parsed, value: schema.parse(parsed.value) };
}

function listCallFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return listCallFiles(path);
    return entry.isFile() && entry.name.endsWith(".call.json") ? [path] : [];
  });
}

function storedCallCost(root: string): number {
  return listCallFiles(root).reduce((sum, path) => {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { estimatedCostUsd?: number };
    return sum + (parsed.estimatedCostUsd ?? 0);
  }, 0);
}

async function safeCall<T>(args: {
  path: string;
  schema: z.ZodType<T>;
  schemaName: string;
  prompt: PromptEnvelope;
  model: string;
  reasoning: ReasoningEffort;
  maxOutputTokens: number;
  rawSessionIds: string[];
  openai: OpenAI;
  dispatch: DispatchGate;
  costBudget: CostBudget;
}): Promise<{ call: StructuredCallResult<T> | null; error: string | null }> {
  if (existsSync(args.path)) return { call: loadCall(args.path, args.schema), error: null };
  const errorPath = args.path.replace(/\.call\.json$/, ".error.json");
  if (existsSync(errorPath)) {
    const prior = JSON.parse(readFileSync(errorPath, "utf8")) as { error?: string };
    return { call: null, error: prior.error ?? "prior_call_failed" };
  }
  mkdirSync(dirname(args.path), { recursive: true });
  try {
    const call = await callStructured({
      openai: args.openai,
      dispatch: args.dispatch,
      costBudget: args.costBudget,
      model: args.model,
      reasoning: args.reasoning,
      prompt: args.prompt,
      schema: args.schema,
      schemaName: args.schemaName,
      maxOutputTokens: args.maxOutputTokens,
      rawSessionIdsForLeakCheck: args.rawSessionIds,
      promptCache: false,
    });
    writeFileSync(args.path, `${JSON.stringify(callJson(call), null, 2)}\n`);
    return { call, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeFileSync(errorPath, `${JSON.stringify({ error: message }, null, 2)}\n`);
    return { call: null, error: message };
  }
}

function fullPackage(discovery: DiscoveryUnion): RawEvidencePackage {
  return materializeRetainedSessions(
    discovery,
    discovery.sessions.map((session) => session.opaqueSessionId),
  );
}

function failOpenPointers(shard: DiscoveryShard): SourcePointer[] {
  return shard.sessions.flatMap((session) => {
    if (session.turns.length === 0) return [];
    return [{
      sessionId: session.opaqueSessionId,
      turnStart: 0,
      turnEnd: session.turns.length - 1,
      keepWholeSession: true,
    }];
  });
}

function formatRawSources(pkg: RawEvidencePackage): string {
  return JSON.stringify(pkg.segments.map((segment) => ({
    sessionId: segment.sessionId,
    date: segment.date,
    turnStart: segment.turnStart,
    turnEnd: segment.turnEnd,
    turns: segment.turns.map((turn, offset) => ({
      turnIndex: segment.turnStart + offset,
      role: turn.role,
      content: turn.content,
    })),
  })));
}

function caseMetrics(args: {
  arm: ArmName;
  item: CaseInput;
  pkg: RawEvidencePackage;
  errors: string[];
  metadata?: Record<string, unknown>;
}): Record<string, unknown> {
  const discoveryCharacters = discoveryCharacterCount(args.item.discovery);
  const coverage = evaluateRawEvidenceCoverage(args.pkg, args.item.oracle);
  return {
    question_id: args.item.raw.question_id,
    ability: args.item.raw.question_type,
    arm: args.arm,
    discovery_sessions: args.item.discovery.sessions.length,
    discovery_characters: discoveryCharacters,
    discovery_estimated_tokens: Math.ceil(discoveryCharacters / 4),
    represented_sessions: args.pkg.representedRealSessionIds.length,
    retained_characters: args.pkg.rawCharacters,
    retained_estimated_tokens: args.pkg.estimatedTokens,
    retained_token_fraction: discoveryCharacters === 0 ? 0 : args.pkg.rawCharacters / discoveryCharacters,
    compression_ratio: args.pkg.rawCharacters === 0 ? null : discoveryCharacters / args.pkg.rawCharacters,
    package_sha256: packageSha256(args.pkg),
    invalid_pointers: args.pkg.invalidPointers,
    fail_open: args.pkg.failOpen || args.errors.length > 0,
    errors: args.errors,
    coverage,
    ...args.metadata,
  };
}

async function runSessionRouter(args: RunArmArgs, item: CaseInput): Promise<CaseRun> {
  const caseDir = resolve(args.armDir, "cases", safeName(item.raw.question_id));
  mkdirSync(caseDir, { recursive: true });
  const shards = shardDiscoverySessions(item.discovery.sessions, args.shardTokenBudget);
  const rows = await mapPool(shards, args.concurrency, async (shard) => {
    const prompt = await args.prompts.render("beam-compression-session-router-v1", {
      question: item.raw.question,
      question_date: item.raw.question_date,
      router_sessions: formatAlternativeSessions(shard.sessions),
    });
    const result = await safeCall({
      path: resolve(caseDir, "calls", `router-${String(shard.index).padStart(3, "0")}.call.json`),
      schema: ConservativeRouterOutputSchema,
      schemaName: "beam_compression_session_router_v1",
      prompt,
      model: args.model,
      reasoning: args.reasoning,
      maxOutputTokens: ROUTER_MAX_OUTPUT_TOKENS,
      rawSessionIds: item.discovery.rawSessionIds,
      openai: args.openai,
      dispatch: args.dispatch,
      costBudget: args.costBudget,
    });
    return { shard, ...result };
  });
  const outputs = rows.flatMap((row) => row.call ? [row.call.value] : []);
  const pkg = applyConservativeRouter(item.discovery, outputs);
  const errors = rows.flatMap((row) => row.error ? [`shard_${String(row.shard.index)}:${row.error}`] : []);
  const metrics = caseMetrics({
    arm: "session-router",
    item,
    pkg,
    errors,
    metadata: { shards: shards.length, successful_shards: outputs.length },
  });
  return { pkg, metrics };
}

async function runStoryCompiler(args: RunArmArgs, item: CaseInput): Promise<CaseRun> {
  const caseDir = resolve(args.armDir, "cases", safeName(item.raw.question_id));
  mkdirSync(caseDir, { recursive: true });
  const prompt = await args.prompts.render("beam-compression-story-compiler-v1", {
    question: item.raw.question,
    question_date: item.raw.question_date,
    discovery_sessions: formatAlternativeSessions(item.discovery.sessions),
  });
  const result = await safeCall({
    path: resolve(caseDir, "calls", "story-compiler.call.json"),
    schema: StoryCompilerOutputSchema,
    schemaName: "beam_compression_story_compiler_v1",
    prompt,
    model: args.model,
    reasoning: args.reasoning,
    maxOutputTokens: STORY_COMPILER_MAX_OUTPUT_TOKENS,
    rawSessionIds: item.discovery.rawSessionIds,
    openai: args.openai,
    dispatch: args.dispatch,
    costBudget: args.costBudget,
  });
  const pointers = result.call?.value.storyBranches.flatMap((branch) => branch.sourcePointers) ?? [];
  const pkg = result.call
    ? materializeSourcePointers({ discovery: item.discovery, pointers, haloTurns: 2 })
    : fullPackage(item.discovery);
  const errors = result.error ? [result.error] : [];
  const metrics = caseMetrics({
    arm: "story-compiler",
    item,
    pkg,
    errors,
    metadata: {
      source_pointers: pointers.length,
      unresolved_coverage: result.call?.value.unresolvedCoverage ?? [],
    },
  });
  return { pkg, metrics };
}

async function runCoverageExplorer(args: RunArmArgs, item: CaseInput): Promise<CaseRun> {
  const caseDir = resolve(args.armDir, "cases", safeName(item.raw.question_id));
  mkdirSync(caseDir, { recursive: true });
  const ledgerPrompt = await args.prompts.render("beam-compression-coverage-ledger-v1", {
    question: item.raw.question,
    question_date: item.raw.question_date,
  });
  const ledgerResult = await safeCall({
    path: resolve(caseDir, "calls", "coverage-ledger.call.json"),
    schema: CoverageLedgerSchema,
    schemaName: "beam_compression_coverage_ledger_v1",
    prompt: ledgerPrompt,
    model: args.model,
    reasoning: args.reasoning,
    maxOutputTokens: COVERAGE_LEDGER_MAX_OUTPUT_TOKENS,
    rawSessionIds: item.discovery.rawSessionIds,
    openai: args.openai,
    dispatch: args.dispatch,
    costBudget: args.costBudget,
  });
  if (!ledgerResult.call) {
    const pkg = fullPackage(item.discovery);
    return {
      pkg,
      metrics: caseMetrics({
        arm: "coverage-explorer",
        item,
        pkg,
        errors: [ledgerResult.error ?? "coverage_ledger_failed"],
      }),
    };
  }
  const ledger = ledgerResult.call.value;
  const shards = shardDiscoverySessions(item.discovery.sessions, args.shardTokenBudget);
  const initial = await scoutShards({
    args,
    item,
    caseDir,
    ledger,
    shards,
    phase: "initial exhaustive scan; retain direct, indirect, bridge, contradictory, and uncertain evidence",
    prefix: "initial-scout",
  });
  const initialPointers = initial.rows.flatMap((row) =>
    row.call ? explorerPointers([row.call.value]) : failOpenPointers(row.shard),
  );
  const provisional = materializeSourcePointers({
    discovery: item.discovery,
    pointers: initialPointers,
    haloTurns: 2,
    failOpenOnInvalid: false,
  });
  const auditPrompt = await args.prompts.render("beam-compression-coverage-audit-v1", {
    question: item.raw.question,
    question_date: item.raw.question_date,
    coverage_ledger: JSON.stringify(ledger),
    provisional_sources: formatRawSources(provisional),
    shard_catalog: shardCatalog(shards),
  });
  const auditResult = await safeCall({
    path: resolve(caseDir, "calls", "coverage-audit.call.json"),
    schema: CoverageAuditOutputSchema,
    schemaName: "beam_compression_coverage_audit_v1",
    prompt: auditPrompt,
    model: args.model,
    reasoning: args.reasoning,
    maxOutputTokens: COVERAGE_AUDIT_MAX_OUTPUT_TOKENS,
    rawSessionIds: item.discovery.rawSessionIds,
    openai: args.openai,
    dispatch: args.dispatch,
    costBudget: args.costBudget,
  });
  if (!auditResult.call) {
    const pkg = fullPackage(item.discovery);
    return {
      pkg,
      metrics: caseMetrics({
        arm: "coverage-explorer",
        item,
        pkg,
        errors: [...initial.errors, auditResult.error ?? "coverage_audit_failed"],
        metadata: { shards: shards.length, repair_shards: 0 },
      }),
    };
  }
  const audit = auditResult.call.value;
  const requestedIndexes = [...new Set(audit.repairShardIndexes)];
  const invalidShardIndex = requestedIndexes.some((index) => !shards[index]);
  if (invalidShardIndex) {
    const pkg = fullPackage(item.discovery);
    return {
      pkg,
      metrics: caseMetrics({
        arm: "coverage-explorer",
        item,
        pkg,
        errors: [...initial.errors, "coverage_audit_requested_unknown_shard"],
        metadata: { shards: shards.length, repair_shards: 0 },
      }),
    };
  }
  const repairBudget = Math.ceil(
    shards.reduce((sum, shard) => sum + shard.estimatedTokens, 0) * args.repairFraction,
  );
  const repairShards: DiscoveryShard[] = [];
  let repairTokens = 0;
  for (const index of requestedIndexes) {
    const shard = shards[index];
    if (!shard) continue;
    if (repairShards.length > 0 && repairTokens + shard.estimatedTokens > repairBudget) break;
    repairShards.push(shard);
    repairTokens += shard.estimatedTokens;
  }
  const repair = audit.coverageComplete || audit.missingObligations.length === 0
    ? { rows: [], errors: [] }
    : await scoutShards({
      args,
      item,
      caseDir,
      ledger,
      shards: repairShards,
      phase: JSON.stringify({
        phase: "adversarial repair",
        missingObligations: audit.missingObligations,
      }),
      prefix: "repair-scout",
    });
  const repairPointers = repair.rows.flatMap((row) =>
    row.call ? explorerPointers([row.call.value]) : failOpenPointers(row.shard),
  );
  const pkg = materializeSourcePointers({
    discovery: item.discovery,
    pointers: [...initialPointers, ...repairPointers],
    haloTurns: 2,
    failOpenOnInvalid: false,
  });
  const errors = [...initial.errors, ...repair.errors];
  return {
    pkg,
    metrics: caseMetrics({
      arm: "coverage-explorer",
      item,
      pkg,
      errors,
      metadata: {
        obligations: ledger.obligations.length,
        shards: shards.length,
        initial_source_pointers: initialPointers.length,
        repair_shards: repairShards.length,
        repair_source_pointers: repairPointers.length,
        audit,
      },
    }),
  };
}

async function scoutShards(args: {
  args: RunArmArgs;
  item: CaseInput;
  caseDir: string;
  ledger: CoverageLedger;
  shards: DiscoveryShard[];
  phase: string;
  prefix: string;
}): Promise<{
  rows: Array<{
    shard: DiscoveryShard;
    call: StructuredCallResult<ShardScoutOutput> | null;
    error: string | null;
  }>;
  errors: string[];
}> {
  const rows = await mapPool(args.shards, args.args.concurrency, async (shard) => {
    const prompt = await args.args.prompts.render("beam-compression-shard-scout-v1", {
      question: args.item.raw.question,
      question_date: args.item.raw.question_date,
      coverage_ledger: JSON.stringify(args.ledger),
      scout_phase: args.phase,
      scout_sessions: formatAlternativeSessions(shard.sessions),
    });
    const result = await safeCall({
      path: resolve(
        args.caseDir,
        "calls",
        `${args.prefix}-${String(shard.index).padStart(3, "0")}.call.json`,
      ),
      schema: ShardScoutOutputSchema,
      schemaName: "beam_compression_shard_scout_v1",
      prompt,
      model: args.args.model,
      reasoning: args.args.reasoning,
      maxOutputTokens: SHARD_SCOUT_MAX_OUTPUT_TOKENS,
      rawSessionIds: args.item.discovery.rawSessionIds,
      openai: args.args.openai,
      dispatch: args.args.dispatch,
      costBudget: args.args.costBudget,
    });
    return { shard, ...result };
  });
  return {
    rows,
    errors: rows.flatMap((row) => row.error ? [`${args.prefix}_${String(row.shard.index)}:${row.error}`] : []),
  };
}

type RunArmArgs = {
  arm: ArmName;
  armDir: string;
  model: string;
  reasoning: ReasoningEffort;
  shardTokenBudget: number;
  repairFraction: number;
  concurrency: number;
  prompts: PromptLoader;
  openai: OpenAI;
  dispatch: DispatchGate;
  costBudget: CostBudget;
};
type CaseRun = { pkg: RawEvidencePackage; metrics: Record<string, unknown> };

function summaryForArm(args: {
  arm: ArmName;
  cases: CaseRun[];
  armDir: string;
  maxCost: number;
}): Record<string, unknown> {
  const rows = args.cases.map((item) => item.metrics as {
    coverage: {
      coveredAtoms: number;
      totalAtoms: number;
      fullStory: boolean;
      goldSessionsRepresented: number;
      goldSessionsTotal: number;
    };
    retained_token_fraction: number;
    invalid_pointers: unknown[];
    fail_open: boolean;
    source_pointers?: number;
    initial_source_pointers?: number;
    repair_source_pointers?: number;
  });
  const totalAtoms = rows.reduce((sum, row) => sum + row.coverage.totalAtoms, 0);
  const coveredAtoms = rows.reduce((sum, row) => sum + row.coverage.coveredAtoms, 0);
  const cost = storedCallCost(args.armDir);
  const fullStories = rows.filter((row) => row.coverage.fullStory).length;
  const maxRetention = Math.max(...rows.map((row) => row.retained_token_fraction));
  const invalidPointers = rows.reduce((sum, row) => sum + row.invalid_pointers.length, 0);
  const pointerSuggestions = rows.reduce((sum, row) =>
    sum
    + (row.source_pointers ?? 0)
    + (row.initial_source_pointers ?? 0)
    + (row.repair_source_pointers ?? 0),
  0);
  const invalidPointerRate = pointerSuggestions === 0 ? 0 : invalidPointers / pointerSuggestions;
  const pass = fullStories === rows.length
    && (totalAtoms === 0 || coveredAtoms / totalAtoms >= 0.97)
    && maxRetention <= 0.5
    && invalidPointerRate <= 0.005;
  return {
    schema_version: 1,
    arm: args.arm,
    questions: rows.length,
    complete_stories: fullStories,
    complete_story_rate: rows.length === 0 ? 0 : fullStories / rows.length,
    covered_atoms: coveredAtoms,
    total_atoms: totalAtoms,
    atom_recall: totalAtoms === 0 ? 1 : coveredAtoms / totalAtoms,
    gold_sessions_represented: rows.reduce(
      (sum, row) => sum + row.coverage.goldSessionsRepresented,
      0,
    ),
    gold_sessions_total: rows.reduce((sum, row) => sum + row.coverage.goldSessionsTotal, 0),
    max_retained_token_fraction: maxRetention,
    mean_retained_token_fraction: rows.reduce(
      (sum, row) => sum + row.retained_token_fraction,
      0,
    ) / rows.length,
    invalid_pointers: invalidPointers,
    source_pointer_suggestions: pointerSuggestions,
    invalid_pointer_rate: invalidPointerRate,
    fail_open_cases: rows.filter((row) => row.fail_open).length,
    cost_usd: cost,
    cost_ceiling_usd: args.maxCost,
    advancement_gate: {
      passed: pass,
      requirements: {
        complete_stories: `${String(rows.length)}/${String(rows.length)}`,
        atom_recall_minimum: 0.97,
        retained_token_fraction_maximum_per_case: 0.5,
        invalid_pointer_rate_maximum: 0.005,
        cost: "reported_not_gated",
      },
    },
    cases: args.cases.map((item) => item.metrics),
  };
}

function maxCallCost(model: string, prompt: PromptEnvelope, maxOutputTokens: number): number {
  const input = estimateInputTokens(prompt);
  return usageCost(model, {
    input_tokens: input,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: maxOutputTokens,
    total_tokens: input + maxOutputTokens,
    reasoning_tokens: 0,
  });
}

async function buildPreflight(args: {
  arms: ArmName[];
  cases: CaseInput[];
  prompts: PromptLoader;
  model: string;
  shardTokenBudget: number;
  maxCost: number;
}): Promise<Record<string, unknown>> {
  const arms: Record<string, unknown>[] = [];
  for (const arm of args.arms) {
    let calls = 0;
    let inputTokens = 0;
    let worstCaseBaseCost = 0;
    for (const item of args.cases) {
      if (arm === "story-compiler") {
        const prompt = await args.prompts.render("beam-compression-story-compiler-v1", {
          question: item.raw.question,
          question_date: item.raw.question_date,
          discovery_sessions: formatAlternativeSessions(item.discovery.sessions),
        });
        calls += 1;
        inputTokens += estimateInputTokens(prompt);
        worstCaseBaseCost += maxCallCost(args.model, prompt, STORY_COMPILER_MAX_OUTPUT_TOKENS);
        continue;
      }
      if (arm === "session-router") {
        for (const shard of shardDiscoverySessions(item.discovery.sessions, args.shardTokenBudget)) {
          const prompt = await args.prompts.render("beam-compression-session-router-v1", {
            question: item.raw.question,
            question_date: item.raw.question_date,
            router_sessions: formatAlternativeSessions(shard.sessions),
          });
          calls += 1;
          inputTokens += estimateInputTokens(prompt);
          worstCaseBaseCost += maxCallCost(args.model, prompt, ROUTER_MAX_OUTPUT_TOKENS);
        }
        continue;
      }
      const ledger = await args.prompts.render("beam-compression-coverage-ledger-v1", {
        question: item.raw.question,
        question_date: item.raw.question_date,
      });
      calls += 1;
      inputTokens += estimateInputTokens(ledger);
      worstCaseBaseCost += maxCallCost(args.model, ledger, COVERAGE_LEDGER_MAX_OUTPUT_TOKENS);
      const syntheticLedger: CoverageLedger = {
        obligations: [{
          id: "placeholder",
          description: "Preflight placeholder obligation",
          evidenceShapes: ["answer-bearing evidence"],
          completionRule: "At least one grounded source",
        }],
        adversarialChecks: ["Look for missing branches"],
      };
      for (const shard of shardDiscoverySessions(item.discovery.sessions, args.shardTokenBudget)) {
        const prompt = await args.prompts.render("beam-compression-shard-scout-v1", {
          question: item.raw.question,
          question_date: item.raw.question_date,
          coverage_ledger: JSON.stringify(syntheticLedger),
          scout_phase: "initial preflight estimate",
          scout_sessions: formatAlternativeSessions(shard.sessions),
        });
        calls += 1;
        inputTokens += estimateInputTokens(prompt);
        worstCaseBaseCost += maxCallCost(args.model, prompt, SHARD_SCOUT_MAX_OUTPUT_TOKENS);
      }
    }
    arms.push({
      arm,
      known_base_calls: calls,
      known_base_input_tokens: inputTokens,
      worst_case_base_cost_usd: worstCaseBaseCost,
      adaptive_tail: arm === "coverage-explorer"
        ? "coverage audits plus at most 35% repair reading; hard runtime ceiling remains authoritative"
        : null,
      hard_cost_ceiling_usd: args.maxCost,
    });
  }
  return {
    schema_version: 1,
    mode: "no_api_preflight",
    questions: args.cases.length,
    model: args.model,
    shard_token_budget: args.shardTokenBudget,
    arms,
  };
}

async function main(): Promise<void> {
  loadDotEnv(resolve(PROJECT_ROOT, ".env"));
  const argv = parseArgs(process.argv.slice(2));
  const datasetPath = projectPath(argv.dataset, DEFAULT_DATASET);
  const tracePath = projectPath(argv.trace, DEFAULT_TRACE);
  const retryPath = projectPath(argv.retry, DEFAULT_RETRY);
  const idsPath = projectPath(argv.ids, DEFAULT_IDS);
  const oraclePath = projectPath(argv.oracle, DEFAULT_ORACLE);
  const outDir = projectPath(argv.out, DEFAULT_OUT);
  const arms = armList(argv.arm ?? "all");
  const model = argv.model ?? DEFAULT_MODEL;
  const reasoning = (argv.reasoning ?? "medium") as ReasoningEffort;
  // Cost is observed, not used as an experimental gate. Keep an explicit CLI
  // override as an operator kill switch; the default is practically unbounded.
  const maxCost = Number(argv["max-cost"] ?? 1_000_000);
  const tokenBudget = Number(argv["token-budget"] ?? 1_900_000);
  const concurrency = Number(argv.concurrency ?? 8);
  const shardTokenBudget = Number(argv["shard-token-budget"] ?? 180_000);
  const repairFraction = Number(argv["repair-fraction"] ?? 0.35);
  const expectedCases = Number(argv["expected-cases"] ?? 4);
  const requireDiscoveryComplete = argv["require-discovery-complete"] !== "false";
  const preflightOnly = argv["preflight-only"] === "true";
  if (!(maxCost > 0)) throw new Error("--max-cost must be positive");
  if (!(repairFraction >= 0 && repairFraction <= 0.35)) {
    throw new Error("--repair-fraction must be between 0 and 0.35");
  }
  if (!model.startsWith("gpt-5.6-luna")) {
    throw new Error("the approved micro-gate is locked to GPT-5.6 Luna");
  }
  if (!(["low", "medium", "high"] as string[]).includes(reasoning)) {
    throw new Error("--reasoning must be low, medium, or high");
  }

  const rawCases = loadArchitectureCases(datasetPath);
  const rawById = new Map(rawCases.map((item) => [item.question_id, item]));
  const trace = JSON.parse(readFileSync(tracePath, "utf8")) as TraceRun;
  const retry = JSON.parse(readFileSync(retryPath, "utf8")) as TraceRun;
  const traceById = new Map(trace.cases.map((item) => [item.question_id, item]));
  for (const item of retry.cases) traceById.set(item.question_id, item);
  const manifest = JSON.parse(readFileSync(idsPath, "utf8")) as MicroManifest;
  const oracle = JSON.parse(readFileSync(oraclePath, "utf8")) as OracleFile;
  const oracleById = new Map(oracle.entries.map((item) => [item.question_id, item]));
  const cases = manifest.question_ids.map((questionId): CaseInput => {
    const raw = rawById.get(questionId);
    const traced = traceById.get(questionId);
    const certified = oracleById.get(questionId);
    if (!raw || !traced || !certified) throw new Error(`missing micro input for ${questionId}`);
    if (certified.status !== "certified") throw new Error(`oracle is not certified for ${questionId}`);
    const discovery = buildDiscoveryUnion(raw, traced);
    const discoverySessions = new Set(discovery.sessions.map((session) => session.realSessionId));
    const missingAtom = certified.evidence_atoms.some((atom) =>
      !atom.sources.some((source) => discoverySessions.has(source.session_id)),
    );
    if (missingAtom && requireDiscoveryComplete) {
      throw new Error(`cohort requires discovery-complete story: ${questionId}`);
    }
    return { raw, discovery, oracle: certified };
  });
  if (!Number.isInteger(expectedCases) || expectedCases < 1 || cases.length !== expectedCases) {
    throw new Error(`expected exactly ${String(expectedCases)} questions; found ${String(cases.length)}`);
  }

  mkdirSync(outDir, { recursive: true });
  const prompts = new PromptLoader();
  const preflight = await buildPreflight({
    arms,
    cases,
    prompts,
    model,
    shardTokenBudget,
    maxCost,
  });
  writeFileSync(resolve(outDir, "preflight.json"), `${JSON.stringify(preflight, null, 2)}\n`);
  if (preflightOnly) {
    console.log(JSON.stringify(preflight, null, 2));
    return;
  }

  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required for a live micro-gate");
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const summaries: Record<string, unknown>[] = [];
  for (const arm of arms) {
    const armDir = resolve(outDir, arm);
    mkdirSync(armDir, { recursive: true });
    const priorCost = storedCallCost(armDir);
    const remaining = maxCost - priorCost;
    if (!(remaining > 0)) throw new Error(`${arm} has exhausted its $${maxCost.toFixed(2)} ceiling`);
    const costBudget = new CostBudget(remaining);
    const dispatch = new DispatchGate(tokenBudget, 60, concurrency);
    const runArgs: RunArmArgs = {
      arm,
      armDir,
      model,
      reasoning,
      shardTokenBudget,
      repairFraction,
      concurrency,
      prompts,
      openai,
      dispatch,
      costBudget,
    };
    const caseRuns = await mapPool(cases, Math.min(concurrency, cases.length), async (item) => {
      const result = arm === "session-router"
        ? await runSessionRouter(runArgs, item)
        : arm === "story-compiler"
          ? await runStoryCompiler(runArgs, item)
          : await runCoverageExplorer(runArgs, item);
      const caseDir = resolve(armDir, "cases", safeName(item.raw.question_id));
      writeFileSync(resolve(caseDir, "raw-evidence-package.json"), `${JSON.stringify(result.pkg, null, 2)}\n`);
      writeFileSync(resolve(caseDir, "metrics.json"), `${JSON.stringify(result.metrics, null, 2)}\n`);
      console.log(JSON.stringify({
        event: "beam_compression_alternative_case_complete",
        arm,
        question_id: item.raw.question_id,
        full_story: (result.metrics.coverage as { fullStory: boolean }).fullStory,
        retained_token_fraction: result.metrics.retained_token_fraction,
        cumulative_successful_call_cost_usd: storedCallCost(armDir),
      }));
      return result;
    });
    const summary = summaryForArm({ arm, cases: caseRuns, armDir, maxCost });
    writeFileSync(resolve(armDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    summaries.push(summary);
  }
  const comparison = {
    schema_version: 1,
    benchmark: "BEAM",
    tier: "1M",
    cohort: idsPath,
    oracle: oraclePath,
    model,
    reasoning,
    per_arm_cost_ceiling_usd: maxCost,
    primary_metric: "case_level_complete_recertified_evidence_story",
    require_discovery_complete: requireDiscoveryComplete,
    arms: summaries,
  };
  writeFileSync(resolve(outDir, "comparison.json"), `${JSON.stringify(comparison, null, 2)}\n`);
  console.log(JSON.stringify({ event: "beam_compression_alternatives_complete", ...comparison }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
