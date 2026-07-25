import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { createReadMemoryNode } from "../nodes/readMemory.js";
import { retrieveMemory } from "../retrieval/hybridRetrieval.js";
import type { WorkflowRuntime } from "../runtime.js";
import { ArtifactStore, EventRecorder } from "../services/artifacts.js";
import { ModelGateway } from "../services/modelGateway.js";
import { PromptLoader } from "../services/promptLoader.js";
import { emptyState } from "../state.js";
import {
  ProviderRoleConfigSchema,
  ReaderPlanSchema,
  TurnSchema,
  type JsonObject,
  type ReaderPlan,
  type TimestampedSession,
} from "../types.js";

const DatasetCaseSchema = z.looseObject({
  question_id: z.string().min(1),
  question_type: z.string().min(1),
  question: z.string(),
  question_date: z.string(),
  answer_session_ids: z.array(z.string()),
  haystack_dates: z.array(z.string()),
  haystack_session_ids: z.array(z.string()),
  haystack_sessions: z.array(z.array(TurnSchema)),
});

const ArgumentsSchema = z.strictObject({
  dataset: z.string().min(1),
  output: z.string().min(1),
  answerableIds: z.array(z.string().min(1)).length(12),
  abstentionIds: z.array(z.string().min(1)).length(4),
  model: z.string().min(1),
});

type LabResult = {
  questionId: string;
  questionType: string;
  cohort: "answerable" | "abstention";
  readerPlan: ReaderPlan;
  warnings: string[];
  modelCallCount: number;
  inputTokens: number;
  outputTokens: number;
  retryCount: number;
};
type ReaderGateCohort = LabResult["cohort"];

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function listArgument(name: string): string[] {
  return (argument(name) ?? "").split(",").filter(Boolean);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sessionsFor(item: z.infer<typeof DatasetCaseSchema>): TimestampedSession[] {
  if (
    item.haystack_sessions.length !== item.haystack_session_ids.length
    || item.haystack_sessions.length !== item.haystack_dates.length
  ) {
    throw new Error(`misaligned session arrays for ${item.question_id}`);
  }
  return item.haystack_sessions.map((turns, index) => {
    const sessionId = item.haystack_session_ids[index];
    const date = item.haystack_dates[index];
    if (!sessionId || !date) throw new Error(`missing session metadata at ${item.question_id}/${String(index)}`);
    return { session_id: sessionId, date, turns };
  });
}

function usageValue(
  call: JsonObject | undefined,
  field: "input_tokens" | "output_tokens",
): number {
  const usage = call?.usage;
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) return 0;
  const value = usage[field];
  return typeof value === "number" ? value : 0;
}

async function main(): Promise<void> {
  const args = ArgumentsSchema.parse({
    dataset: argument("--dataset"),
    output: argument("--output"),
    answerableIds: listArgument("--answerable"),
    abstentionIds: listArgument("--abstentions"),
    model: argument("--model") ?? "gpt-5-nano-2025-08-07",
  });
  const datasetPath = resolve(args.dataset);
  const outputPath = resolve(args.output);
  const datasetBody = await readFile(datasetPath);
  const datasetHash = sha256(datasetBody);
  const dataset = z.array(DatasetCaseSchema).parse(
    JSON.parse(datasetBody.toString("utf8")),
  );
  const requestedEntries: Array<[string, ReaderGateCohort]> = [
    ...args.answerableIds.map((id): [string, ReaderGateCohort] => [id, "answerable"]),
    ...args.abstentionIds.map((id): [string, ReaderGateCohort] => [id, "abstention"]),
  ];
  const requested = new Map<string, ReaderGateCohort>(requestedEntries);
  if (requested.size !== 16) throw new Error("reader gate case IDs must be unique");
  const cases = [...requested].map(([questionId, cohort]) => {
    const item = dataset.find((candidate) => candidate.question_id === questionId);
    if (!item) throw new Error(`unknown reader gate case: ${questionId}`);
    if (cohort === "answerable" && item.question_id.endsWith("_abs")) {
      throw new Error(`answerable cohort contains abstention case: ${questionId}`);
    }
    if (cohort === "abstention" && !item.question_id.endsWith("_abs")) {
      throw new Error(`abstention cohort contains answerable case: ${questionId}`);
    }
    return { item, cohort };
  });
  await mkdir(outputPath, { recursive: true });
  const rootArtifacts = new ArtifactStore(outputPath);
  await rootArtifacts.initialize();
  const role = ProviderRoleConfigSchema.parse({
    kind: "generation",
    provider: "openai",
    model: args.model,
    temperature: 1,
    reasoning_effort: "high",
    max_output_tokens: 12000,
    timeout_seconds: 300,
    concurrency: 4,
    max_retries: 6,
    min_request_interval_seconds: 0,
    input_price_per_million: 0.05,
    output_price_per_million: 0.40,
  });
  const gateway = await ModelGateway.create({
    roles: { contexto: role, shino: role, reader: role, answer: role },
    captureModelIo: true,
    providerModelLimits: [{
      provider: "openai",
      model: args.model,
      max_concurrency: 2,
      token_budget: 160000,
      window_seconds: 60,
    }],
    scheduleStore: rootArtifacts,
  });
  const prompts = new PromptLoader();

  const results = await Promise.all(cases.map(async ({ item, cohort }): Promise<LabResult> => {
    const sessions = sessionsFor(item);
    const artifacts = new ArtifactStore(resolve(outputPath, "cases", item.question_id));
    await artifacts.initialize();
    const retrieval = retrieveMemory({
      question: item.question,
      questionDate: item.question_date,
      sessions,
      graph: { schemaVersion: 1, revision: 0, context: {}, provenanceByPointer: {} },
      summaries: [],
      mutationRecords: [],
      graphTrackedCount: sessions.length,
      summaryTrackedCount: sessions.length,
    });
    await Promise.all([
      artifacts.writeAtomic(
        "retrieval/index-manifest.json",
        retrieval.manifest as unknown as JsonObject,
      ),
      artifacts.writeAtomic(
        "retrieval/candidates.json",
        retrieval.candidates as unknown as JsonObject,
      ),
    ]);
    const runtime: WorkflowRuntime = {
      options: {
        graph_batch_size: 3,
        summary_batch_size: 9,
        latest_raw_sessions: 9,
        allow_graph_replacement: true,
      },
      artifacts,
      events: new EventRecorder(artifacts),
      models: gateway,
      prompts,
    };
    const state = emptyState(item.question_id);
    state.sessions = sessions;
    state.graphTrackedCount = sessions.length;
    state.summaryTrackedCount = sessions.length;
    state.question = item.question;
    state.questionDate = item.question_date;
    state.retrievalManifest = retrieval.manifest;
    state.retrievalCandidates = retrieval.candidates;
    const update = await createReadMemoryNode(runtime)(state);
    const readerPlan = ReaderPlanSchema.parse(update.readerPlan);
    const calls = await artifacts.readJsonl("model-calls/calls");
    const call = calls[0];
    return {
      questionId: item.question_id,
      questionType: item.question_type,
      cohort,
      readerPlan,
      warnings: update.warnings ?? [],
      modelCallCount: calls.length,
      inputTokens: usageValue(call, "input_tokens"),
      outputTokens: usageValue(call, "output_tokens"),
      retryCount: typeof call?.retry_count === "number" ? call.retry_count : 0,
    };
  }));

  const answerableEvaluation = results
    .filter((result) => result.cohort === "answerable")
    .map((result) => {
      const item = dataset.find((candidate) => candidate.question_id === result.questionId);
      if (!item) throw new Error(`evaluation lost case: ${result.questionId}`);
      const selected = new Set(result.readerPlan.selectedSessions.map((session) => session.sessionId));
      const selectedReferences = item.answer_session_ids.filter((sessionId) =>
        selected.has(sessionId),
      );
      return {
        questionId: result.questionId,
        questionType: result.questionType,
        referenceSessionIds: item.answer_session_ids,
        selectedSessionIds: [...selected],
        supportSessionHit: selectedReferences.length > 0,
        evidenceRecall: selectedReferences.length / item.answer_session_ids.length,
        completeEvidence: selectedReferences.length === item.answer_session_ids.length,
        supportStatus: result.readerPlan.supportStatus,
      };
    });
  const abstentionEvaluation = results
    .filter((result) => result.cohort === "abstention")
    .map((result) => ({
      questionId: result.questionId,
      questionType: result.questionType,
      supportStatus: result.readerPlan.supportStatus,
      answerMode: result.readerPlan.answerMode,
      correct:
        result.readerPlan.supportStatus === "insufficient"
        && result.readerPlan.answerMode === "abstain",
    }));
  const unknownReferenceWarnings = results.flatMap((result) =>
    result.warnings.filter((warning) => warning.includes("unknown")),
  );
  const metrics = {
    supportSessionHits: answerableEvaluation.filter((item) => item.supportSessionHit).length,
    answerableCount: answerableEvaluation.length,
    macroEvidenceRecall:
      answerableEvaluation.reduce((total, item) => total + item.evidenceRecall, 0)
      / answerableEvaluation.length,
    completeEvidenceCount: answerableEvaluation.filter((item) => item.completeEvidence).length,
    abstentionsInsufficient: abstentionEvaluation.filter((item) => item.correct).length,
    abstentionCount: abstentionEvaluation.length,
    unknownReferenceCount: unknownReferenceWarnings.length,
    modelCallCount: results.reduce((total, result) => total + result.modelCallCount, 0),
    inputTokens: results.reduce((total, result) => total + result.inputTokens, 0),
    outputTokens: results.reduce((total, result) => total + result.outputTokens, 0),
    retryCount: results.reduce((total, result) => total + result.retryCount, 0),
  };
  const estimatedCostUsd =
    metrics.inputTokens * 0.05 / 1_000_000
    + metrics.outputTokens * 0.40 / 1_000_000;
  const checks = {
    supportSessionHit: metrics.supportSessionHits === 12,
    macroEvidenceRecall: metrics.macroEvidenceRecall >= 0.9,
    completeEvidence: metrics.completeEvidenceCount >= 10,
    abstentions: metrics.abstentionsInsufficient === 4,
    unknownReferences: metrics.unknownReferenceCount === 0,
    exactlyOnceCalls: metrics.modelCallCount === 16,
  };
  const verdict = Object.values(checks).every(Boolean) ? "passed" : "failed";
  const report: JsonObject = {
    schema_version: 1,
    gate_id: outputPath.split("/").at(-1) ?? "gate-04-reader",
    architecture_id: "0003.2-hybrid-graph-reader",
    status: verdict,
    generated_at: new Date().toISOString(),
    dataset_sha256: datasetHash,
    provider: "openai",
    model: args.model,
    paid_api_calls: true,
    answer_annotations_excluded_from_prompts: true,
    thresholds: {
      support_session_hits: 12,
      macro_evidence_recall: 0.9,
      complete_evidence_count: 10,
      abstentions_insufficient: 4,
      unknown_reference_count: 0,
    },
    metrics: {
      ...metrics,
      estimated_cost_usd: estimatedCostUsd,
    },
    checks,
    verdict,
    answerable_evaluation: answerableEvaluation as unknown as JsonObject[],
    abstention_evaluation: abstentionEvaluation as unknown as JsonObject[],
    unknown_reference_warnings: unknownReferenceWarnings,
  };
  const manifest: JsonObject = {
    schema_version: 1,
    gate_id: report.gate_id ?? "gate-04-reader",
    architecture_id: "0003.2-hybrid-graph-reader",
    dataset_sha256: datasetHash,
    cases: [...requested.keys()],
    model: args.model,
    role: "reader",
    model_calls: metrics.modelCallCount,
    token_usage: {
      input_tokens: metrics.inputTokens,
      output_tokens: metrics.outputTokens,
    },
    cost_usd: estimatedCostUsd,
    prompt_sha256: sha256(await readFile(resolve(import.meta.dirname, "../../prompts/reader.yaml"))),
  };
  await Promise.all([
    rootArtifacts.writeAtomic("gate-report.json", report),
    rootArtifacts.writeAtomic("gate-manifest.json", manifest),
  ]);
  process.stdout.write(`${JSON.stringify({ verdict, metrics: report.metrics, checks }, null, 2)}\n`);
  if (verdict !== "passed") process.exitCode = 1;
}

await main();
