import { isQuestionRestatement } from "./readerGrounding.js";
import type {
  CompactFinalEvidencePayload,
  FinalAnswer,
  ReaderPlan,
  TimestampedSession,
} from "../types.js";

type FinalEvidence = FinalAnswer["evidence"][number];

export const UNAVAILABLE_MEMORY_HYPOTHESIS =
  "The available memory does not contain this information.";

export type RejectedFinalEvidenceReason =
  | "duplicate"
  | "session_not_selected"
  | "turn_not_selected"
  | "unknown_session"
  | "unknown_turn";

export type RejectedFinalEvidence = {
  evidenceIndex: number;
  evidence: FinalEvidence;
  reason: RejectedFinalEvidenceReason;
};

export type FinalAnswerSafetyIssue =
  | {
      code: "invalid_evidence";
      rejected: RejectedFinalEvidence;
    }
  | {
      code: "question_restatement_hypothesis";
    }
  | {
      code: "reader_plan_insufficient";
    }
  | {
      code: "supported_answer_without_valid_evidence";
    };

export type FinalAnswerSafetyResult = {
  answer: FinalAnswer;
  validEvidence: FinalEvidence[];
  rejectedEvidence: RejectedFinalEvidence[];
  issues: FinalAnswerSafetyIssue[];
  forcedInsufficient: boolean;
};

function evidenceKey(evidence: FinalEvidence): string {
  return `${evidence.sessionId}:${evidence.turnIndex ?? "session"}`;
}

function selectedAndAdjacentTurns(args: {
  plan: ReaderPlan;
  sessionsById: ReadonlyMap<string, TimestampedSession>;
  evidencePayload?: CompactFinalEvidencePayload;
}): Map<string, Set<number>> {
  if (args.evidencePayload) {
    return new Map(
      args.evidencePayload.sessions.map((session) => [
        session.sessionId,
        new Set(session.turns.map((turn) => turn.turnIndex)),
      ]),
    );
  }
  const allowed = new Map<string, Set<number>>();
  for (const selected of args.plan.selectedSessions) {
    const session = args.sessionsById.get(selected.sessionId);
    if (!session) continue;
    const indexes = allowed.get(selected.sessionId) ?? new Set<number>();
    for (const turnIndex of selected.turnIndexes) {
      if (turnIndex >= session.turns.length) continue;
      indexes.add(turnIndex);
      if (turnIndex > 0) indexes.add(turnIndex - 1);
      if (turnIndex + 1 < session.turns.length) indexes.add(turnIndex + 1);
    }
    allowed.set(selected.sessionId, indexes);
  }
  return allowed;
}

function rejectEvidence(args: {
  evidence: FinalEvidence;
  evidenceIndex: number;
  reason: RejectedFinalEvidenceReason;
  rejectedEvidence: RejectedFinalEvidence[];
  issues: FinalAnswerSafetyIssue[];
}): void {
  const rejected: RejectedFinalEvidence = {
    evidenceIndex: args.evidenceIndex,
    evidence: args.evidence,
    reason: args.reason,
  };
  args.rejectedEvidence.push(rejected);
  args.issues.push({ code: "invalid_evidence", rejected });
}

/**
 * Sanitizes a schema-valid final answer against the reader's evidence boundary.
 *
 * A final answer may cite a selected reader turn, its adjacent paired turn, or
 * the selected session as a whole. It cannot introduce a new session or jump
 * to an unrelated turn. This function validates references and exact
 * question-restatement behavior; it does not attempt semantic fact checking.
 */
export function validateFinalAnswerSafety(args: {
  question: string;
  answer: FinalAnswer;
  readerPlan: ReaderPlan;
  sessions: readonly TimestampedSession[];
  evidencePayload?: CompactFinalEvidencePayload;
}): FinalAnswerSafetyResult {
  const issues: FinalAnswerSafetyIssue[] = [];
  const rejectedEvidence: RejectedFinalEvidence[] = [];
  const validEvidence: FinalEvidence[] = [];
  const sessionsById = new Map(
    args.sessions.map((session) => [session.session_id, session]),
  );
  const allowedTurns = selectedAndAdjacentTurns({
    plan: args.readerPlan,
    sessionsById,
    ...(args.evidencePayload
      ? { evidencePayload: args.evidencePayload }
      : {}),
  });
  const selectedSessionIds = new Set(
    args.evidencePayload
      ? args.evidencePayload.sessions.map((session) => session.sessionId)
      : args.readerPlan.selectedSessions.map((selected) => selected.sessionId),
  );
  const seenEvidence = new Set<string>();

  args.answer.evidence.forEach((evidence, evidenceIndex) => {
    const session = sessionsById.get(evidence.sessionId);
    if (!session) {
      rejectEvidence({
        evidence,
        evidenceIndex,
        reason: "unknown_session",
        rejectedEvidence,
        issues,
      });
      return;
    }
    if (!selectedSessionIds.has(evidence.sessionId)) {
      rejectEvidence({
        evidence,
        evidenceIndex,
        reason: "session_not_selected",
        rejectedEvidence,
        issues,
      });
      return;
    }
    if (
      evidence.turnIndex !== null
      && evidence.turnIndex >= session.turns.length
    ) {
      rejectEvidence({
        evidence,
        evidenceIndex,
        reason: "unknown_turn",
        rejectedEvidence,
        issues,
      });
      return;
    }
    if (
      evidence.turnIndex !== null
      && !allowedTurns.get(evidence.sessionId)?.has(evidence.turnIndex)
    ) {
      rejectEvidence({
        evidence,
        evidenceIndex,
        reason: "turn_not_selected",
        rejectedEvidence,
        issues,
      });
      return;
    }
    const key = evidenceKey(evidence);
    if (seenEvidence.has(key)) {
      rejectEvidence({
        evidence,
        evidenceIndex,
        reason: "duplicate",
        rejectedEvidence,
        issues,
      });
      return;
    }
    seenEvidence.add(key);
    validEvidence.push(evidence);
  });

  let forcedInsufficient = false;
  if (
    args.readerPlan.supportStatus === "insufficient"
    || args.readerPlan.answerMode === "abstain"
  ) {
    issues.push({ code: "reader_plan_insufficient" });
    forcedInsufficient = true;
  }
  if (isQuestionRestatement(args.question, args.answer.hypothesis)) {
    issues.push({ code: "question_restatement_hypothesis" });
    forcedInsufficient = true;
  }
  if (
    args.answer.supportStatus !== "insufficient"
    && validEvidence.length === 0
  ) {
    issues.push({ code: "supported_answer_without_valid_evidence" });
    forcedInsufficient = true;
  }

  const answer: FinalAnswer = forcedInsufficient
    ? {
        hypothesis: "",
        evidence: [],
        supportStatus: "insufficient",
      }
    : {
        ...args.answer,
        hypothesis: args.answer.hypothesis.trim(),
        evidence: validEvidence,
      };
  return {
    answer,
    validEvidence,
    rejectedEvidence,
    issues,
    forcedInsufficient,
  };
}
