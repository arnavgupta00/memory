import { ARCHITECTURE_ID } from "../architectureId.js";
import type { WorkflowRuntime } from "../runtime.js";
import type { MemoryStateType, MemoryStateUpdate } from "../state.js";
import {
  UNAVAILABLE_MEMORY_HYPOTHESIS,
  type AnswerResult,
  type JsonObject,
  type TimestampedSession,
} from "../types.js";
import type { SelectedSpan } from "../retrieval/types.js";

function evidenceKey(sessionId: string, turnIndex: number | null): string {
  return `${sessionId}:${turnIndex === null ? "*" : String(turnIndex)}`;
}

function isKnownCitation(
  sessionId: string,
  turnIndex: number | null,
  sessions: TimestampedSession[],
  spans: SelectedSpan[],
): boolean {
  const session = sessions.find((item) => item.session_id === sessionId);
  if (!session) return false;
  if (turnIndex === null) {
    return spans.some((span) => span.sessionId === sessionId);
  }
  if (turnIndex < 0 || turnIndex >= session.turns.length) return false;
  return spans.some(
    (span) =>
      span.sessionId === sessionId
      && turnIndex >= span.startTurn
      && turnIndex <= span.endTurn,
  );
}

export function createMapAnswerResultNode(runtime: WorkflowRuntime) {
  return async (state: MemoryStateType): Promise<MemoryStateUpdate> => {
    if (!state.finalAnswerOutput || !state.answerGeneration || !state.retrieval) {
      throw new Error("mapAnswerResult requires a final answer and retrieval");
    }
    const warnings = [...state.warnings];
    const seen = new Set<string>();
    const evidence: AnswerResult["evidence"] = [];
    for (const item of state.finalAnswerOutput.evidence) {
      const key = evidenceKey(item.sessionId, item.turnIndex);
      if (seen.has(key)) {
        warnings.push(`dropped_duplicate_evidence:${key}`);
        continue;
      }
      if (
        !isKnownCitation(
          item.sessionId,
          item.turnIndex,
          state.sessions,
          state.retrieval.spans,
        )
      ) {
        warnings.push(`dropped_unknown_evidence:${key}`);
        continue;
      }
      seen.add(key);
      evidence.push({
        session_id: item.sessionId,
        turn_index: item.turnIndex,
      });
    }

    // Only substitute the canned abstention when the model left hypothesis empty.
    // Overwriting a non-empty answer on `insufficient` hides correct work from the
    // judge (e.g. a completed sum that the model then marked insufficient).
    const rawHypothesis = state.finalAnswerOutput.hypothesis.trim();
    const insufficient = state.finalAnswerOutput.supportStatus === "insufficient";
    const answer: AnswerResult = {
      hypothesis:
        insufficient && rawHypothesis.length === 0
          ? UNAVAILABLE_MEMORY_HYPOTHESIS
          : state.finalAnswerOutput.hypothesis,
      evidence,
      trace: {
        architecture_id: ARCHITECTURE_ID,
        session_count: state.sessions.length,
        answer_call_count: 1,
        support_status: state.finalAnswerOutput.supportStatus,
        evidence_table: state.finalAnswerOutput.evidenceTable as unknown as JsonObject[],
        retrieval: {
          span_count: state.retrieval.spans.length,
          character_count: state.retrieval.characterCount,
          estimated_tokens: state.retrieval.estimatedTokens,
          options: state.retrieval.options as unknown as JsonObject,
        },
        warnings,
      },
      generation: state.answerGeneration,
    };
    await runtime.artifacts.writeAtomic("answer.json", answer as unknown as JsonObject);
    await runtime.events.record(
      "answer_completed",
      {
        hypothesis: answer.hypothesis,
        evidence_count: evidence.length,
        support_status: state.finalAnswerOutput.supportStatus,
      },
      null,
    );
    return { answerResult: answer, warnings, currentNode: "mapAnswerResult" };
  };
}
