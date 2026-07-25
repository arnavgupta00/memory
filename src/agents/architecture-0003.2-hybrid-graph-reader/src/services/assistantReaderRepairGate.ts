import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { z } from "zod";

import {
  ArchitectureOptionsSchema,
  ProviderModelLimitSchema,
  type ProviderModelLimitConfig,
  type RoleConfigs,
} from "../config.js";
import { createReadMemoryNode } from "../nodes/readMemory.js";
import {
  RetrievalCandidatesSchema,
  type RetrievalCandidates,
} from "../retrieval/types.js";
import type { StructuredModelGateway, WorkflowRuntime } from "../runtime.js";
import { emptyState } from "../state.js";
import { ArtifactStore, EventRecorder } from "./artifacts.js";
import { ModelGateway } from "./modelGateway.js";
import { PromptLoader } from "./promptLoader.js";
import {
  JsonObjectSchema,
  MasterContextGraphSchema,
  ModelCallRecordSchema,
  ProviderRoleConfigSchema,
  ReaderPlanSchema,
  TimestampedSessionSchema,
  type JsonObject,
  type MasterContextGraph,
  type ModelCallRecord,
  type ReaderPlan,
  type TimestampedSession,
} from "../types.js";

const PromptDatasetCaseSchema = z.object({
  question_id: z.string().min(1),
  question_type: z.string().min(1),
  question: z.string(),
  question_date: z.string(),
});

const ReferenceDatasetCaseSchema = z.object({
  question_id: z.string().min(1),
  answer_session_ids: z.array(z.string().min(1)).min(1),
});

const SourceRunManifestSchema = z.object({
  run_id: z.string().min(1),
  status: z.literal("completed"),
  selected_question_ids: z.array(z.string().min(1)),
  config: z.object({
    agent: z.object({
      models: z.object({
        contexto: ProviderRoleConfigSchema,
        shino: ProviderRoleConfigSchema,
        reader: ProviderRoleConfigSchema,
      }),
      provider_model_limits: z.array(ProviderModelLimitSchema).min(1),
      options: ArchitectureOptionsSchema,
    }),
    answer: ProviderRoleConfigSchema,
    execution: z.object({
      capture_model_io: z.boolean().default(true),
    }),
  }),
});

const SourceCaseSchema = z.strictObject({
  questionId: z.string().min(1),
  questionType: z.string().min(1),
  question: z.string(),
  questionDate: z.string(),
  sessions: z.array(TimestampedSessionSchema).min(1),
  graph: MasterContextGraphSchema,
  retrieval: RetrievalCandidatesSchema,
  sourceHashes: z.record(z.string(), z.string().length(64)),
});

const SuccessfulRepairSchema = z.strictObject({
  questionId: z.string().min(1),
  questionType: z.string().min(1),
  plan: ReaderPlanSchema,
  warnings: z.array(z.string()),
  call: ModelCallRecordSchema,
});

const FailedRepairSchema = z.strictObject({
  questionId: z.string().min(1),
  questionType: z.string().min(1),
  error: z.string().min(1),
});

const RepairOutcomeSchema = z.discriminatedUnion("status", [
  SuccessfulRepairSchema.extend({ status: z.literal("completed") }),
  FailedRepairSchema.extend({ status: z.literal("failed") }),
]);

type PromptDatasetCase = z.infer<typeof PromptDatasetCaseSchema>;
type SourceCase = z.infer<typeof SourceCaseSchema>;
type SuccessfulRepair = z.infer<typeof SuccessfulRepairSchema>;
type RepairOutcome = z.infer<typeof RepairOutcomeSchema>;

export type AssistantReaderRepairGateArguments = {
  sourceRun: string;
  dataset: string;
  output: string;
  caseIds: string[];
  abstentionCaseIds?: string[];
};

export type AssistantReaderRepairGatewayFactory = (args: {
  roles: RoleConfigs;
  providerModelLimits: ProviderModelLimitConfig[];
  captureModelIo: boolean;
  scheduleStore: ArtifactStore;
}) => Promise<StructuredModelGateway>;

export type AssistantReaderRepairGateDependencies = {
  gatewayFactory?: AssistantReaderRepairGatewayFactory;
  now?: () => Date;
};

export type AssistantReaderRepairGateResult = {
  verdict: "passed" | "failed";
  report: JsonObject;
  manifest: JsonObject;
};

function sha256Buffer(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniqueCaseIds(caseIds: string[]): string[] {
  const normalized = caseIds.map((caseId) => caseId.trim()).filter(Boolean);
  if (normalized.length === 0) {
    throw new Error("assistant-reader repair gate requires at least one case ID");
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("assistant-reader repair gate case IDs must be unique");
  }
  return normalized;
}

function abstentionIds(
  caseIds: readonly string[],
  requested: readonly string[] | undefined,
): Set<string> {
  const normalized = (requested ?? []).map((caseId) => caseId.trim()).filter(Boolean);
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("assistant-reader repair gate abstention case IDs must be unique");
  }
  const selected = new Set(caseIds);
  for (const caseId of normalized) {
    if (!selected.has(caseId)) {
      throw new Error(`abstention case is not selected: ${caseId}`);
    }
  }
  return new Set(normalized);
}

async function requireFreshDirectory(path: string): Promise<void> {
  const existing = await stat(path).then(() => true).catch(() => false);
  if (existing) {
    throw new Error(`assistant-reader repair gate output already exists: ${path}`);
  }
  await mkdir(path, { recursive: false });
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function readSessions(path: string): Promise<TimestampedSession[]> {
  const body = await readFile(path, "utf8");
  return body
    .split("\n")
    .filter(Boolean)
    .map((line) => TimestampedSessionSchema.parse(JSON.parse(line) as unknown));
}

async function fileHash(path: string): Promise<string> {
  return sha256Buffer(await readFile(path));
}

function candidateSessionIds(
  candidates: RetrievalCandidates,
): Set<string> {
  return new Set([
    ...candidates.sessions.map((candidate) => candidate.session.session_id),
    ...candidates.graphCells.flatMap((candidate) => candidate.sessionIds),
    ...candidates.summaries.flatMap((candidate) => candidate.summary.sessionIds),
    ...candidates.coverageFallbackSessions.map((candidate) => candidate.sessionId),
    ...candidates.tailSessions.map((candidate) => candidate.session.session_id),
  ]);
}

function readerSourceSessionIds(
  plan: ReaderPlan,
  graph: MasterContextGraph,
): Set<string> {
  const sourceIds = new Set([
    ...plan.selectedSessions.map((selected) => selected.sessionId),
    ...plan.evidenceFacts.flatMap((fact) => fact.sessionIds),
  ]);
  for (const pointer of plan.selectedGraphPointers) {
    for (const source of graph.provenanceByPointer[pointer] ?? []) {
      sourceIds.add(source.sessionId);
    }
  }
  return sourceIds;
}

function unknownReferenceWarnings(warnings: string[]): string[] {
  return warnings.filter((warning) =>
    /unknown (?:session|graph|fact)|invalid turn reference/u.test(warning),
  );
}

function nonemptyPlan(plan: ReaderPlan): boolean {
  return (
    plan.selectedSessions.length > 0
    || plan.selectedGraphPointers.length > 0
    || plan.evidenceFacts.length > 0
  );
}

function usageCost(
  call: ModelCallRecord,
  readerRole: RoleConfigs["reader"],
): number {
  const inputPrice = readerRole.input_price_per_million ?? 0;
  const outputPrice = readerRole.output_price_per_million ?? 0;
  return (
    (call.usage.input_tokens ?? 0) * inputPrice / 1_000_000
    + (call.usage.output_tokens ?? 0) * outputPrice / 1_000_000
  );
}

async function loadSourceCase(args: {
  sourceRunRoot: string;
  promptCase: PromptDatasetCase;
}): Promise<SourceCase> {
  const caseRoot = resolve(
    args.sourceRunRoot,
    "agent-artifacts",
    "cases",
    args.promptCase.question_id,
  );
  const paths = {
    sessions: resolve(caseRoot, "sessions.jsonl"),
    retrieval: resolve(caseRoot, "retrieval", "candidates.json"),
    graph: resolve(caseRoot, "final-graph.json"),
  };
  const [sessions, retrievalRaw, graphRaw, sessionsHash, retrievalHash, graphHash] =
    await Promise.all([
      readSessions(paths.sessions),
      readJson(paths.retrieval),
      readJson(paths.graph),
      fileHash(paths.sessions),
      fileHash(paths.retrieval),
      fileHash(paths.graph),
    ]);
  const retrieval = RetrievalCandidatesSchema.parse(retrievalRaw);
  if (
    retrieval.question !== args.promptCase.question
    || retrieval.questionDate !== args.promptCase.question_date
  ) {
    throw new Error(
      `persisted retrieval question mismatch for ${args.promptCase.question_id}`,
    );
  }
  return SourceCaseSchema.parse({
    questionId: args.promptCase.question_id,
    questionType: args.promptCase.question_type,
    question: args.promptCase.question,
    questionDate: args.promptCase.question_date,
    sessions,
    graph: MasterContextGraphSchema.parse(graphRaw),
    retrieval,
    sourceHashes: {
      sessions_jsonl: sessionsHash,
      retrieval_candidates_json: retrievalHash,
      final_graph_json: graphHash,
    },
  });
}

async function runOneReader(args: {
  source: SourceCase;
  outputRoot: string;
  runtimeOptions: z.infer<typeof ArchitectureOptionsSchema>;
  models: StructuredModelGateway;
  prompts: PromptLoader;
}): Promise<SuccessfulRepair> {
  const artifacts = new ArtifactStore(
    resolve(args.outputRoot, "cases", args.source.questionId),
  );
  await artifacts.initialize();
  const runtime: WorkflowRuntime = {
    options: args.runtimeOptions,
    artifacts,
    events: new EventRecorder(artifacts),
    models: args.models,
    prompts: args.prompts,
  };
  const state = emptyState(args.source.questionId);
  state.sessions = args.source.sessions;
  state.graph = args.source.graph;
  state.graphTrackedCount = args.source.sessions.length;
  state.summaryTrackedCount = args.source.sessions.length;
  state.question = args.source.question;
  state.questionDate = args.source.questionDate;
  state.retrievalCandidates = args.source.retrieval;
  const update = await createReadMemoryNode(runtime)(state);
  const calls = (await artifacts.readJsonl("model-calls/calls")).map((call) =>
    ModelCallRecordSchema.parse(call),
  );
  if (calls.length !== 1 || calls[0]?.role !== "reader") {
    throw new Error(
      `expected exactly one persisted Reader call for ${args.source.questionId}`,
    );
  }
  return SuccessfulRepairSchema.parse({
    questionId: args.source.questionId,
    questionType: args.source.questionType,
    plan: update.readerPlan,
    warnings: update.warnings ?? [],
    call: calls[0],
  });
}

async function currentSourceHashes(): Promise<Record<string, string>> {
  const sourceRoot = resolve(import.meta.dirname, "..");
  const promptRoot = resolve(import.meta.dirname, "../../prompts");
  const files = {
    reader_node: resolve(sourceRoot, "nodes", "readMemory.ts"),
    reader_prompt: resolve(promptRoot, "reader.yaml"),
    reader_schema: resolve(sourceRoot, "services", "readerSchema.ts"),
    reader_sanitizer: resolve(sourceRoot, "services", "readerPlan.ts"),
    reader_grounding: resolve(sourceRoot, "services", "readerGrounding.ts"),
    reader_evidence: resolve(sourceRoot, "services", "readerEvidence.ts"),
    reader_focus: resolve(sourceRoot, "services", "readerFocus.ts"),
    reader_quantitative_fallback: resolve(
      sourceRoot,
      "services",
      "readerQuantitativeFallback.ts",
    ),
  };
  const entries = await Promise.all(
    Object.entries(files).map(async ([name, path]) => [name, await fileHash(path)] as const),
  );
  return Object.fromEntries(entries);
}

export async function runAssistantReaderRepairGate(
  rawArgs: AssistantReaderRepairGateArguments,
  dependencies: AssistantReaderRepairGateDependencies = {},
): Promise<AssistantReaderRepairGateResult> {
  const sourceRunRoot = resolve(rawArgs.sourceRun);
  const datasetPath = resolve(rawArgs.dataset);
  const outputRoot = resolve(rawArgs.output);
  const caseIds = uniqueCaseIds(rawArgs.caseIds);
  const expectedAbstentionIds = abstentionIds(caseIds, rawArgs.abstentionCaseIds);
  const expectedAnswerableCount = caseIds.length - expectedAbstentionIds.size;
  await requireFreshDirectory(outputRoot);
  const output = new ArtifactStore(outputRoot);

  const datasetBody = await readFile(datasetPath);
  const promptCases = z.array(PromptDatasetCaseSchema).parse(
    JSON.parse(datasetBody.toString("utf8")) as unknown,
  );
  const promptCaseById = new Map(
    promptCases.map((item) => [item.question_id, item]),
  );
  const sourceManifestPath = resolve(sourceRunRoot, "manifest.json");
  const sourceConfigPath = resolve(sourceRunRoot, "config.yaml");
  const sourceManifest = SourceRunManifestSchema.parse(
    await readJson(sourceManifestPath),
  );
  for (const caseId of caseIds) {
    if (!sourceManifest.selected_question_ids.includes(caseId)) {
      throw new Error(`source run does not contain requested case: ${caseId}`);
    }
    if (!promptCaseById.has(caseId)) {
      throw new Error(`dataset does not contain requested case: ${caseId}`);
    }
  }
  const sourceCases = await Promise.all(
    caseIds.map((caseId) =>
      loadSourceCase({
        sourceRunRoot,
        promptCase: promptCaseById.get(caseId) as PromptDatasetCase,
      }),
    ),
  );
  const roles: RoleConfigs = {
    contexto: sourceManifest.config.agent.models.contexto,
    shino: sourceManifest.config.agent.models.shino,
    reader: sourceManifest.config.agent.models.reader,
    answer: sourceManifest.config.answer,
  };
  const sourceInputHashes = Object.fromEntries(
    sourceCases.map((source) => [source.questionId, source.sourceHashes]),
  );
  const generatedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const manifest: JsonObject = JsonObjectSchema.parse({
    schema_version: 1,
    gate_id: basename(outputRoot),
    architecture_id: "0003.2-hybrid-graph-reader",
    generated_at: generatedAt,
    source_run_id: sourceManifest.run_id,
    source_run_path: sourceRunRoot,
    source_run_manifest_sha256: await fileHash(sourceManifestPath),
    source_run_config_sha256: await fileHash(sourceConfigPath),
    dataset_sha256: sha256Buffer(datasetBody),
    cases: caseIds,
    role: "reader",
    provider: roles.reader.provider,
    model: roles.reader.model,
    model_parameters: {
      temperature: roles.reader.temperature,
      reasoning_effort: roles.reader.reasoning_effort ?? null,
      max_output_tokens: roles.reader.max_output_tokens,
      max_retries: roles.reader.max_retries,
    },
    source_input_hashes: sourceInputHashes,
    production_source_hashes: await currentSourceHashes(),
    answer_annotations_excluded_until_evaluation: true,
    expected_paid_reader_calls: caseIds.length,
    expected_abstention_case_ids: [...expectedAbstentionIds].sort(),
  });
  await output.writeAtomic("gate-manifest.json", manifest);

  const gatewayFactory =
    dependencies.gatewayFactory
    ?? (async (args): Promise<StructuredModelGateway> =>
      ModelGateway.create({
        roles: args.roles,
        captureModelIo: args.captureModelIo,
        providerModelLimits: args.providerModelLimits,
        scheduleStore: args.scheduleStore,
      }));
  const models = await gatewayFactory({
    roles,
    providerModelLimits: sourceManifest.config.agent.provider_model_limits,
    captureModelIo: true,
    scheduleStore: output,
  });
  const prompts = new PromptLoader();

  const settled = await Promise.allSettled(
    sourceCases.map((source) =>
      runOneReader({
        source,
        outputRoot,
        runtimeOptions: sourceManifest.config.agent.options,
        models,
        prompts,
      }),
    ),
  );
  const outcomes: RepairOutcome[] = settled.map((result, index) => {
    const source = sourceCases[index];
    if (!source) throw new Error(`lost source case at index ${String(index)}`);
    if (result.status === "fulfilled") {
      return RepairOutcomeSchema.parse({
        status: "completed",
        ...result.value,
      });
    }
    return RepairOutcomeSchema.parse({
      status: "failed",
      questionId: source.questionId,
      questionType: source.questionType,
      error: errorText(result.reason),
    });
  });

  // Gold annotations are parsed only after every Reader request has settled.
  const references = z.array(ReferenceDatasetCaseSchema).parse(
    JSON.parse(datasetBody.toString("utf8")) as unknown,
  );
  const referenceById = new Map(
    references.map((item) => [item.question_id, item.answer_session_ids]),
  );
  const successfulById = new Map(
    outcomes
      .filter((outcome): outcome is RepairOutcome & SuccessfulRepair & { status: "completed" } =>
        outcome.status === "completed",
      )
      .map((outcome) => [outcome.questionId, outcome]),
  );
  const caseEvaluations = sourceCases.map((source) => {
    const result = successfulById.get(source.questionId);
    const referenceSessionIds = referenceById.get(source.questionId);
    if (!referenceSessionIds) {
      throw new Error(`dataset references missing requested case: ${source.questionId}`);
    }
    const retrievalIds = candidateSessionIds(source.retrieval);
    if (!result) {
      const failure = outcomes.find((outcome) => outcome.questionId === source.questionId);
      return {
        question_id: source.questionId,
        question_type: source.questionType,
        status: "failed",
        reference_session_ids: referenceSessionIds,
        retrieval_session_ids: [...retrievalIds].sort(),
        retrieval_hit: referenceSessionIds.some((id) => retrievalIds.has(id)),
        reader_source_session_ids: [],
        reader_hit: false,
        support_status: null,
        nonempty_plan: false,
        warnings: [],
        unknown_reference_warnings: [],
        usage: null,
        estimated_cost_usd: 0,
        error:
          failure?.status === "failed"
            ? failure.error
            : "Reader outcome missing",
      };
    }
    const readerIds = readerSourceSessionIds(result.plan, source.graph);
    const unknownWarnings = unknownReferenceWarnings(result.warnings);
    return {
      question_id: source.questionId,
      question_type: source.questionType,
      status: "completed",
      reference_session_ids: referenceSessionIds,
      retrieval_session_ids: [...retrievalIds].sort(),
      retrieval_hit: referenceSessionIds.some((id) => retrievalIds.has(id)),
      reader_source_session_ids: [...readerIds].sort(),
      reader_hit: referenceSessionIds.some((id) => readerIds.has(id)),
      support_status: result.plan.supportStatus,
      answer_mode: result.plan.answerMode,
      nonempty_plan: nonemptyPlan(result.plan),
      warnings: result.warnings,
      unknown_reference_warnings: unknownWarnings,
      usage: result.call.usage,
      retry_count: result.call.retry_count,
      latency_ms: result.call.latency_ms,
      request_id: result.call.request_id,
      estimated_cost_usd: usageCost(result.call, roles.reader),
      error: null,
    };
  });
  const completed = outcomes.filter((outcome) => outcome.status === "completed");
  const failures = outcomes.filter((outcome) => outcome.status === "failed");
  const inputTokens = completed.reduce(
    (total, outcome) => total + (outcome.call.usage.input_tokens ?? 0),
    0,
  );
  const outputTokens = completed.reduce(
    (total, outcome) => total + (outcome.call.usage.output_tokens ?? 0),
    0,
  );
  const retryCount = completed.reduce(
    (total, outcome) => total + outcome.call.retry_count,
    0,
  );
  const estimatedCostUsd = completed.reduce(
    (total, outcome) => total + usageCost(outcome.call, roles.reader),
    0,
  );
  const supportSessionHits = caseEvaluations.filter(
    (item) =>
      !expectedAbstentionIds.has(item.question_id)
      && item.reader_hit,
  ).length;
  const sufficientNonemptyPlans = caseEvaluations.filter(
    (item) =>
      !expectedAbstentionIds.has(item.question_id)
      &&
      item.support_status === "sufficient"
      && item.nonempty_plan,
  ).length;
  const correctAbstentions = caseEvaluations.filter(
    (item) =>
      expectedAbstentionIds.has(item.question_id)
      && item.support_status === "insufficient"
      && !item.nonempty_plan,
  ).length;
  const unknownReferenceCount = caseEvaluations.reduce(
    (total, item) => total + item.unknown_reference_warnings.length,
    0,
  );
  const checks = {
    retrieval_support_available: caseEvaluations
      .filter((item) => !expectedAbstentionIds.has(item.question_id))
      .every((item) => item.retrieval_hit),
    support_session_hits: supportSessionHits === expectedAnswerableCount,
    sufficient_nonempty_plans:
      sufficientNonemptyPlans === expectedAnswerableCount,
    correct_abstentions: correctAbstentions === expectedAbstentionIds.size,
    zero_unknown_references: unknownReferenceCount === 0,
    zero_failures: failures.length === 0,
    exactly_one_reader_call_per_case:
      completed.length === caseIds.length,
  };
  const verdict = Object.values(checks).every(Boolean) ? "passed" : "failed";
  const report: JsonObject = JsonObjectSchema.parse({
    schema_version: 1,
    gate_id: basename(outputRoot),
    architecture_id: "0003.2-hybrid-graph-reader",
    generated_at: (dependencies.now ?? (() => new Date()))().toISOString(),
    source_run_id: sourceManifest.run_id,
    dataset_sha256: sha256Buffer(datasetBody),
    paid_api_calls: true,
    answer_annotations_excluded_until_evaluation: true,
    thresholds: {
      requested_cases: caseIds.length,
      answerable_cases: expectedAnswerableCount,
      abstention_cases: expectedAbstentionIds.size,
      support_session_hits: expectedAnswerableCount,
      sufficient_nonempty_plans: expectedAnswerableCount,
      correct_abstentions: expectedAbstentionIds.size,
      unknown_reference_count: 0,
      failure_count: 0,
      reader_calls_per_case: 1,
    },
    metrics: {
      requested_case_count: caseIds.length,
      completed_case_count: completed.length,
      failure_count: failures.length,
      retrieval_hit_count: caseEvaluations.filter((item) => item.retrieval_hit).length,
      support_session_hits: supportSessionHits,
      sufficient_nonempty_plan_count: sufficientNonemptyPlans,
      correct_abstention_count: correctAbstentions,
      unknown_reference_count: unknownReferenceCount,
      reader_call_count: completed.length,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      retry_count: retryCount,
      estimated_cost_usd: estimatedCostUsd,
    },
    checks,
    verdict,
    cases: caseEvaluations,
    failures,
  });
  await output.writeAtomic("gate-report.json", report);
  return { verdict, report, manifest };
}
