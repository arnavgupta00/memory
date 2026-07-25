import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  readFile,
  readdir,
  unlink,
} from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { ArtifactStore } from "../services/artifacts.js";
import {
  buildCompactFinalEvidencePackage,
} from "../services/finalEvidencePackage.js";
import {
  createCandidateConstrainedFinalAnswerSchema,
} from "../services/finalAnswerSchema.js";
import {
  applyGateAnswerSafety,
  buildOracleReaderPlan,
  CanonicalJudgmentSchema,
  emptyGateGraph,
  GateDatasetCaseSchema,
  percentile95,
  ReaderPlanArtifactSchema,
  sessionsForGateCase,
  type CanonicalJudgment,
  type GateDatasetCase,
} from "../services/finalAnswerGateSupport.js";
import { ModelGateway } from "../services/modelGateway.js";
import { PromptLoader } from "../services/promptLoader.js";
import {
  ProviderRoleConfigSchema,
  ReaderPlanSchema,
  type FinalAnswer,
  type JsonObject,
  type ReaderPlan,
} from "../types.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "../../../../..");
const ANSWER_INPUT_PRICE_PER_MILLION = 0.05;
const ANSWER_OUTPUT_PRICE_PER_MILLION = 0.40;

const ArgumentsSchema = z.strictObject({
  dataset: z.string().min(1),
  readerPlans: z.string().min(1),
  output: z.string().min(1),
  reference: z.string().min(1),
  evaluator: z.string().min(1),
  lock: z.string().min(1),
  model: z.string().min(1),
});

const BenchmarkLockSchema = z.strictObject({
  schema_version: z.literal(1),
  canonical_judge: z.strictObject({
    model: z.literal("gpt-4o-2024-08-06"),
    provider: z.literal("openai"),
    temperature: z.literal(0),
  }),
  dataset: z.looseObject({
    revision: z.string().min(1),
    files: z.record(
      z.string(),
      z.looseObject({ sha256: z.string().length(64) }),
    ),
  }),
  longmemeval: z.looseObject({
    revision: z.string().min(1),
    evaluator: z.looseObject({ sha256: z.string().length(64) }),
  }),
});

const Gate4SourceReportSchema = z.looseObject({
  architecture_id: z.literal("0003.2-hybrid-graph-reader"),
  verdict: z.literal("passed"),
  dataset_sha256: z.string().length(64),
});

const Gate4SourceManifestSchema = z.looseObject({
  architecture_id: z.literal("0003.2-hybrid-graph-reader"),
  dataset_sha256: z.string().length(64),
  source_model_calls: z.number().int().positive(),
  new_model_calls: z.literal(0),
});

type EvidenceMode = "oracle" | "reader";

type ModeCaseResult = {
  mode: EvidenceMode;
  questionId: string;
  questionType: string;
  answer: FinalAnswer;
  modelCallReused: boolean;
  inputTokens: number;
  outputTokens: number;
  retryCount: number;
  latencyMs: number;
  promptByteEstimate: number;
  promptTokenEstimate: number;
  omittedEvidenceItems: number;
  rejectedEvidenceCount: number;
  duplicateEvidenceCount: number;
  questionRestatement: boolean;
  supportedWithoutEvidence: boolean;
};

type QuestionTypeAccuracy = {
  correct: number;
  count: number;
  accuracy: number;
};

type ModeReport = {
  mode: EvidenceMode;
  correct: number;
  count: number;
  accuracy: number;
  perQuestionType: Record<string, QuestionTypeAccuracy>;
  questionRestatementCount: number;
  invalidEvidenceReferenceCount: number;
  duplicateEvidenceReferenceCount: number;
  supportedWithoutEvidenceCount: number;
  answerInputP95Tokens: number;
  answerInputTokens: number;
  answerOutputTokens: number;
  retryCount: number;
  answerLatencyMs: number;
  modelCallCount: number;
  reusedModelCallCount: number;
  estimatedAnswerCostUsd: number;
};

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asJsonObject(value: object): JsonObject {
  return value as unknown as JsonObject;
}

function parseJsonl<T>(body: string, schema: z.ZodType<T>): T[] {
  return body
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => schema.parse(JSON.parse(line)));
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
  throw new Error(`Gate 5 output already exists and is immutable: ${path}`);
}

async function loadReaderPlans(path: string): Promise<Map<string, ReaderPlan>> {
  const entries = await readdir(path, { withFileTypes: true });
  const caseIds = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (caseIds.length !== 16) {
    throw new Error(
      `Gate 5 requires exactly 16 Gate 4 plans, found ${String(caseIds.length)}`,
    );
  }
  const plans = new Map<string, ReaderPlan>();
  for (const caseId of caseIds) {
    const raw = ReaderPlanArtifactSchema.parse(
      JSON.parse(
        await readFile(resolve(path, caseId, "reader-plan.json"), "utf8"),
      ),
    );
    plans.set(caseId, ReaderPlanSchema.parse(raw));
  }
  return plans;
}

function modePlan(
  mode: EvidenceMode,
  item: GateDatasetCase,
  readerPlans: ReadonlyMap<string, ReaderPlan>,
): ReaderPlan {
  if (mode === "oracle") return buildOracleReaderPlan(item);
  const plan = readerPlans.get(item.question_id);
  if (plan === undefined) {
    throw new Error(`missing Gate 4 reader plan for ${item.question_id}`);
  }
  return plan;
}

async function validateReaderPlanSource(args: {
  readerPlansPath: string;
  readerPlans: ReadonlyMap<string, ReaderPlan>;
  cases: readonly GateDatasetCase[];
  datasetHash: string;
}): Promise<void> {
  const gateRoot = resolve(args.readerPlansPath, "..");
  const [report, manifest] = await Promise.all([
    readFile(resolve(gateRoot, "gate-report.json"), "utf8").then((body) =>
      Gate4SourceReportSchema.parse(JSON.parse(body))
    ),
    readFile(resolve(gateRoot, "gate-manifest.json"), "utf8").then((body) =>
      Gate4SourceManifestSchema.parse(JSON.parse(body))
    ),
  ]);
  if (
    report.dataset_sha256 !== args.datasetHash
    || manifest.dataset_sha256 !== args.datasetHash
  ) {
    throw new Error("Gate 5 reader plans do not match the pinned dataset");
  }
  let supportHits = 0;
  let recallTotal = 0;
  let completeEvidence = 0;
  let correctAbstentions = 0;
  for (const item of args.cases) {
    const plan = args.readerPlans.get(item.question_id);
    if (!plan) throw new Error(`reader source lost ${item.question_id}`);
    if (item.question_id.endsWith("_abs")) {
      if (
        plan.supportStatus === "insufficient"
        && plan.answerMode === "abstain"
      ) {
        correctAbstentions += 1;
      }
      continue;
    }
    const selected = new Set(
      plan.selectedSessions.map((session) => session.sessionId),
    );
    const matched = item.answer_session_ids.filter((sessionId) =>
      selected.has(sessionId)
    ).length;
    if (matched > 0) supportHits += 1;
    recallTotal += matched / item.answer_session_ids.length;
    if (matched === item.answer_session_ids.length) completeEvidence += 1;
  }
  if (
    supportHits !== 12
    || recallTotal / 12 < 0.9
    || completeEvidence < 10
    || correctAbstentions !== 4
  ) {
    throw new Error("Gate 5 reader plans fail the Gate 4 acceptance thresholds");
  }
}

async function executeModeCase(args: {
  mode: EvidenceMode;
  item: GateDatasetCase;
  plan: ReaderPlan;
  outputPath: string;
  gateway: ModelGateway;
  prompts: PromptLoader;
}): Promise<ModeCaseResult> {
  const sessions = sessionsForGateCase(args.item);
  const graph = emptyGateGraph();
  const artifacts = new ArtifactStore(
    resolve(args.outputPath, "modes", args.mode, "cases", args.item.question_id),
  );
  await artifacts.initialize();
  const evidencePackage = buildCompactFinalEvidencePackage({
    plan: args.plan,
    sessions,
    graph,
  });
  await Promise.all([
    artifacts.writeAtomic(
      "reader-plan.json",
      asJsonObject(args.plan),
    ),
    artifacts.writeAtomic(
      "compact-final-evidence.json",
      asJsonObject(evidencePackage),
    ),
  ]);
  const prompt = await args.prompts.render("final-answer", {
    question: args.item.question,
    question_date: args.item.question_date,
    reader_plan: JSON.stringify(args.plan, null, 2),
    evidence_package: JSON.stringify(evidencePackage.payload, null, 2),
  });
  const response = await args.gateway.generateStructured({
    role: "answer",
    callKey: `answer:${args.mode}`,
    prompt,
    schemaName: "final_answer_v1",
    schema: createCandidateConstrainedFinalAnswerSchema(
      evidencePackage.payload,
    ),
    artifacts,
  });
  const safety = applyGateAnswerSafety({
    question: args.item.question,
    answer: response.value,
    readerPlan: args.plan,
    sessions,
    evidencePayload: evidencePackage.payload,
  });
  await Promise.all([
    artifacts.writeAtomic(
      "final-answer-raw.json",
      asJsonObject(response.value),
    ),
    artifacts.writeAtomic(
      "final-answer-safety.json",
      asJsonObject(safety),
    ),
    artifacts.writeAtomic(
      "prediction.json",
      {
        question_id: args.item.question_id,
        hypothesis: safety.answer.hypothesis,
        evidence: safety.answer.evidence as unknown as JsonObject[],
        support_status: safety.answer.supportStatus,
      },
    ),
  ]);
  return {
    mode: args.mode,
    questionId: args.item.question_id,
    questionType: args.item.question_type,
    answer: safety.answer,
    modelCallReused: response.reused,
    inputTokens: response.call.usage.input_tokens ?? 0,
    outputTokens: response.call.usage.output_tokens ?? 0,
    retryCount: response.call.retry_count,
    latencyMs: response.call.latency_ms,
    promptByteEstimate: evidencePackage.promptByteEstimate,
    promptTokenEstimate: evidencePackage.promptTokenEstimate,
    omittedEvidenceItems: evidencePackage.omittedItems.length,
    rejectedEvidenceCount: safety.rejectedEvidenceCount,
    duplicateEvidenceCount: safety.duplicateEvidenceCount,
    questionRestatement: safety.questionRestatement,
    supportedWithoutEvidence: safety.supportedWithoutEvidence,
  };
}

async function writeModePredictions(
  outputPath: string,
  mode: EvidenceMode,
  results: readonly ModeCaseResult[],
): Promise<string> {
  const store = new ArtifactStore(resolve(outputPath, "modes", mode));
  await store.initialize();
  for (const result of [...results].sort((left, right) =>
    left.questionId.localeCompare(right.questionId)
  )) {
    await store.append("predictions", {
      question_id: result.questionId,
      hypothesis: result.answer.hypothesis,
      evidence: result.answer.evidence as unknown as JsonObject[],
      support_status: result.answer.supportStatus,
    });
  }
  return resolve(store.root, "predictions.jsonl");
}

async function runCanonicalEvaluator(args: {
  outputPath: string;
  mode: EvidenceMode;
  predictionPath: string;
  evaluatorPath: string;
  referencePath: string;
}): Promise<CanonicalJudgment[]> {
  const store = new ArtifactStore(resolve(args.outputPath, "modes", args.mode));
  const command = [
    "run",
    "python",
    args.evaluatorPath,
    "gpt-4o",
    args.predictionPath,
    args.referencePath,
  ];
  const { exitCode, stdout, stderr } = await new Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>((resolvePromise, reject) => {
    const child = spawn("uv", command, {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ exitCode: code ?? -1, stdout, stderr });
    });
  });
  await Promise.all([
    store.writeAtomic("canonical-evaluator.stdout.log", stdout),
    store.writeAtomic("canonical-evaluator.stderr.log", stderr),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `canonical evaluator failed for ${args.mode} with exit ${String(exitCode)}`,
    );
  }
  const generatedPath = `${args.predictionPath}.eval-results-gpt-4o`;
  const judgmentBody = await readFile(generatedPath, "utf8");
  const judgments = parseJsonl(judgmentBody, CanonicalJudgmentSchema);
  if (judgments.length !== 16) {
    throw new Error(
      `canonical evaluator returned ${String(judgments.length)} ${args.mode} judgments`,
    );
  }
  if (new Set(judgments.map((item) => item.question_id)).size !== 16) {
    throw new Error(`canonical evaluator returned duplicate ${args.mode} judgments`);
  }
  await store.writeAtomic("judgments.jsonl", judgmentBody);
  await unlink(generatedPath);
  return judgments;
}

function buildModeReport(
  mode: EvidenceMode,
  results: readonly ModeCaseResult[],
  judgments: readonly CanonicalJudgment[],
): ModeReport {
  const labelById = new Map(
    judgments.map((judgment) => [
      judgment.question_id,
      judgment.autoeval_label.label,
    ]),
  );
  const grouped = new Map<string, boolean[]>();
  for (const result of results) {
    const label = labelById.get(result.questionId);
    if (label === undefined) {
      throw new Error(`missing ${mode} judgment for ${result.questionId}`);
    }
    const values = grouped.get(result.questionType) ?? [];
    values.push(label);
    grouped.set(result.questionType, values);
  }
  const perQuestionType: Record<string, QuestionTypeAccuracy> = {};
  for (const [questionType, labels] of [...grouped].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const correct = labels.filter(Boolean).length;
    perQuestionType[questionType] = {
      correct,
      count: labels.length,
      accuracy: correct / labels.length,
    };
  }
  const inputTokens = results.reduce(
    (total, result) => total + result.inputTokens,
    0,
  );
  const outputTokens = results.reduce(
    (total, result) => total + result.outputTokens,
    0,
  );
  const correct = judgments.filter(
    (judgment) => judgment.autoeval_label.label,
  ).length;
  return {
    mode,
    correct,
    count: judgments.length,
    accuracy: correct / judgments.length,
    perQuestionType,
    questionRestatementCount: results.filter(
      (result) => result.questionRestatement,
    ).length,
    invalidEvidenceReferenceCount: results.reduce(
      (total, result) => total + result.rejectedEvidenceCount,
      0,
    ),
    duplicateEvidenceReferenceCount: results.reduce(
      (total, result) => total + result.duplicateEvidenceCount,
      0,
    ),
    supportedWithoutEvidenceCount: results.filter(
      (result) => result.supportedWithoutEvidence,
    ).length,
    answerInputP95Tokens: percentile95(
      results.map((result) => result.inputTokens),
    ),
    answerInputTokens: inputTokens,
    answerOutputTokens: outputTokens,
    retryCount: results.reduce(
      (total, result) => total + result.retryCount,
      0,
    ),
    answerLatencyMs: results.reduce(
      (total, result) => total + result.latencyMs,
      0,
    ),
    modelCallCount: results.length,
    reusedModelCallCount: results.filter(
      (result) => result.modelCallReused,
    ).length,
    estimatedAnswerCostUsd:
      inputTokens * ANSWER_INPUT_PRICE_PER_MILLION / 1_000_000
      + outputTokens * ANSWER_OUTPUT_PRICE_PER_MILLION / 1_000_000,
  };
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is required for Gate 5 answer and canonical judge calls",
    );
  }
  const args = ArgumentsSchema.parse({
    dataset: argument("--dataset")
      ?? resolve(PROJECT_ROOT, "data/raw/longmemeval_s_cleaned.json"),
    readerPlans: argument("--reader-plans"),
    output: argument("--output"),
    reference: argument("--reference")
      ?? resolve(PROJECT_ROOT, "data/raw/longmemeval_oracle.json"),
    evaluator: argument("--evaluator")
      ?? resolve(PROJECT_ROOT, ".cache/upstream/evaluate_qa.py"),
    lock: argument("--lock")
      ?? resolve(PROJECT_ROOT, "benchmark.lock.json"),
    model: argument("--model") ?? "gpt-5-nano-2025-08-07",
  });
  const outputPath = resolve(args.output);
  await refuseExistingOutput(outputPath);

  const [
    datasetBody,
    referenceBody,
    evaluatorBody,
    lockBody,
  ] = await Promise.all([
    readFile(resolve(args.dataset)),
    readFile(resolve(args.reference)),
    readFile(resolve(args.evaluator)),
    readFile(resolve(args.lock)),
  ]);
  const lock = BenchmarkLockSchema.parse(
    JSON.parse(lockBody.toString("utf8")),
  );
  const datasetHash = sha256(datasetBody);
  const referenceHash = sha256(referenceBody);
  const evaluatorHash = sha256(evaluatorBody);
  if (
    datasetHash
      !== lock.dataset.files["longmemeval_s_cleaned.json"]?.sha256
    || referenceHash
      !== lock.dataset.files["longmemeval_oracle.json"]?.sha256
    || evaluatorHash !== lock.longmemeval.evaluator.sha256
  ) {
    throw new Error("Gate 5 refused an unpinned dataset, reference, or evaluator");
  }

  const readerPlansPath = resolve(args.readerPlans);
  const readerPlans = await loadReaderPlans(readerPlansPath);
  const dataset = z.array(GateDatasetCaseSchema).parse(
    JSON.parse(datasetBody.toString("utf8")),
  );
  const cases = [...readerPlans.keys()].map((questionId) => {
    const item = dataset.find((candidate) =>
      candidate.question_id === questionId
    );
    if (item === undefined) {
      throw new Error(`Gate 4 plan names unknown case ${questionId}`);
    }
    return item;
  });
  if (
    cases.filter((item) => item.question_id.endsWith("_abs")).length !== 4
    || cases.filter((item) => !item.question_id.endsWith("_abs")).length !== 12
  ) {
    throw new Error("Gate 5 requires twelve answerable and four abstention cases");
  }
  await validateReaderPlanSource({
    readerPlansPath,
    readerPlans,
    cases,
    datasetHash,
  });

  const rootArtifacts = new ArtifactStore(outputPath);
  await rootArtifacts.initialize();
  const role = ProviderRoleConfigSchema.parse({
    kind: "generation",
    provider: "openai",
    model: args.model,
    temperature: 1,
    reasoning_effort: "high",
    max_output_tokens: 8000,
    timeout_seconds: 300,
    concurrency: 4,
    max_retries: 6,
    min_request_interval_seconds: 0,
    input_price_per_million: ANSWER_INPUT_PRICE_PER_MILLION,
    output_price_per_million: ANSWER_OUTPUT_PRICE_PER_MILLION,
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
  const oracleExecutions = await Promise.all(
    cases.map((item) =>
      executeModeCase({
        mode: "oracle",
        item,
        plan: modePlan("oracle", item, readerPlans),
        outputPath,
        gateway,
        prompts,
      })
    ),
  );
  const oraclePredictionPath = await writeModePredictions(
    outputPath,
    "oracle",
    oracleExecutions,
  );
  const oracleJudgments = await runCanonicalEvaluator({
    outputPath,
    mode: "oracle",
    predictionPath: oraclePredictionPath,
    evaluatorPath: resolve(args.evaluator),
    referencePath: resolve(args.reference),
  });
  const oracleReport = buildModeReport(
    "oracle",
    oracleExecutions,
    oracleJudgments,
  );
  if (oracleReport.correct < 15) {
    await rootArtifacts.writeAtomic("gate-report.json", {
      schema_version: 1,
      gate_id: outputPath.split("/").at(-1) ?? "gate-05-final-answer",
      architecture_id: "0003.2-hybrid-graph-reader",
      status: "failed",
      generated_at: new Date().toISOString(),
      stopped_after: "oracle_evidence",
      reason: "oracle evidence upper bound did not reach 15/16",
      modes: { oracle: oracleReport as unknown as JsonObject },
      canonical_judge: {
        provider: "openai",
        model: "gpt-4o-2024-08-06",
        temperature: 0,
        call_count: 16,
      },
      verdict: "failed",
    });
    throw new Error(
      `Gate 5 stopped after oracle evidence scored ${String(oracleReport.correct)}/16`,
    );
  }
  const readerExecutions = await Promise.all(
    cases.map((item) =>
      executeModeCase({
        mode: "reader",
        item,
        plan: modePlan("reader", item, readerPlans),
        outputPath,
        gateway,
        prompts,
      })
    ),
  );
  const readerPredictionPath = await writeModePredictions(
    outputPath,
    "reader",
    readerExecutions,
  );
  const readerJudgments = await runCanonicalEvaluator({
    outputPath,
    mode: "reader",
    predictionPath: readerPredictionPath,
    evaluatorPath: resolve(args.evaluator),
    referencePath: resolve(args.reference),
  });
  const readerReport = buildModeReport(
    "reader",
    readerExecutions,
    readerJudgments,
  );
  const typeGroups = [
    ...Object.values(oracleReport.perQuestionType),
    ...Object.values(readerReport.perQuestionType),
  ];
  const checks = {
    oracleEvidenceAccuracy: oracleReport.correct >= 15,
    readerEvidenceAccuracy: readerReport.correct >= 13,
    noQuestionTypeScoresZero: typeGroups.every((group) => group.correct > 0),
    zeroQuestionRestatements:
      oracleReport.questionRestatementCount
        + readerReport.questionRestatementCount
      === 0,
    zeroInvalidEvidenceReferences:
      oracleReport.invalidEvidenceReferenceCount
        + readerReport.invalidEvidenceReferenceCount
      === 0,
    zeroSupportedAnswersWithoutEvidence:
      oracleReport.supportedWithoutEvidenceCount
        + readerReport.supportedWithoutEvidenceCount
      === 0,
    answerInputP95WithinLimit:
      Math.max(
        oracleReport.answerInputP95Tokens,
        readerReport.answerInputP95Tokens,
      ) <= 12_000,
    exactlyOnceAnswerCalls:
      oracleReport.modelCallCount + readerReport.modelCallCount === 32
      && oracleReport.reusedModelCallCount
        + readerReport.reusedModelCallCount === 0,
    completeCanonicalJudgments:
      oracleJudgments.length === 16 && readerJudgments.length === 16,
  };
  const verdict = Object.values(checks).every(Boolean) ? "passed" : "failed";
  const promptPath = resolve(
    import.meta.dirname,
    "../../prompts/final-answer.yaml",
  );
  const planBodies = await Promise.all(
    [...readerPlans.keys()].sort().map(async (questionId) =>
      `${questionId}\n${
        await readFile(
          resolve(readerPlansPath, questionId, "reader-plan.json"),
          "utf8",
        )
      }`
    ),
  );
  const report: JsonObject = {
    schema_version: 1,
    gate_id: outputPath.split("/").at(-1) ?? "gate-05-final-answer",
    architecture_id: "0003.2-hybrid-graph-reader",
    status: verdict,
    generated_at: new Date().toISOString(),
    thresholds: {
      oracle_correct: 15,
      reader_correct: 13,
      no_question_type_zero: true,
      question_restatements: 0,
      invalid_evidence_references: 0,
      supported_answers_without_evidence: 0,
      answer_input_p95_tokens: 12000,
    },
    modes: {
      oracle: oracleReport as unknown as JsonObject,
      reader: readerReport as unknown as JsonObject,
    },
    canonical_judge: {
      provider: "openai",
      model: "gpt-4o-2024-08-06",
      temperature: 0,
      call_count: 32,
      estimated_cost_usd: null,
      cost_note:
        "The pinned upstream evaluator does not expose canonical-judge token usage.",
    },
    checks,
    verdict,
  };
  const manifest: JsonObject = {
    schema_version: 1,
    gate_id: report.gate_id ?? "gate-05-final-answer",
    architecture_id: "0003.2-hybrid-graph-reader",
    dataset_sha256: datasetHash,
    reference_sha256: referenceHash,
    evaluator_sha256: evaluatorHash,
    dataset_revision: lock.dataset.revision,
    longmemeval_revision: lock.longmemeval.revision,
    source_reader_plans: readerPlansPath,
    source_reader_plans_sha256: sha256(planBodies.join("\n")),
    cases: cases.map((item) => item.question_id),
    provider: "openai",
    answer_model: args.model,
    answer_model_calls: 32,
    answer_cost_usd:
      oracleReport.estimatedAnswerCostUsd
      + readerReport.estimatedAnswerCostUsd,
    canonical_judge_model: "gpt-4o-2024-08-06",
    canonical_judge_calls: 32,
    prompt_sha256: sha256(await readFile(promptPath)),
    script_sha256: sha256(
      await readFile(resolve(import.meta.dirname, "finalAnswerGate.ts")),
    ),
    command: process.argv,
  };
  await Promise.all([
    rootArtifacts.writeAtomic("gate-report.json", report),
    rootArtifacts.writeAtomic("gate-manifest.json", manifest),
  ]);
  process.stdout.write(
    `${JSON.stringify({ verdict, checks, oracle: oracleReport, reader: readerReport }, null, 2)}\n`,
  );
  if (verdict !== "passed") process.exitCode = 1;
}

await main();
