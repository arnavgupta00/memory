import { createHash } from "node:crypto";

import { z } from "zod";

import {
  assertBlindInspectionUnlocked,
  BlindSelectionSchema,
  OFFICIAL_QUESTION_TYPES,
  REQUIRED_ABSTENTION_TYPES,
  verifyBlindSelectionSeal,
  type BlindSelection,
  type OfficialQuestionType,
} from "./blindSelection.js";
import type { FunnelStage } from "./gate6Funnel.js";
import { ModelCallRecordSchema } from "../types.js";

const ARCHITECTURE_ID = "0003.2-hybrid-graph-reader";
const CANONICAL_JUDGE_MODEL = "gpt-4o-2024-08-06";

const PredictionProofSchema = z.looseObject({
  question_id: z.string().min(1),
});

const JudgmentProofSchema = z.looseObject({
  question_id: z.string().min(1),
  autoeval_label: z.strictObject({
    model: z.literal(CANONICAL_JUDGE_MODEL),
    label: z.boolean(),
  }),
});

export const Gate7PredictionSchema = z.looseObject({
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
export type Gate7Prediction = z.infer<typeof Gate7PredictionSchema>;

export const Gate7JudgmentSchema = JudgmentProofSchema.extend({
  hypothesis: z.string(),
});
export type Gate7Judgment = z.infer<typeof Gate7JudgmentSchema>;

export const Gate7RunManifestSchema = z.looseObject({
  run_id: z.string().min(1),
  status: z.literal("completed"),
  selected_count: z.literal(18),
  completed_count: z.literal(18),
  failure_count: z.number().int().nonnegative(),
  selected_question_ids: z.array(z.string().min(1)).length(18),
  dataset_hashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/u)),
});
export type Gate7RunManifest = z.infer<typeof Gate7RunManifestSchema>;

export const Gate7RunReportSchema = z.looseObject({
  status: z.literal("completed"),
  judge_model: z.literal(CANONICAL_JUDGE_MODEL),
  completed_count: z.literal(18),
  judged_count: z.literal(18),
  failure_count: z.number().int().nonnegative(),
  usage: z.looseObject({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
    model_call_count: z.number().int().nonnegative(),
    total_model_latency_ms: z.number().nonnegative(),
    by_role: z.record(z.string(), z.looseObject({
      call_count: z.number().int().nonnegative(),
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
      total_tokens: z.number().int().nonnegative(),
      latency_ms: z.number().nonnegative(),
      retry_count: z.number().int().nonnegative(),
    })),
  }),
  cost: z.looseObject({
    currency: z.literal("USD"),
    estimated_total: z.number().nonnegative(),
  }),
});
export type Gate7RunReport = z.infer<typeof Gate7RunReportSchema>;

export type Gate7SealInputs = {
  selectionBody: string;
  selectionHashBody: string;
  freezeManifestSha256: string;
  datasetSha256: string;
  runManifestBody: string;
  predictionsBody: string;
  judgmentsBody: string;
  expectedRunId: string;
};

export type Gate7UnlockedInputs = {
  selection: BlindSelection;
  manifest: Gate7RunManifest;
  predictions: Gate7Prediction[];
  judgments: Gate7Judgment[];
  selectionFileSha256: string;
};

export type Gate7CaseFunnel = {
  questionId: string;
  questionType: OfficialQuestionType;
  abstention: boolean;
  referenceSessionIds: string[];
  graphCoverage: FunnelStage;
  graphOrCoverageFallback: FunnelStage;
  retrievalCoverage: FunnelStage;
  readerSelection: FunnelStage;
  answerEvidence: FunnelStage;
  answer: {
    hypothesis: string;
    nonEmpty: boolean;
    supportStatus: string | null;
    invalidReferenceCount: number;
  };
  canonicalJudgment: {
    model: typeof CANONICAL_JUDGE_MODEL;
    correct: boolean;
  };
  replayHashMatches: boolean;
  leakageIssues: string[];
  artifactIssues: string[];
  modelFailureCount: number;
};

type Accuracy = {
  correct: number;
  count: number;
  accuracy: number;
};

export type Gate7Summary = {
  overall: Accuracy;
  abstentions: Accuracy;
  perQuestionType: Record<OfficialQuestionType, Accuracy>;
  failureCount: number;
  duplicateCount: number;
  leakageIssueCount: number;
  replayMismatchCount: number;
  artifactIssueCount: number;
  modelCallCount: number;
  retryCount: number;
  retryRate: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalModelLatencyMs: number;
  agentCostUsd: number;
  checks: {
    exactSelectionShape: boolean;
    overallAccuracy: boolean;
    eachQuestionType: boolean;
    abstentionAccuracy: boolean;
    canonicalJudge: boolean;
    zeroFailures: boolean;
    zeroDuplicates: boolean;
    zeroLeakage: boolean;
    zeroReplayMismatches: boolean;
    zeroArtifactIssues: boolean;
    agentCost: boolean;
  };
  verdict: "passed" | "failed";
};

function rawSha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseJsonlProof<T>(
  body: string,
  schema: z.ZodType<T>,
): T[] {
  return body
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => schema.parse(JSON.parse(line)));
}

function sameIdSet(
  expected: readonly string[],
  candidate: readonly string[],
): boolean {
  const expectedSet = new Set(expected);
  return (
    expected.length === candidate.length
    && expectedSet.size === expected.length
    && new Set(candidate).size === candidate.length
    && candidate.every((questionId) => expectedSet.has(questionId))
  );
}

function verifySelectionFileHash(
  selectionBody: string,
  hashBody: string,
): string {
  const actual = rawSha256(selectionBody);
  const expectedLine = `${actual}  blind-selection.json\n`;
  if (hashBody !== expectedLine) {
    throw new Error("blind-selection file hash mismatch");
  }
  return actual;
}

/**
 * Performs only freeze/seal/completeness checks. Callers must not read dataset
 * semantics or per-case artifacts before this function returns.
 */
export function unlockGate7Inspection(
  inputs: Gate7SealInputs,
): Gate7UnlockedInputs {
  const selectionFileSha256 = verifySelectionFileHash(
    inputs.selectionBody,
    inputs.selectionHashBody,
  );
  const selection = verifyBlindSelectionSeal(
    BlindSelectionSchema.parse(JSON.parse(inputs.selectionBody)),
  );
  if (selection.architectureId !== ARCHITECTURE_ID) {
    throw new Error("blind selection uses an unexpected architecture");
  }
  if (selection.freezeManifestSha256 !== inputs.freezeManifestSha256) {
    throw new Error("blind selection is not bound to the verified freeze manifest");
  }
  if (selection.datasetSha256 !== inputs.datasetSha256) {
    throw new Error("blind selection is not bound to the verified dataset");
  }
  const manifest = Gate7RunManifestSchema.parse(
    JSON.parse(inputs.runManifestBody),
  );
  if (manifest.run_id !== inputs.expectedRunId) {
    throw new Error("Gate 7 run ID does not match its manifest");
  }
  const selectedIds = selection.selected.map((item) => item.questionId);
  if (!sameIdSet(selectedIds, manifest.selected_question_ids)) {
    throw new Error("Gate 7 run manifest does not match the sealed selection");
  }

  // Parse only the minimum ID/judge proof before the unlock assertion.
  const predictionProof = parseJsonlProof(
    inputs.predictionsBody,
    PredictionProofSchema,
  ).map(({ question_id }) => ({ question_id }));
  const judgmentProof = parseJsonlProof(
    inputs.judgmentsBody,
    JudgmentProofSchema,
  ).map(({ question_id, autoeval_label }) => ({
    question_id,
    autoeval_label,
  }));
  assertBlindInspectionUnlocked(selection, {
    predictions: predictionProof,
    judgments: judgmentProof,
  });

  // Full prediction and judgment content becomes readable only after unlock.
  return {
    selection,
    manifest,
    predictions: parseJsonlProof(
      inputs.predictionsBody,
      Gate7PredictionSchema,
    ),
    judgments: parseJsonlProof(
      inputs.judgmentsBody,
      Gate7JudgmentSchema,
    ),
    selectionFileSha256,
  };
}

export async function withUnlockedGate7Inspection<T>(
  inputs: Gate7SealInputs,
  inspect: (unlocked: Gate7UnlockedInputs) => Promise<T>,
): Promise<T> {
  return inspect(unlockGate7Inspection(inputs));
}

function accuracy(correct: number, count: number): number {
  return count === 0 ? 0 : correct / count;
}

function exactSelectionShape(
  funnels: readonly Gate7CaseFunnel[],
): boolean {
  if (
    funnels.length !== 18
    || new Set(funnels.map((item) => item.questionId)).size !== 18
  ) {
    return false;
  }
  for (const questionType of OFFICIAL_QUESTION_TYPES) {
    if (
      funnels.filter((item) => item.questionType === questionType).length
        !== 3
    ) {
      return false;
    }
  }
  const abstentions = funnels.filter((item) => item.abstention);
  return (
    abstentions.length === 4
    && new Set(abstentions.map((item) => item.questionType)).size === 4
    && REQUIRED_ABSTENTION_TYPES.every((questionType) =>
      abstentions.some((item) => item.questionType === questionType)
    )
  );
}

export function summarizeGate7(args: {
  funnels: readonly Gate7CaseFunnel[];
  runReport: Gate7RunReport;
  failureCount: number;
  duplicateCount: number;
  globalLeakageIssueCount?: number;
  globalArtifactIssueCount?: number;
}): Gate7Summary {
  const overallCorrect = args.funnels.filter(
    (item) => item.canonicalJudgment.correct,
  ).length;
  const perQuestionType = Object.fromEntries(
    OFFICIAL_QUESTION_TYPES.map((questionType) => {
      const cases = args.funnels.filter(
        (item) => item.questionType === questionType,
      );
      const correct = cases.filter(
        (item) => item.canonicalJudgment.correct,
      ).length;
      return [
        questionType,
        { correct, count: cases.length, accuracy: accuracy(correct, cases.length) },
      ];
    }),
  ) as Record<OfficialQuestionType, Accuracy>;
  const abstentionCases = args.funnels.filter((item) => item.abstention);
  const abstentionCorrect = abstentionCases.filter(
    (item) => item.canonicalJudgment.correct,
  ).length;
  const replayMismatchCount = args.funnels.filter(
    (item) => !item.replayHashMatches,
  ).length;
  const leakageIssueCount =
    (args.globalLeakageIssueCount ?? 0)
    + args.funnels.reduce(
      (total, item) => total + item.leakageIssues.length,
      0,
    );
  const artifactIssueCount =
    (args.globalArtifactIssueCount ?? 0)
    + args.funnels.reduce(
      (total, item) => total + item.artifactIssues.length,
      0,
    );
  const retryCount = Object.values(args.runReport.usage.by_role)
    .reduce((total, role) => total + role.retry_count, 0);
  const retryRate = args.runReport.usage.model_call_count === 0
    ? 1
    : retryCount / args.runReport.usage.model_call_count;
  // The strict run-report and judgment schemas reject every other judge model
  // before summarization, so cardinality is the remaining proof here.
  const canonicalJudge = args.funnels.length === 18;
  const checks = {
    exactSelectionShape: exactSelectionShape(args.funnels),
    overallAccuracy: args.funnels.length === 18 && overallCorrect >= 14,
    eachQuestionType: OFFICIAL_QUESTION_TYPES.every(
      (questionType) =>
        perQuestionType[questionType].count === 3
        && perQuestionType[questionType].correct >= 2,
    ),
    abstentionAccuracy:
      abstentionCases.length === 4 && abstentionCorrect >= 3,
    canonicalJudge,
    zeroFailures: args.failureCount === 0,
    zeroDuplicates: args.duplicateCount === 0,
    zeroLeakage: leakageIssueCount === 0,
    zeroReplayMismatches: replayMismatchCount === 0,
    zeroArtifactIssues: artifactIssueCount === 0,
    agentCost: args.runReport.cost.estimated_total <= 0.864,
  };
  return {
    overall: {
      correct: overallCorrect,
      count: args.funnels.length,
      accuracy: accuracy(overallCorrect, args.funnels.length),
    },
    abstentions: {
      correct: abstentionCorrect,
      count: abstentionCases.length,
      accuracy: accuracy(abstentionCorrect, abstentionCases.length),
    },
    perQuestionType,
    failureCount: args.failureCount,
    duplicateCount: args.duplicateCount,
    leakageIssueCount,
    replayMismatchCount,
    artifactIssueCount,
    modelCallCount: args.runReport.usage.model_call_count,
    retryCount,
    retryRate,
    inputTokens: args.runReport.usage.input_tokens,
    outputTokens: args.runReport.usage.output_tokens,
    totalTokens: args.runReport.usage.total_tokens,
    totalModelLatencyMs: args.runReport.usage.total_model_latency_ms,
    agentCostUsd: args.runReport.cost.estimated_total,
    checks,
    verdict: Object.values(checks).every(Boolean) ? "passed" : "failed",
  };
}

export const GATE7_ARCHITECTURE_ID = ARCHITECTURE_ID;
export const GATE7_CANONICAL_JUDGE_MODEL = CANONICAL_JUDGE_MODEL;
