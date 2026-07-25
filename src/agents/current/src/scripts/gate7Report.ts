import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import { RetrievalCandidatesSchema } from "../retrieval/types.js";
import { ArtifactStore, EventRecorder } from "../services/artifacts.js";
import {
  verifyFrozenSourceManifest,
} from "../services/blindSelection.js";
import { ReaderPlanArtifactSchema } from "../services/finalAnswerGateSupport.js";
import { funnelStage } from "../services/gate6Funnel.js";
import {
  GATE7_ARCHITECTURE_ID,
  GATE7_CANONICAL_JUDGE_MODEL,
  Gate7RunReportSchema,
  summarizeGate7,
  withUnlockedGate7Inspection,
  type Gate7CaseFunnel,
  type Gate7Judgment,
  type Gate7Prediction,
} from "../services/gate7Report.js";
import { graphHash, replayMutationRecords } from "../services/graphMutations.js";
import {
  AnswerResultSchema,
  ContextoCoverageRecordSchema,
  GraphMutationRecordSchema,
  MasterContextGraphSchema,
  ModelCallRecordSchema,
  type JsonObject,
} from "../types.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "../../../../..");
const CLEANED_DATASET = "longmemeval_s_cleaned.json";

const ArgumentsSchema = z.strictObject({
  selection: z.string().min(1),
  selectionHash: z.string().min(1),
  freezeManifest: z.string().min(1),
  dataset: z.string().min(1),
  runPath: z.string().min(1),
  output: z.string().min(1),
});

const DatasetCaseSchema = z.looseObject({
  question_id: z.string().min(1),
  question_type: z.string().min(1),
  answer_session_ids: z.array(z.string().min(1)),
});

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function lineCount(body: string): number {
  return body.split("\n").filter((line) => line.trim().length > 0).length;
}

async function refuseExisting(path: string): Promise<void> {
  const exists = await access(path).then(() => true).catch(() => false);
  if (exists) throw new Error(`Gate 7 output already exists and is immutable: ${path}`);
}

async function coverageRecords(
  caseRoot: string,
  issues: string[],
): Promise<z.infer<typeof ContextoCoverageRecordSchema>[]> {
  const root = resolve(caseRoot, "contexto-coverage");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  if (files.length === 0) issues.push("missing:contexto-coverage");
  const records: z.infer<typeof ContextoCoverageRecordSchema>[] = [];
  for (const file of files) {
    const parsed = ContextoCoverageRecordSchema.safeParse(
      JSON.parse(await readFile(resolve(root, file), "utf8")),
    );
    if (parsed.success) records.push(parsed.data);
    else issues.push(`invalid:contexto-coverage/${file}`);
  }
  return records;
}

function forbiddenAnnotationPaths(
  value: unknown,
  path = "$",
): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      forbiddenAnnotationPaths(item, `${path}[${String(index)}]`)
    );
  }
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const child = `${path}.${key}`;
    const own = ["answer", "answer_session_ids", "has_answer"].includes(key)
      ? [child]
      : [];
    return [...own, ...forbiddenAnnotationPaths(item, child)];
  });
}

async function readRequired<T>(args: {
  store: ArtifactStore;
  name: string;
  schema: z.ZodType<T>;
  issues: string[];
}): Promise<T | null> {
  const raw = await args.store.readJson<unknown>(args.name);
  if (raw === null) {
    args.issues.push(`missing:${args.name}`);
    return null;
  }
  const parsed = args.schema.safeParse(raw);
  if (!parsed.success) {
    args.issues.push(`invalid:${args.name}`);
    return null;
  }
  return parsed.data;
}

function invalidReferenceCount(trace: Record<string, unknown>): number {
  const value = trace.invalid_evidence_references;
  return Array.isArray(value) ? value.length : 0;
}

async function buildFunnel(args: {
  runRoot: string;
  questionId: string;
  questionType: Gate7CaseFunnel["questionType"];
  abstention: boolean;
  referenceSessionIds: string[];
  prediction: Gate7Prediction;
  judgment: Gate7Judgment;
}): Promise<Gate7CaseFunnel> {
  const artifactIssues: string[] = [];
  const leakageIssues: string[] = [];
  const caseRoot = resolve(
    args.runRoot,
    "agent-artifacts",
    "cases",
    args.questionId,
  );
  const store = new ArtifactStore(caseRoot);
  const finalGraph = await readRequired({
    store,
    name: "final-graph.json",
    schema: MasterContextGraphSchema,
    issues: artifactIssues,
  });
  const retrieval = await readRequired({
    store,
    name: "retrieval/candidates.json",
    schema: RetrievalCandidatesSchema,
    issues: artifactIssues,
  });
  const readerPlan = await readRequired({
    store,
    name: "reader-plan.json",
    schema: ReaderPlanArtifactSchema,
    issues: artifactIssues,
  });
  const answer = await readRequired({
    store,
    name: "answer.json",
    schema: AnswerResultSchema,
    issues: artifactIssues,
  });
  const coverage = await coverageRecords(caseRoot, artifactIssues);
  const required = [
    "events.jsonl",
    "sessions.jsonl",
    "final-context.json",
    "architecture.json",
  ];
  for (const name of required) {
    if (!(await store.exists(name))) artifactIssues.push(`missing:${name}`);
  }
  const sessions = await store.readJsonl("sessions");
  const finalContext = await store.readJson<unknown>("final-context.json");
  leakageIssues.push(
    ...forbiddenAnnotationPaths(sessions),
    ...forbiddenAnnotationPaths(finalContext),
  );
  const persistedCalls = (await store.readJsonl("model-calls/calls"))
    .flatMap((raw) => {
      const parsed = ModelCallRecordSchema.safeParse(raw);
      if (!parsed.success) {
        artifactIssues.push("invalid:model-calls/calls.jsonl");
        return [];
      }
      return [parsed.data];
    });
  if (persistedCalls.length !== args.prediction.model_calls.length) {
    artifactIssues.push("model-call-ledger-count-mismatch");
  }
  if (answer !== null && answer.hypothesis !== args.prediction.hypothesis) {
    artifactIssues.push("answer-artifact-prediction-mismatch");
  }
  const invalidReferences = invalidReferenceCount(args.prediction.trace);
  if (invalidReferences > 0) artifactIssues.push("invalid-evidence-reference");
  if (
    args.prediction.trace.architecture_id !== GATE7_ARCHITECTURE_ID
  ) {
    artifactIssues.push("unexpected-architecture-id");
  }

  let replayHashMatches = false;
  try {
    const events = await new EventRecorder(store).replay();
    const mutations = events
      .filter((event) =>
        ["graph_mutation_applied", "graph_mutation_rejected"].includes(
          event.event_type,
        )
      )
      .map((event) => GraphMutationRecordSchema.parse(event.payload));
    const replayed = replayMutationRecords(mutations);
    replayHashMatches = finalGraph !== null
      && graphHash(replayed) === graphHash(finalGraph);
    if (!replayHashMatches) {
      artifactIssues.push("replay-final-graph-hash-mismatch");
    }
  } catch {
    artifactIssues.push("invalid:event-replay");
  }
  if (
    finalGraph !== null
    && typeof args.prediction.trace.graph_hash === "string"
    && args.prediction.trace.graph_hash !== graphHash(finalGraph)
  ) {
    artifactIssues.push("prediction-final-graph-hash-mismatch");
  }

  const graphSessionIds = finalGraph === null
    ? []
    : Object.values(finalGraph.provenanceByPointer)
      .flatMap((sources) => sources.map((source) => source.sessionId));
  const fallbackSessionIds = coverage.flatMap((record) =>
    record.signals
      .filter((signal) =>
        signal.status === "session_index_fallback"
        || signal.status === "duplicate"
      )
      .map((signal) => signal.sessionId)
  );
  const retrievalSessionIds = retrieval === null
    ? []
    : [
        ...retrieval.sessions.map((candidate) =>
          candidate.session.session_id
        ),
        ...retrieval.tailSessions.map((candidate) =>
          candidate.session.session_id
        ),
        ...retrieval.coverageFallbackSessions.map((candidate) =>
          candidate.sessionId
        ),
        ...retrieval.graphCells.flatMap((candidate) =>
          candidate.sessionIds
        ),
      ];
  const readerSessionIds = readerPlan === null
    ? []
    : readerPlan.selectedSessions.map((item) => item.sessionId);
  const answerSessionIds = args.prediction.evidence.map(
    (item) => item.session_id,
  );
  const failures = await store.readJsonl("model-calls/failures");
  return {
    questionId: args.questionId,
    questionType: args.questionType,
    abstention: args.abstention,
    referenceSessionIds: args.referenceSessionIds,
    graphCoverage: funnelStage(args.referenceSessionIds, graphSessionIds),
    graphOrCoverageFallback: funnelStage(
      args.referenceSessionIds,
      [...graphSessionIds, ...fallbackSessionIds],
    ),
    retrievalCoverage: funnelStage(
      args.referenceSessionIds,
      retrievalSessionIds,
    ),
    readerSelection: funnelStage(
      args.referenceSessionIds,
      readerSessionIds,
    ),
    answerEvidence: funnelStage(args.referenceSessionIds, answerSessionIds),
    answer: {
      hypothesis: args.prediction.hypothesis,
      nonEmpty: args.prediction.hypothesis.trim().length > 0,
      supportStatus:
        typeof args.prediction.trace.support_status === "string"
          ? args.prediction.trace.support_status
          : null,
      invalidReferenceCount: invalidReferences,
    },
    canonicalJudgment: {
      model: GATE7_CANONICAL_JUDGE_MODEL,
      correct: args.judgment.autoeval_label.label,
    },
    replayHashMatches,
    leakageIssues: [...new Set(leakageIssues)].sort(),
    artifactIssues: [...new Set(artifactIssues)].sort(),
    modelFailureCount: failures.length,
  };
}

async function main(): Promise<void> {
  const runId = argument("--run-id");
  const explicitRunPath = argument("--run-path");
  if ((runId === undefined) === (explicitRunPath === undefined)) {
    throw new Error("provide exactly one of --run-id or --run-path");
  }
  const runPath = explicitRunPath === undefined
    ? resolve(PROJECT_ROOT, "runs", runId ?? "")
    : resolve(explicitRunPath);
  const args = ArgumentsSchema.parse({
    selection: argument("--blind-selection"),
    selectionHash: argument("--selection-hash")
      ?? resolve(dirname(argument("--blind-selection") ?? ""), "blind-selection.sha256"),
    freezeManifest: argument("--freeze-manifest"),
    dataset: argument("--dataset")
      ?? resolve(PROJECT_ROOT, "data/raw/longmemeval_s_cleaned.json"),
    runPath,
    output: argument("--output"),
  });
  await refuseExisting(resolve(args.output));
  const verifiedFreeze = await verifyFrozenSourceManifest({
    projectRoot: PROJECT_ROOT,
    manifestPath: resolve(args.freezeManifest),
    datasetPath: resolve(args.dataset),
    architectureId: GATE7_ARCHITECTURE_ID,
  });
  const [
    selectionBody,
    selectionHashBody,
    manifestBody,
    predictionsBody,
    judgmentsBody,
  ] = await Promise.all([
    readFile(resolve(args.selection), "utf8"),
    readFile(resolve(args.selectionHash), "utf8"),
    readFile(resolve(args.runPath, "manifest.json"), "utf8"),
    readFile(resolve(args.runPath, "predictions.jsonl"), "utf8"),
    readFile(resolve(args.runPath, "judgments.jsonl"), "utf8"),
  ]);
  const expectedRunId = runId ?? args.runPath.split("/").at(-1) ?? "";

  await withUnlockedGate7Inspection({
    selectionBody,
    selectionHashBody,
    freezeManifestSha256: verifiedFreeze.manifestSha256,
    datasetSha256: verifiedFreeze.datasetSha256,
    runManifestBody: manifestBody,
    predictionsBody,
    judgmentsBody,
    expectedRunId,
  }, async (unlocked) => {
    // No semantic dataset or case artifact read occurs before this callback.
    const [datasetBody, reportBody, runConfigBody] = await Promise.all([
      readFile(resolve(args.dataset)),
      readFile(resolve(args.runPath, "report.json"), "utf8"),
      readFile(resolve(args.runPath, "config.yaml")),
    ]);
    const dataset = z.array(DatasetCaseSchema).parse(
      JSON.parse(datasetBody.toString("utf8")),
    );
    const report = Gate7RunReportSchema.parse(JSON.parse(reportBody));
    const globalArtifactIssues: string[] = [];
    const globalLeakageIssues: string[] = [];
    if (
      unlocked.manifest.dataset_hashes[CLEANED_DATASET]
        !== verifiedFreeze.datasetSha256
    ) {
      globalArtifactIssues.push("run-dataset-freeze-mismatch");
    }
    if (
      !Object.values(verifiedFreeze.manifest.config_hashes)
        .includes(sha256(runConfigBody))
    ) {
      globalArtifactIssues.push("run-config-freeze-mismatch");
    }
    const datasetById = new Map(
      dataset.map((item) => [item.question_id, item]),
    );
    const predictionById = new Map(
      unlocked.predictions.map((item) => [item.question_id, item]),
    );
    const judgmentById = new Map(
      unlocked.judgments.map((item) => [item.question_id, item]),
    );
    const funnels = await Promise.all(
      unlocked.selection.selected.map(async (selected) => {
        const item = datasetById.get(selected.questionId);
        const prediction = predictionById.get(selected.questionId);
        const judgment = judgmentById.get(selected.questionId);
        if (item === undefined || prediction === undefined || judgment === undefined) {
          throw new Error(`unlocked Gate 7 case is missing: ${selected.questionId}`);
        }
        if (
          item.question_type !== selected.questionType
          || prediction.question_type !== selected.questionType
          || selected.abstention !== selected.questionId.endsWith("_abs")
        ) {
          globalArtifactIssues.push("selection-case-metadata-mismatch");
        }
        return buildFunnel({
          runRoot: args.runPath,
          questionId: selected.questionId,
          questionType: selected.questionType,
          abstention: selected.abstention,
          referenceSessionIds: item.answer_session_ids,
          prediction,
          judgment,
        });
      }),
    );
    const runErrors = await Promise.all([
      readFile(resolve(args.runPath, "errors.jsonl"), "utf8").catch(() => ""),
      readFile(resolve(args.runPath, "failures.jsonl"), "utf8").catch(() => ""),
    ]);
    const modelFailureCount = funnels.reduce(
      (total, item) => total + item.modelFailureCount,
      0,
    );
    const failureCount = Math.max(
      unlocked.manifest.failure_count,
      report.failure_count,
      ...runErrors.map(lineCount),
    ) + modelFailureCount;
    const summary = summarizeGate7({
      funnels,
      runReport: report,
      failureCount,
      duplicateCount: 0,
      globalLeakageIssueCount: globalLeakageIssues.length,
      globalArtifactIssueCount: globalArtifactIssues.length,
    });
    const output = new ArtifactStore(resolve(args.output));
    await output.initialize();
    await Promise.all([
      output.writeAtomic("gate-report.json", {
        schema_version: 1,
        gate_id: resolve(args.output).split("/").at(-1) ?? "gate-07-blind-proof",
        architecture_id: GATE7_ARCHITECTURE_ID,
        source_run_id: expectedRunId,
        generated_at: new Date().toISOString(),
        sealed_inspection_unlocked: true,
        thresholds: {
          overall_correct: 14,
          each_question_type_correct: 2,
          abstention_correct: 3,
          failures: 0,
          duplicates: 0,
          leakage_issues: 0,
          replay_mismatches: 0,
          artifact_issues: 0,
          agent_cost_usd_max: 0.864,
        },
        summary: summary as unknown as JsonObject,
        global_artifact_issues: globalArtifactIssues,
        global_leakage_issues: globalLeakageIssues,
        case_funnels: funnels as unknown as JsonObject[],
        verdict: summary.verdict,
      }),
      output.writeAtomic("gate-manifest.json", {
        schema_version: 1,
        gate_id: resolve(args.output).split("/").at(-1) ?? "gate-07-blind-proof",
        architecture_id: GATE7_ARCHITECTURE_ID,
        source_run_id: expectedRunId,
        source_manifest_sha256: sha256(manifestBody),
        source_predictions_sha256: sha256(predictionsBody),
        source_judgments_sha256: sha256(judgmentsBody),
        source_report_sha256: sha256(reportBody),
        blind_selection_file_sha256: unlocked.selectionFileSha256,
        blind_selection_payload_sha256:
          unlocked.selection.selectionPayloadSha256,
        freeze_manifest_sha256: verifiedFreeze.manifestSha256,
        dataset_sha256: verifiedFreeze.datasetSha256,
        cases: unlocked.selection.selected.map((item) => item.questionId),
        canonical_judge_model: GATE7_CANONICAL_JUDGE_MODEL,
        read_only_source: true,
        command: process.argv,
      }),
    ]);
    process.stdout.write(`${JSON.stringify({
      verdict: summary.verdict,
      checks: summary.checks,
      overall: summary.overall,
      abstentions: summary.abstentions,
      perQuestionType: summary.perQuestionType,
      cost: summary.agentCostUsd,
    }, null, 2)}\n`);
    if (summary.verdict !== "passed") process.exitCode = 1;
  });
}

await main();
