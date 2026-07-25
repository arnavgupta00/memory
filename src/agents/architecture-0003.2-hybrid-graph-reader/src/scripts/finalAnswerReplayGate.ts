import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { ArtifactStore } from "../services/artifacts.js";
import {
  applyGateAnswerSafety,
  GateDatasetCaseSchema,
  ReaderPlanArtifactSchema,
  sessionsForGateCase,
} from "../services/finalAnswerGateSupport.js";
import {
  CompactFinalEvidencePackageSchema,
  FinalAnswerSchema,
  ReaderPlanSchema,
  type JsonObject,
} from "../types.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "../../../../..");

const ArgumentsSchema = z.strictObject({
  source: z.string().min(1),
  output: z.string().min(1),
  dataset: z.string().min(1),
});

const SourceModeSchema = z.looseObject({
  correct: z.number().int().nonnegative(),
  count: z.literal(16),
  perQuestionType: z.record(
    z.string(),
    z.looseObject({ correct: z.number().int().nonnegative() }),
  ),
  questionRestatementCount: z.number().int().nonnegative(),
  invalidEvidenceReferenceCount: z.number().int().nonnegative(),
  supportedWithoutEvidenceCount: z.number().int().nonnegative(),
  answerInputP95Tokens: z.number().int().nonnegative(),
  modelCallCount: z.literal(16),
});

const SourceReportSchema = z.looseObject({
  architecture_id: z.literal("0003.2-hybrid-graph-reader"),
  modes: z.strictObject({
    oracle: SourceModeSchema,
    reader: SourceModeSchema,
  }),
  thresholds: z.record(z.string(), z.unknown()),
  checks: z.record(z.string(), z.boolean()),
});

type EvidenceMode = "oracle" | "reader";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function refuseExisting(path: string): Promise<void> {
  await access(path).then(
    () => {
      throw new Error(`replay output already exists and is immutable: ${path}`);
    },
    (error: unknown) => {
      if (
        error !== null
        && typeof error === "object"
        && "code" in error
        && error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    },
  );
}

async function recomputeMode(args: {
  mode: EvidenceMode;
  source: string;
  casesById: ReadonlyMap<string, z.infer<typeof GateDatasetCaseSchema>>;
}): Promise<{ invalid: number; duplicates: number }> {
  const caseRoot = resolve(args.source, "modes", args.mode, "cases");
  const caseIds = (await readdir(caseRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (caseIds.length !== 16) {
    throw new Error(`${args.mode} replay requires 16 source cases`);
  }
  let invalid = 0;
  let duplicates = 0;
  for (const questionId of caseIds) {
    const item = args.casesById.get(questionId);
    if (!item) throw new Error(`source contains unknown case ${questionId}`);
    const root = resolve(caseRoot, questionId);
    const [rawAnswer, rawPlan, evidencePackage, prediction] = await Promise.all([
      readFile(resolve(root, "final-answer-raw.json"), "utf8").then((body) =>
        FinalAnswerSchema.parse(JSON.parse(body))
      ),
      readFile(resolve(root, "reader-plan.json"), "utf8").then((body) =>
        ReaderPlanSchema.parse(
          ReaderPlanArtifactSchema.parse(JSON.parse(body)),
        )
      ),
      readFile(resolve(root, "compact-final-evidence.json"), "utf8").then(
        (body) => CompactFinalEvidencePackageSchema.parse(JSON.parse(body)),
      ),
      readFile(resolve(root, "prediction.json"), "utf8").then((body) =>
        z.looseObject({
          hypothesis: z.string(),
          evidence: FinalAnswerSchema.shape.evidence,
          support_status: FinalAnswerSchema.shape.supportStatus,
        }).parse(JSON.parse(body))
      ),
    ]);
    const safety = applyGateAnswerSafety({
      question: item.question,
      answer: rawAnswer,
      readerPlan: rawPlan,
      sessions: sessionsForGateCase(item),
      evidencePayload: evidencePackage.payload,
    });
    if (
      safety.answer.hypothesis !== prediction.hypothesis
      || safety.answer.supportStatus !== prediction.support_status
      || JSON.stringify(safety.answer.evidence) !== JSON.stringify(prediction.evidence)
    ) {
      throw new Error(`metric replay changed the persisted answer for ${questionId}`);
    }
    invalid += safety.rejectedEvidenceCount;
    duplicates += safety.duplicateEvidenceCount;
  }
  return { invalid, duplicates };
}

async function main(): Promise<void> {
  const args = ArgumentsSchema.parse({
    source: argument("--source"),
    output: argument("--output"),
    dataset: argument("--dataset")
      ?? resolve(PROJECT_ROOT, "data/raw/longmemeval_s_cleaned.json"),
  });
  const source = resolve(args.source);
  const output = resolve(args.output);
  await refuseExisting(output);
  const [sourceReportBody, datasetBody] = await Promise.all([
    readFile(resolve(source, "gate-report.json")),
    readFile(resolve(args.dataset)),
  ]);
  const sourceReport = SourceReportSchema.parse(
    JSON.parse(sourceReportBody.toString("utf8")),
  );
  const dataset = z.array(GateDatasetCaseSchema).parse(
    JSON.parse(datasetBody.toString("utf8")),
  );
  const casesById = new Map(
    dataset.map((item) => [item.question_id, item]),
  );
  const [oracleMetrics, readerMetrics] = await Promise.all([
    recomputeMode({ mode: "oracle", source, casesById }),
    recomputeMode({ mode: "reader", source, casesById }),
  ]);
  const modes = {
    oracle: {
      ...sourceReport.modes.oracle,
      invalidEvidenceReferenceCount: oracleMetrics.invalid,
      duplicateEvidenceReferenceCount: oracleMetrics.duplicates,
    },
    reader: {
      ...sourceReport.modes.reader,
      invalidEvidenceReferenceCount: readerMetrics.invalid,
      duplicateEvidenceReferenceCount: readerMetrics.duplicates,
    },
  };
  const typeGroups = [
    ...Object.values(modes.oracle.perQuestionType),
    ...Object.values(modes.reader.perQuestionType),
  ];
  const checks = {
    oracleEvidenceAccuracy: modes.oracle.correct >= 15,
    readerEvidenceAccuracy: modes.reader.correct >= 13,
    noQuestionTypeScoresZero: typeGroups.every((group) => group.correct > 0),
    zeroQuestionRestatements:
      modes.oracle.questionRestatementCount
        + modes.reader.questionRestatementCount === 0,
    zeroInvalidEvidenceReferences:
      modes.oracle.invalidEvidenceReferenceCount
        + modes.reader.invalidEvidenceReferenceCount === 0,
    zeroSupportedAnswersWithoutEvidence:
      modes.oracle.supportedWithoutEvidenceCount
        + modes.reader.supportedWithoutEvidenceCount === 0,
    answerInputP95WithinLimit:
      Math.max(
        modes.oracle.answerInputP95Tokens,
        modes.reader.answerInputP95Tokens,
      ) <= 12_000,
    exactlyOnceSourceAnswerCalls:
      modes.oracle.modelCallCount + modes.reader.modelCallCount === 32,
  };
  const verdict = Object.values(checks).every(Boolean) ? "passed" : "failed";
  const store = new ArtifactStore(output);
  await store.initialize();
  const report: JsonObject = {
    schema_version: 1,
    gate_id: output.split("/").at(-1) ?? "gate-05-final-answer-replay",
    architecture_id: "0003.2-hybrid-graph-reader",
    status: verdict,
    generated_at: new Date().toISOString(),
    source_gate: source,
    replay_scope:
      "Reclassify removed duplicate citations separately from invalid references; predictions and judgments are unchanged.",
    thresholds: sourceReport.thresholds as JsonObject,
    modes: modes as unknown as JsonObject,
    checks,
    verdict,
  };
  const manifest: JsonObject = {
    schema_version: 1,
    gate_id: report.gate_id ?? "gate-05-final-answer-replay",
    architecture_id: "0003.2-hybrid-graph-reader",
    source_gate: source,
    source_gate_report_sha256: sha256(sourceReportBody),
    dataset_sha256: sha256(datasetBody),
    source_answer_model_calls: 32,
    source_canonical_judge_calls: 32,
    new_model_calls: 0,
    new_canonical_judge_calls: 0,
    script_sha256: sha256(
      await readFile(resolve(import.meta.dirname, "finalAnswerReplayGate.ts")),
    ),
  };
  await Promise.all([
    store.writeAtomic("gate-report.json", report),
    store.writeAtomic("gate-manifest.json", manifest),
  ]);
  process.stdout.write(`${JSON.stringify({ verdict, checks, modes }, null, 2)}\n`);
  if (verdict !== "passed") process.exitCode = 1;
}

await main();
