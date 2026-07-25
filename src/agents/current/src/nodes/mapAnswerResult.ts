import type { WorkflowRuntime } from "../runtime.js";
import { ARCHITECTURE_ID } from "../architectureId.js";
import {
  UNAVAILABLE_MEMORY_HYPOTHESIS,
  validateFinalAnswerSafety,
} from "../services/finalAnswerSafety.js";
import { graphHash } from "../services/graphMutations.js";
import type { MemoryStateType, MemoryStateUpdate } from "../state.js";
import type { AnswerResult, JsonObject } from "../types.js";

export function createMapAnswerResultNode(runtime: WorkflowRuntime) {
  return async (state: MemoryStateType): Promise<MemoryStateUpdate> => {
    if (
      !state.finalAnswerOutput
      || !state.answerGeneration
      || !state.readerPlan
    ) {
      throw new Error("mapAnswerResult requires a final answer and reader plan");
    }
    const safety = validateFinalAnswerSafety({
      question: state.question,
      answer: state.finalAnswerOutput,
      readerPlan: state.readerPlan,
      sessions: state.sessions,
      ...(state.finalContext
        ? { evidencePayload: state.finalContext.evidencePackage.payload }
        : {}),
    });
    const hypothesis = safety.answer.supportStatus === "insufficient"
      ? UNAVAILABLE_MEMORY_HYPOTHESIS
      : safety.answer.hypothesis;
    const evidence = safety.answer.evidence.map((reference) => ({
      session_id: reference.sessionId,
      turn_index: reference.turnIndex ?? null,
    }));
    const answer: AnswerResult = {
      hypothesis,
      evidence,
      trace: {
        architecture_id: ARCHITECTURE_ID,
        graph_batch_size: runtime.options.graph_batch_size,
        summary_batch_size: runtime.options.summary_batch_size,
        session_count: state.sessions.length,
        contexto_call_count: Math.floor(state.sessions.length / runtime.options.graph_batch_size),
        shino_call_count: Math.floor(state.sessions.length / runtime.options.summary_batch_size),
        reader_call_count: 1,
        support_status: safety.answer.supportStatus,
        graph_revision: state.graph.revision,
        graph_hash: graphHash(state.graph),
        invalid_evidence_references: safety.rejectedEvidence
          .filter((rejected) => rejected.reason !== "duplicate")
          .map((rejected) =>
            `${rejected.evidence.sessionId}:${String(rejected.evidence.turnIndex ?? "*")}:${rejected.reason}`
          ),
        duplicate_evidence_references_removed: safety.rejectedEvidence
          .filter((rejected) => rejected.reason === "duplicate").length,
        final_answer_safety_issues: safety.issues.map((issue) => issue.code),
        final_answer_forced_insufficient: safety.forcedInsufficient,
        warnings: state.warnings,
      },
      generation: state.answerGeneration,
    };
    await runtime.artifacts.writeAtomic("answer.json", answer as unknown as JsonObject);
    await runtime.events.record(
      "answer_completed",
      { hypothesis: answer.hypothesis, evidence_count: evidence.length },
      graphHash(state.graph),
    );
    return { answerResult: answer, currentNode: "mapAnswerResult" };
  };
}
