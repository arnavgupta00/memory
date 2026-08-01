/**
 * Run the preserved Architecture 0005.4 workflow on a prepared BEAM slice.
 *
 * This is an isolated compatibility gate: it does not change the shared BEAM
 * pipeline or reuse Architecture 0008 retrieval/answer artifacts.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import {
  ArchitectureOptionsSchema,
  type ArchitectureOptions,
  type ProviderModelLimitConfig,
  type RoleConfigs,
} from "../config.js";
import {
  loadArchitectureCases,
  type ArchitectureCase,
} from "../benchmarks/architectureDataset.js";
import { EventRecorder, ArtifactStore } from "../services/artifacts.js";
import { ModelGateway } from "../services/modelGateway.js";
import { PromptLoader } from "../services/promptLoader.js";
import { emptyState } from "../state.js";
import {
  AnswerResultSchema,
  ModelCallRecordSchema,
  ProviderRoleConfigSchema,
  type JsonObject,
  type TimestampedSession,
} from "../types.js";
import { createMemoryWorkflow } from "../workflow.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const DEFAULT_DATASET = resolve(
  PROJECT_ROOT,
  "runs/beam-1m-canary-a-architecture-0008-20260731-r2/input/dataset.json",
);
const DEFAULT_SLICE = resolve(
  PROJECT_ROOT,
  "src/agents/current/eval-slices/beam-1m/beam-1m-canary-a-broad-history-v1.json",
);
const MODEL = "gpt-5.4-nano-2026-03-17";

type Slice = {
  question_ids: string[];
  cases?: Array<{ question_id: string; question_type: string }>;
};

type CaseOutcome = {
  questionId: string;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
  error?: string;
};

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
      (value.startsWith('"') && value.endsWith('"'))
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

function safeCaseDirectory(questionId: string): string {
  return questionId.replaceAll(/[^A-Za-z0-9_.-]/g, "_");
}

function sessionsForCase(item: ArchitectureCase): TimestampedSession[] {
  return item.haystack_session_ids.map((sessionId, index) => ({
    session_id: sessionId,
    date: item.haystack_dates[index] ?? "unknown",
    turns: (item.haystack_sessions[index] ?? []).map((turn) => ({
      role: turn.role,
      content: turn.content,
    })),
  }));
}

function architectureOptions(): ArchitectureOptions {
  return ArchitectureOptionsSchema.parse({
    window_turns: 2,
    window_stride: 1,
    top_k: 48,
    char_budget: 80_000,
    max_turn_chars: 4_000,
    temporal_boost: 0.15,
    index_user_turns_only: true,
    select_enabled: true,
    select_prompt: "select-v4",
    package_max_turns: 40,
    package_char_budget: 40_000,
    package_supporting_enabled: true,
    package_sibling_sessions_enabled: true,
    package_sibling_session_max: 12,
    package_full_session_enabled: true,
    package_session_turn_max: 24,
    session_index_enabled: false,
    series_expand_enabled: false,
    format_enabled: false,
    answer_prompt: "answer-v5-package",
  });
}

function roles(concurrency: number): RoleConfigs {
  return {
    select: ProviderRoleConfigSchema.parse({
      kind: "generation",
      provider: "openai",
      model: MODEL,
      temperature: 1,
      reasoning_effort: "low",
      max_output_tokens: 8_000,
      timeout_seconds: 300,
      concurrency,
      max_retries: 6,
      input_price_per_million: 0.20,
      output_price_per_million: 1.25,
    }),
    answer: ProviderRoleConfigSchema.parse({
      kind: "generation",
      provider: "openai",
      model: MODEL,
      temperature: 1,
      reasoning_effort: "medium",
      max_output_tokens: 16_000,
      timeout_seconds: 300,
      concurrency,
      max_retries: 6,
      input_price_per_million: 0.20,
      output_price_per_million: 1.25,
    }),
  };
}

async function main(): Promise<void> {
  loadDotEnv(resolve(PROJECT_ROOT, ".env"));
  const args = parseArgs(process.argv.slice(2));
  const datasetPath = resolve(PROJECT_ROOT, args.dataset ?? DEFAULT_DATASET);
  const slicePath = resolve(PROJECT_ROOT, args.slice ?? DEFAULT_SLICE);
  const outRoot = resolve(
    PROJECT_ROOT,
    args.out ?? "runs/beam-1m-architecture-0005.4-event-ordering",
  );
  const concurrency = Number(args.concurrency ?? "10");
  const tokenBudget = Number(args["token-budget"] ?? "1900000");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 256) {
    throw new Error("--concurrency must be an integer from 1 to 256");
  }
  if (existsSync(outRoot)) throw new Error(`fresh run output already exists: ${outRoot}`);

  const slice = JSON.parse(readFileSync(slicePath, "utf8")) as Slice;
  const allowed = new Set(
    (slice.cases ?? [])
      .filter((item) => item.question_type === "event_ordering")
      .map((item) => item.question_id),
  );
  if (allowed.size === 0) {
    for (const questionId of slice.question_ids) {
      if (questionId.includes("/event_ordering/")) allowed.add(questionId);
    }
  }
  const selected = loadArchitectureCases(datasetPath).filter((item) => allowed.has(item.question_id));
  if (selected.length !== allowed.size) {
    throw new Error(`selected ${String(selected.length)} of ${String(allowed.size)} requested cases`);
  }

  mkdirSync(outRoot, { recursive: true });
  const artifactsRoot = resolve(outRoot, "agent-artifacts");
  const scheduleStore = new ArtifactStore(artifactsRoot);
  const roleConfigs = roles(concurrency);
  const providerLimits: ProviderModelLimitConfig[] = [{
    provider: "openai",
    model: MODEL,
    max_concurrency: concurrency,
    token_budget: tokenBudget,
    window_seconds: 60,
  }];
  const modelGateway = await ModelGateway.create({
    roles: roleConfigs,
    captureModelIo: true,
    providerModelLimits: providerLimits,
    scheduleStore,
  });
  const options = architectureOptions();
  const predictionsPath = resolve(outRoot, "predictions.jsonl");
  const errorsPath = resolve(outRoot, "errors.jsonl");
  const startedAt = new Date().toISOString();
  writeFileSync(resolve(outRoot, "manifest.json"), `${JSON.stringify({
    schema_version: 1,
    benchmark: "BEAM-1M",
    architecture: "0005.4",
    status: "running",
    started_at: startedAt,
    dataset: datasetPath,
    slice: slicePath,
    selected_question_ids: selected.map((item) => item.question_id),
    selected_count: selected.length,
    options,
    roles: roleConfigs,
    rate_limit: providerLimits[0],
    capture_model_io: true,
  }, null, 2)}\n`);

  const wallStarted = performance.now();
  const outcomes = await Promise.all(selected.map(async (item): Promise<CaseOutcome> => {
    const caseStarted = performance.now();
    const artifacts = new ArtifactStore(
      resolve(artifactsRoot, "cases", safeCaseDirectory(item.question_id)),
    );
    await artifacts.initialize();
    const runtime = {
      options,
      artifacts,
      events: new EventRecorder(artifacts),
      models: modelGateway,
      prompts: new PromptLoader(),
    };
    try {
      const initial = emptyState(item.question_id);
      initial.sessions = sessionsForCase(item);
      const result = await createMemoryWorkflow(runtime).invoke({
        ...initial,
        action: "answer",
        incomingSession: null,
        question: item.question,
        questionDate: item.question_date,
      });
      const answer = AnswerResultSchema.parse(result.answerResult);
      const modelCalls = (await artifacts.readJsonl("model-calls/calls"))
        .map((call) => ModelCallRecordSchema.parse(call));
      const inputTokens = modelCalls.reduce(
        (total, call) => total + (call.usage.input_tokens ?? 0),
        0,
      );
      const outputTokens = modelCalls.reduce(
        (total, call) => total + (call.usage.output_tokens ?? 0),
        0,
      );
      appendFileSync(predictionsPath, `${JSON.stringify({
        question_id: item.question_id,
        question_type: item.question_type,
        hypothesis: answer.hypothesis,
        evidence: answer.evidence,
        trace: answer.trace,
        generation: answer.generation,
        model_calls: modelCalls,
      })}\n`);
      const outcome = {
        questionId: item.question_id,
        inputTokens,
        outputTokens,
        elapsedMs: performance.now() - caseStarted,
      };
      console.log(JSON.stringify({ event: "case_complete", ...outcome }));
      return outcome;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendFileSync(errorsPath, `${JSON.stringify({
        question_id: item.question_id,
        error: message,
      })}\n`);
      console.error(JSON.stringify({
        event: "case_error",
        questionId: item.question_id,
        error: message,
      }));
      return {
        questionId: item.question_id,
        inputTokens: 0,
        outputTokens: 0,
        elapsedMs: performance.now() - caseStarted,
        error: message,
      };
    }
  }));

  const completed = outcomes.filter((item) => item.error === undefined);
  const inputTokens = completed.reduce((total, item) => total + item.inputTokens, 0);
  const outputTokens = completed.reduce((total, item) => total + item.outputTokens, 0);
  const summary: JsonObject = {
    schema_version: 1,
    architecture: "0005.4",
    status: completed.length === selected.length ? "completed" : "partial",
    selected_count: selected.length,
    completed_count: completed.length,
    failure_count: selected.length - completed.length,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    estimated_cost_usd: inputTokens / 1_000_000 * 0.20 + outputTokens / 1_000_000 * 1.25,
    elapsed_seconds: (performance.now() - wallStarted) / 1000,
  };
  writeFileSync(resolve(outRoot, "run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  const manifest = JSON.parse(readFileSync(resolve(outRoot, "manifest.json"), "utf8")) as JsonObject;
  writeFileSync(resolve(outRoot, "manifest.json"), `${JSON.stringify({
    ...manifest,
    ...summary,
    completed_at: new Date().toISOString(),
  }, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  if (completed.length !== selected.length) process.exitCode = 1;
}

void main();
