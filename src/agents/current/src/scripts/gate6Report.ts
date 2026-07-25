import { createHash } from "node:crypto";
import {
  access,
  readFile,
  readdir,
} from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { RetrievalCandidatesSchema } from "../retrieval/types.js";
import {
  ArtifactStore,
  EventRecorder,
} from "../services/artifacts.js";
import {
  exposedGroup,
  funnelStage,
  GATE6_EXPOSED_CASE_IDS,
  summarizeGate6,
  type Gate6CaseFunnel,
} from "../services/gate6Funnel.js";
import {
  graphHash,
  replayMutationRecords,
} from "../services/graphMutations.js";
import {
  loadIntegrityRecovery,
  type IntegrityRecoveryCaseProof,
  type LoadedIntegrityRecovery,
} from "../services/integrityRecovery.js";
import {
  ReaderPlanArtifactSchema,
} from "../services/finalAnswerGateSupport.js";
import {
  AnswerResultSchema,
  ContextoCoverageRecordSchema,
  GraphMutationRecordSchema,
  MasterContextGraphSchema,
  ModelCallRecordSchema,
  type JsonObject,
} from "../types.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "../../../../..");

const ArgumentsSchema = z.strictObject({
  runId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
  output: z.string().min(1),
  dataset: z.string().min(1),
  lock: z.string().min(1),
  recovery: z.string().min(1).optional(),
});

const DatasetCaseSchema = z.looseObject({
  question_id: z.string().min(1),
  question_type: z.string().min(1),
  answer_session_ids: z.array(z.string().min(1)).min(1),
});

const PredictionSchema = z.looseObject({
  question_id: z.string().min(1),
  question_type: z.string().min(1),
  hypothesis: z.string(),
  evidence: z.array(z.looseObject({
    session_id: z.string(),
    turn_index: z.number().int().nonnegative().nullable().optional(),
  })),
  trace: z.record(z.string(), z.unknown()),
  model_calls: z.array(ModelCallRecordSchema),
});

const JudgmentSchema = z.looseObject({
  question_id: z.string().min(1),
  hypothesis: z.string(),
  autoeval_label: z.strictObject({
    model: z.literal("gpt-4o-2024-08-06"),
    label: z.boolean(),
  }),
});

const ManifestSchema = z.looseObject({
  run_id: z.string().min(1),
  status: z.literal("completed"),
  selected_count: z.literal(12),
  completed_count: z.literal(12),
  failure_count: z.number().int().nonnegative(),
  selected_question_ids: z.array(z.string()).length(12),
});

const RunReportSchema = z.looseObject({
  status: z.literal("completed"),
  completed_count: z.literal(12),
  judged_count: z.literal(12),
  failure_count: z.number().int().nonnegative(),
  usage: z.looseObject({
    model_call_count: z.number().int().nonnegative(),
    by_role: z.record(z.string(), z.looseObject({
      retry_count: z.number().int().nonnegative(),
    })),
  }),
  cost: z.looseObject({
    estimated_total: z.number().nonnegative(),
  }),
});

const LockSchema = z.looseObject({
  dataset: z.looseObject({
    revision: z.string().min(1),
    files: z.record(z.string(), z.looseObject({
      sha256: z.string().length(64),
    })),
  }),
  longmemeval: z.looseObject({
    revision: z.string().min(1),
  }),
});

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseJsonl<T>(body: string, schema: z.ZodType<T>): T[] {
  return body
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => schema.parse(JSON.parse(line)));
}

function exactCaseSet(values: readonly string[]): boolean {
  const expected = new Set<string>(GATE6_EXPOSED_CASE_IDS);
  return values.length === expected.size
    && new Set(values).size === expected.size
    && values.every((value) => expected.has(value));
}

async function refuseExistingOutput(path: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if (
      error !== null
      && typeof error === "object"
      && "code" in error
      && error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
  throw new Error(`Gate 6 report output already exists and is immutable: ${path}`);
}

async function readRequiredArtifact<T>(args: {
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
  const records = [];
  for (const file of files) {
    const parsed = ContextoCoverageRecordSchema.safeParse(
      JSON.parse(await readFile(resolve(root, file), "utf8")),
    );
    if (!parsed.success) {
      issues.push(`invalid:contexto-coverage/${file}`);
      continue;
    }
    records.push(parsed.data);
  }
  return records;
}

function invalidReferenceCount(trace: Record<string, unknown>): number {
  const value = trace.invalid_evidence_references;
  return Array.isArray(value) ? value.length : 0;
}

async function buildCaseFunnel(args: {
  runRoot: string;
  questionId: string;
  questionType: string;
  referenceSessionIds: string[];
  prediction: z.infer<typeof PredictionSchema>;
  judgment: z.infer<typeof JudgmentSchema>;
  recoveredGraph: z.infer<typeof MasterContextGraphSchema> | null;
  recoveryProof: IntegrityRecoveryCaseProof | null;
  recoveryGateId: string | null;
}): Promise<Gate6CaseFunnel> {
  const issues: string[] = [];
  const caseRoot = resolve(
    args.runRoot,
    "agent-artifacts",
    "cases",
    args.questionId,
  );
  const store = new ArtifactStore(caseRoot);
  const [
    originalFinalGraphRaw,
    retrieval,
    readerPlan,
    answerArtifact,
    coverage,
  ] = await Promise.all([
    store.readJson<unknown>("final-graph.json"),
    readRequiredArtifact({
      store,
      name: "retrieval/candidates.json",
      schema: RetrievalCandidatesSchema,
      issues,
    }),
    readRequiredArtifact({
      store,
      name: "reader-plan.json",
      schema: ReaderPlanArtifactSchema,
      issues,
    }),
    readRequiredArtifact({
      store,
      name: "answer.json",
      schema: AnswerResultSchema,
      issues,
    }),
    coverageRecords(caseRoot, issues),
  ]);
  let finalGraph: z.infer<typeof MasterContextGraphSchema> | null = null;
  let integrityRecovery: Gate6CaseFunnel["integrityRecovery"] = null;
  if (
    args.recoveredGraph !== null
    && args.recoveryProof !== null
    && args.recoveryGateId !== null
  ) {
    finalGraph = args.recoveredGraph;
    integrityRecovery = {
      gateId: args.recoveryGateId,
      originalSnapshotSha256:
        args.recoveryProof.source_final_graph_sha256,
      originalSnapshotSchemaValid:
        args.recoveryProof.source_snapshot_schema_valid,
      originalSnapshotSchemaErrors:
        args.recoveryProof.source_snapshot_schema_errors,
      replayGraphHash: args.recoveryProof.replay_graph_hash,
      predictionGraphHash: args.recoveryProof.prediction_graph_hash,
      recoveredGraphHash: args.recoveryProof.recovered_graph_hash,
      proofComplete: true,
    };
  } else if (originalFinalGraphRaw === null) {
    issues.push("missing:final-graph.json");
  } else {
    const parsed = MasterContextGraphSchema.safeParse(originalFinalGraphRaw);
    if (parsed.success) {
      finalGraph = parsed.data;
    } else {
      issues.push("invalid:final-graph.json");
    }
  }
  for (const required of [
    "events.jsonl",
    "sessions.jsonl",
    "final-context.json",
    "architecture.json",
  ]) {
    if (!(await store.exists(required))) issues.push(`missing:${required}`);
  }
  const persistedCalls = (await store.readJsonl("model-calls/calls"))
    .flatMap((call) => {
      const parsed = ModelCallRecordSchema.safeParse(call);
      if (!parsed.success) {
        issues.push("invalid:model-calls/calls.jsonl");
        return [];
      }
      return [parsed.data];
    });
  if (persistedCalls.length !== args.prediction.model_calls.length) {
    issues.push("model-call-ledger-count-mismatch");
  }
  if (
    answerArtifact !== null
    && answerArtifact.hypothesis !== args.prediction.hypothesis
  ) {
    issues.push("answer-artifact-prediction-mismatch");
  }

  let replayHashMatches = false;
  try {
    const events = await new EventRecorder(store).replay();
    const mutationRecords = events
      .filter((event) =>
        [
          "graph_mutation_applied",
          "graph_mutation_rejected",
        ].includes(event.event_type)
      )
      .map((event) => GraphMutationRecordSchema.parse(event.payload));
    const replayed = replayMutationRecords(mutationRecords);
    replayHashMatches =
      finalGraph !== null
      && graphHash(replayed) === graphHash(finalGraph);
    if (!replayHashMatches) issues.push("replay-final-graph-hash-mismatch");
  } catch {
    issues.push("invalid:event-replay");
  }
  if (
    finalGraph !== null
    && typeof args.prediction.trace.graph_hash === "string"
    && args.prediction.trace.graph_hash !== graphHash(finalGraph)
  ) {
    issues.push("prediction-final-graph-hash-mismatch");
  }
  if (
    args.prediction.trace.architecture_id
      !== "0003.2-hybrid-graph-reader"
  ) {
    issues.push("unexpected-architecture-id");
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
      .map((signal) => signal.sessionId),
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
    : readerPlan.selectedSessions.map((selected) => selected.sessionId);
  const answerEvidenceIds = args.prediction.evidence.map(
    (evidence) => evidence.session_id,
  );
  return {
    questionId: args.questionId,
    questionType: args.questionType,
    group: exposedGroup(args.questionId),
    referenceSessionIds: args.referenceSessionIds,
    graphCoverage: funnelStage(
      args.referenceSessionIds,
      graphSessionIds,
    ),
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
    answerEvidence: funnelStage(
      args.referenceSessionIds,
      answerEvidenceIds,
    ),
    answer: {
      hypothesis: args.prediction.hypothesis,
      nonEmpty: args.prediction.hypothesis.trim().length > 0,
      supportStatus:
        typeof args.prediction.trace.support_status === "string"
          ? args.prediction.trace.support_status
          : null,
      invalidReferenceCount: invalidReferenceCount(args.prediction.trace),
    },
    canonicalJudgment: {
      model: "gpt-4o-2024-08-06",
      correct: args.judgment.autoeval_label.label,
    },
    integrityRecovery,
    replayHashMatches,
    artifactIssues: [...new Set(issues)].sort(),
  };
}

async function main(): Promise<void> {
  const args = ArgumentsSchema.parse({
    runId: argument("--run-id"),
    output: argument("--output"),
    dataset: argument("--dataset")
      ?? resolve(PROJECT_ROOT, "data/raw/longmemeval_s_cleaned.json"),
    lock: argument("--lock")
      ?? resolve(PROJECT_ROOT, "benchmark.lock.json"),
    recovery: argument("--recovery"),
  });
  const runRoot = resolve(PROJECT_ROOT, "runs", args.runId);
  const outputPath = resolve(args.output);
  const manifest = ManifestSchema.parse(
    JSON.parse(await readFile(resolve(runRoot, "manifest.json"), "utf8")),
  );
  if (manifest.run_id !== args.runId) {
    throw new Error("Gate 6 run ID does not match its manifest");
  }
  await refuseExistingOutput(outputPath);

  const [
    manifestBody,
    datasetBody,
    lockBody,
    predictionsBody,
    judgmentsBody,
    reportBody,
  ] = await Promise.all([
    readFile(resolve(runRoot, "manifest.json")),
    readFile(resolve(args.dataset)),
    readFile(resolve(args.lock)),
    readFile(resolve(runRoot, "predictions.jsonl"), "utf8"),
    readFile(resolve(runRoot, "judgments.jsonl"), "utf8"),
    readFile(resolve(runRoot, "report.json"), "utf8"),
  ]);
  const lock = LockSchema.parse(JSON.parse(lockBody.toString("utf8")));
  const datasetHash = sha256(datasetBody);
  if (
    datasetHash
      !== lock.dataset.files["longmemeval_s_cleaned.json"]?.sha256
  ) {
    throw new Error("Gate 6 refused an unpinned cleaned dataset");
  }
  const dataset = z.array(DatasetCaseSchema).parse(
    JSON.parse(datasetBody.toString("utf8")),
  );
  const predictions = parseJsonl(predictionsBody, PredictionSchema);
  const judgments = parseJsonl(judgmentsBody, JudgmentSchema);
  const runReport = RunReportSchema.parse(JSON.parse(reportBody));
  const globalIssues: string[] = [];
  if (!exactCaseSet(manifest.selected_question_ids)) {
    globalIssues.push("manifest-case-set-mismatch");
  }
  if (!exactCaseSet(predictions.map((item) => item.question_id))) {
    globalIssues.push("prediction-case-set-mismatch");
  }
  if (!exactCaseSet(judgments.map((item) => item.question_id))) {
    globalIssues.push("judgment-case-set-mismatch");
  }
  if (new Set(predictions.map((item) => item.question_id)).size !== 12) {
    globalIssues.push("duplicate-prediction-id");
  }
  if (new Set(judgments.map((item) => item.question_id)).size !== 12) {
    globalIssues.push("duplicate-judgment-id");
  }
  const predictionsById = new Map(
    predictions.map((prediction) => [prediction.question_id, prediction]),
  );
  const judgmentsById = new Map(
    judgments.map((judgment) => [judgment.question_id, judgment]),
  );
  const casesById = new Map(
    dataset.map((item) => [item.question_id, item]),
  );
  let integrityRecovery: LoadedIntegrityRecovery | null = null;
  if (args.recovery !== undefined) {
    integrityRecovery = await loadIntegrityRecovery({
      recoveryRoot: resolve(args.recovery),
      sourceRunId: args.runId,
      sourceManifestSha256: sha256(manifestBody),
      sourcePredictionsSha256: sha256(predictionsBody),
      currentSourceCaseRoots: new Map(
        GATE6_EXPOSED_CASE_IDS.map((questionId) => [
          questionId,
          resolve(
            runRoot,
            "agent-artifacts",
            "cases",
            questionId,
          ),
        ]),
      ),
    });
  }

  const funnels = await Promise.all(
    GATE6_EXPOSED_CASE_IDS.map(async (questionId) => {
      const item = casesById.get(questionId);
      const prediction = predictionsById.get(questionId);
      const judgment = judgmentsById.get(questionId);
      if (item === undefined || prediction === undefined || judgment === undefined) {
        throw new Error(`Gate 6 cannot build missing case ${questionId}`);
      }
      return buildCaseFunnel({
        runRoot,
        questionId,
        questionType: item.question_type,
        referenceSessionIds: item.answer_session_ids,
        prediction,
        judgment,
        recoveredGraph:
          integrityRecovery?.graphsByQuestionId.get(questionId) ?? null,
        recoveryProof:
          integrityRecovery?.proofsByQuestionId.get(questionId) ?? null,
        recoveryGateId: integrityRecovery?.gateId ?? null,
      });
    }),
  );
  const retryCount = Object.values(runReport.usage.by_role)
    .reduce((total, role) => total + role.retry_count, 0);
  const failureBody = await readFile(
    resolve(runRoot, "failures.jsonl"),
    "utf8",
  ).catch(() => "");
  const failureLineCount = failureBody
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .length;
  const failureCount = Math.max(
    manifest.failure_count,
    runReport.failure_count,
    failureLineCount,
  );
  const summary = summarizeGate6({
    funnels,
    failureCount,
    retryCount,
    modelCallCount: runReport.usage.model_call_count,
    agentCostUsd: runReport.cost.estimated_total,
    globalArtifactIssueCount: globalIssues.length,
  });
  const recoveryProofComplete =
    integrityRecovery === null
    || (
      integrityRecovery.graphsByQuestionId.size > 0
      && integrityRecovery.graphsByQuestionId.size
        === integrityRecovery.proofsByQuestionId.size
      && funnels.filter((item) => item.integrityRecovery !== null).length
        === integrityRecovery.graphsByQuestionId.size
    );
  const checks = {
    ...summary.checks,
    integrityRecoveryProofComplete: recoveryProofComplete,
  };
  const verdict = summary.verdict === "passed" && recoveryProofComplete
    ? "passed"
    : "failed";
  const report: JsonObject = {
    schema_version: 1,
    gate_id: outputPath.split("/").at(-1) ?? "gate-06-exposed-regression",
    architecture_id: "0003.2-hybrid-graph-reader",
    source_run_id: args.runId,
    source_run_path: runRoot,
    generated_at: new Date().toISOString(),
    thresholds: {
      overall_correct: 10,
      each_prior_group_correct: 5,
      no_question_type_zero: true,
      failure_count: 0,
      replay_mismatch_count: 0,
      retry_rate_exclusive_max: 0.05,
      agent_cost_usd_max: 0.574,
      integrity_recovery_proof_complete: true,
    },
    summary: summary as unknown as JsonObject,
    checks,
    integrity_recovery: integrityRecovery === null
      ? null
      : {
          gate_id: integrityRecovery.gateId,
          proof_complete: recoveryProofComplete,
          recovered_question_ids: [
            ...integrityRecovery.graphsByQuestionId.keys(),
          ].sort(),
          manifest_sha256: integrityRecovery.manifestSha256,
          report_sha256: integrityRecovery.reportSha256,
        },
    global_artifact_issues: globalIssues,
    case_funnels: funnels as unknown as JsonObject[],
    verdict,
  };
  const output = new ArtifactStore(outputPath);
  await output.initialize();
  await Promise.all([
    output.writeAtomic("gate-report.json", report),
    output.writeAtomic("gate-manifest.json", {
      schema_version: 1,
      gate_id: report.gate_id ?? "gate-06-exposed-regression",
      source_run_id: args.runId,
      source_manifest_sha256: sha256(
        manifestBody,
      ),
      source_predictions_sha256: sha256(predictionsBody),
      source_judgments_sha256: sha256(judgmentsBody),
      source_report_sha256: sha256(reportBody),
      dataset_sha256: datasetHash,
      dataset_revision: lock.dataset.revision,
      longmemeval_revision: lock.longmemeval.revision,
      cases: [...GATE6_EXPOSED_CASE_IDS],
      read_only_source: true,
      canonical_judge_model: "gpt-4o-2024-08-06",
      integrity_recovery: integrityRecovery === null
        ? null
        : {
            gate_id: integrityRecovery.gateId,
            manifest_sha256: integrityRecovery.manifestSha256,
            report_sha256: integrityRecovery.reportSha256,
          },
      command: process.argv,
    }),
  ]);
  process.stdout.write(
    `${JSON.stringify({ verdict, checks, overall: summary.overall, groups: summary.groups }, null, 2)}\n`,
  );
  if (verdict !== "passed") process.exitCode = 1;
}

await main();
