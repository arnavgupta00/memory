import type { WorkflowRuntime } from "../runtime.js";
import { createCandidateConstrainedFinalAnswerSchema } from "../services/finalAnswerSchema.js";
import { graphHash } from "../services/graphMutations.js";
import type { MemoryStateType, MemoryStateUpdate } from "../state.js";

export function createFinalAnswerNode(runtime: WorkflowRuntime) {
  return async (state: MemoryStateType): Promise<MemoryStateUpdate> => {
    if (!state.finalContext) throw new Error("finalAnswer requires compiled context");
    const context = state.finalContext;
    await runtime.events.record(
      "node_started",
      { node: "finalAnswer", call_key: "answer:final" },
      graphHash(state.graph),
    );
    const prompt = await runtime.prompts.render("final-answer", {
      question: context.question,
      question_date: context.questionDate,
      reader_plan: JSON.stringify(context.readerPlan, null, 2),
      evidence_package: JSON.stringify(context.evidencePackage.payload, null, 2),
    });
    const response = await runtime.models.generateStructured({
      role: "answer",
      callKey: "answer:final",
      prompt,
      schemaName: "final_answer_v1",
      schema: createCandidateConstrainedFinalAnswerSchema(
        context.evidencePackage.payload,
      ),
      artifacts: runtime.artifacts,
    });
    return {
      finalAnswerOutput: response.value,
      answerGeneration: response.generation,
      currentNode: "finalAnswer",
    };
  };
}
