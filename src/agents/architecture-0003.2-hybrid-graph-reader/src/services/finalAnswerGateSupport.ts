import { z } from "zod";

import {
  UNAVAILABLE_MEMORY_HYPOTHESIS,
  validateFinalAnswerSafety,
} from "./finalAnswerSafety.js";
import {
  FinalAnswerSchema,
  ReaderPlanSchema,
  TurnSchema,
  type CompactFinalEvidencePayload,
  type FinalAnswer,
  type MasterContextGraph,
  type ReaderPlan,
  type TimestampedSession,
} from "../types.js";

export const GateDatasetTurnSchema = TurnSchema.extend({
  has_answer: z.boolean().optional(),
});

export const GateDatasetCaseSchema = z.looseObject({
  question_id: z.string().min(1),
  question_type: z.string().min(1),
  question: z.string(),
  question_date: z.string(),
  answer_session_ids: z.array(z.string()),
  haystack_dates: z.array(z.string()),
  haystack_session_ids: z.array(z.string()),
  haystack_sessions: z.array(z.array(GateDatasetTurnSchema)),
});
export type GateDatasetCase = z.infer<typeof GateDatasetCaseSchema>;

export const ReaderPlanArtifactSchema = z.object({
  ...ReaderPlanSchema.shape,
});

export const CanonicalJudgmentSchema = z.looseObject({
  question_id: z.string().min(1),
  hypothesis: z.string(),
  autoeval_label: z.strictObject({
    model: z.literal("gpt-4o-2024-08-06"),
    label: z.boolean(),
  }),
});
export type CanonicalJudgment = z.infer<typeof CanonicalJudgmentSchema>;

export type GateAnswerSafety = {
  answer: FinalAnswer;
  rejectedEvidenceCount: number;
  duplicateEvidenceCount: number;
  questionRestatement: boolean;
  supportedWithoutEvidence: boolean;
  explicitAbstentionAccepted: boolean;
};

export function sessionsForGateCase(
  item: GateDatasetCase,
): TimestampedSession[] {
  if (
    item.haystack_sessions.length !== item.haystack_session_ids.length
    || item.haystack_sessions.length !== item.haystack_dates.length
  ) {
    throw new Error(`misaligned session arrays for ${item.question_id}`);
  }
  return item.haystack_sessions.map((turns, index) => {
    const sessionId = item.haystack_session_ids[index];
    const date = item.haystack_dates[index];
    if (!sessionId || !date) {
      throw new Error(
        `missing session metadata at ${item.question_id}/${String(index)}`,
      );
    }
    return { session_id: sessionId, date, turns };
  });
}

export function buildOracleReaderPlan(item: GateDatasetCase): ReaderPlan {
  if (item.question_id.endsWith("_abs")) {
    return {
      supportStatus: "insufficient",
      answerMode: "abstain",
      selectedSessions: [],
      selectedGraphPointers: [],
      evidenceFacts: [],
      conflicts: [],
    };
  }
  const selectedSessions = item.answer_session_ids.map((sessionId) => {
    const sessionIndex = item.haystack_session_ids.indexOf(sessionId);
    const session = item.haystack_sessions[sessionIndex];
    if (sessionIndex < 0 || session === undefined) {
      throw new Error(
        `oracle answer session ${sessionId} missing from ${item.question_id}`,
      );
    }
    const turnIndexes = session.flatMap((turn, turnIndex) =>
      turn.has_answer === true ? [turnIndex] : [],
    );
    if (turnIndexes.length === 0) {
      throw new Error(
        `oracle answer session ${sessionId} lacks an answer turn in ${item.question_id}`,
      );
    }
    return {
      sessionId,
      turnIndexes,
      purpose: "direct_answer" as const,
    };
  });
  return ReaderPlanSchema.parse({
    supportStatus: "sufficient",
    answerMode: item.question_type === "temporal-reasoning"
      ? "temporal_comparison"
      : item.question_type === "knowledge-update"
        ? "knowledge_update"
        : item.question_type === "multi-session"
          ? "multi_session"
          : item.question_type === "single-session-preference"
            ? "preference"
            : item.question_type === "single-session-assistant"
              ? "assistant_answer"
              : "direct",
    selectedSessions,
    selectedGraphPointers: [],
    evidenceFacts: [],
    conflicts: [],
  });
}

export function applyGateAnswerSafety(args: {
  question: string;
  answer: FinalAnswer;
  readerPlan: ReaderPlan;
  sessions: readonly TimestampedSession[];
  evidencePayload?: CompactFinalEvidencePayload;
}): GateAnswerSafety {
  const parsedAnswer = FinalAnswerSchema.parse(args.answer);
  const safety = validateFinalAnswerSafety({
    question: args.question,
    answer: parsedAnswer,
    readerPlan: args.readerPlan,
    sessions: args.sessions,
    ...(args.evidencePayload
      ? { evidencePayload: args.evidencePayload }
      : {}),
  });
  const questionRestatement = safety.issues.some(
    (issue) => issue.code === "question_restatement_hypothesis",
  );
  const supportedWithoutEvidence = safety.issues.some(
    (issue) => issue.code === "supported_answer_without_valid_evidence",
  );
  const readerRequiresAbstention =
    args.readerPlan.supportStatus === "insufficient"
    || args.readerPlan.answerMode === "abstain";
  const explicitAbstentionAccepted =
    readerRequiresAbstention
    && parsedAnswer.supportStatus === "insufficient"
    && parsedAnswer.evidence.length === 0
    && parsedAnswer.hypothesis.trim().length > 0
    && !questionRestatement;
  const duplicateEvidenceCount = safety.rejectedEvidence.filter(
    (rejected) => rejected.reason === "duplicate",
  ).length;
  return {
    answer: safety.answer.supportStatus === "insufficient"
      ? {
          hypothesis: UNAVAILABLE_MEMORY_HYPOTHESIS,
          evidence: [],
          supportStatus: "insufficient",
        }
      : safety.answer,
    rejectedEvidenceCount:
      safety.rejectedEvidence.length - duplicateEvidenceCount,
    duplicateEvidenceCount,
    questionRestatement,
    supportedWithoutEvidence,
    explicitAbstentionAccepted,
  };
}

export function percentile95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

export function emptyGateGraph(): MasterContextGraph {
  return {
    schemaVersion: 1,
    revision: 0,
    context: {},
    provenanceByPointer: {},
  };
}
