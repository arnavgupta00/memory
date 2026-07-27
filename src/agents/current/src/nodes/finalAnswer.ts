import { renderAnswerPrompt } from "../answer/renderAnswerPrompt.js";
import type { WorkflowRuntime } from "../runtime.js";
import type { MemoryStateType, MemoryStateUpdate } from "../state.js";
import { AnswerOutputSchema } from "../types.js";

export function createFinalAnswerNode(runtime: WorkflowRuntime) {
  return async (state: MemoryStateType): Promise<MemoryStateUpdate> => {
    if (!state.retrieval) throw new Error("finalAnswer requires retrieval");
    if (runtime.options.select_enabled && !state.contextPackage) {
      throw new Error("finalAnswer requires a context package when select_enabled");
    }
    await runtime.events.record(
      "node_started",
      { node: "finalAnswer", call_key: "answer:final" },
      null,
    );
    const promptName = runtime.options.select_enabled
      ? runtime.options.answer_prompt === "answer-v2-evidence"
        || runtime.options.answer_prompt === "answer"
        || runtime.options.answer_prompt === "answer-v2-simple"
        || runtime.options.answer_prompt === "answer-v2-rules"
        || runtime.options.answer_prompt === "answer-v3-package"
        || runtime.options.answer_prompt === "answer-v4-package"
        ? "answer-v5-package"
        : runtime.options.answer_prompt
      : runtime.options.answer_prompt;
    const prompt = await renderAnswerPrompt(
      {
        question: state.question,
        questionDate: state.questionDate,
        retrieval: state.retrieval,
        contextPackage: state.contextPackage,
        promptName,
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
