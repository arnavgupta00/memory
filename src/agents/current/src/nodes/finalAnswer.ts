import { renderAnswerPrompt } from "../answer/renderAnswerPrompt.js";
import type { WorkflowRuntime } from "../runtime.js";
import type { MemoryStateType, MemoryStateUpdate } from "../state.js";
import { AnswerOutputSchema } from "../types.js";

export function createFinalAnswerNode(runtime: WorkflowRuntime) {
  return async (state: MemoryStateType): Promise<MemoryStateUpdate> => {
    if (!state.retrieval) throw new Error("finalAnswer requires retrieval");
    await runtime.events.record(
      "node_started",
      { node: "finalAnswer", call_key: "answer:final" },
      null,
    );
    const prompt = await renderAnswerPrompt(
      {
        question: state.question,
        questionDate: state.questionDate,
        retrieval: state.retrieval,
        promptName: runtime.options.answer_prompt,
      },
      runtime.prompts,
    );
    const response = await runtime.models.generateStructured({
      role: "answer",
      callKey: "answer:final",
      prompt,
      schemaName: "answer_v1",
      schema: AnswerOutputSchema,
      artifacts: runtime.artifacts,
    });
    return {
      finalAnswerOutput: response.value,
      answerGeneration: response.generation,
      currentNode: "finalAnswer",
    };
  };
}
