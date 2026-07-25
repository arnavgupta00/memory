import type { WorkflowRuntime } from "../runtime.js";
import { buildCompactFinalEvidencePackage } from "../services/finalEvidencePackage.js";
import type { MemoryStateType, MemoryStateUpdate } from "../state.js";
import type { JsonObject } from "../types.js";

export function createAssembleContextNode(runtime: WorkflowRuntime) {
  return async (state: MemoryStateType): Promise<MemoryStateUpdate> => {
    if (!state.readerPlan) {
      throw new Error("assembleContext requires a reader plan");
    }
    const evidencePackage = buildCompactFinalEvidencePackage({
      plan: state.readerPlan,
      sessions: state.sessions,
      graph: state.graph,
    });
    const finalContext = {
      question: state.question,
      questionDate: state.questionDate,
      readerPlan: state.readerPlan,
      evidencePackage,
    };
    await runtime.artifacts.writeAtomic("final-context.json", finalContext as unknown as JsonObject);
    return { finalContext, currentNode: "assembleContext" };
  };
}
