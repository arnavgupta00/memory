import { formatContextPackage } from "../answer/formatContextPackage.js";
import type { WorkflowRuntime } from "../runtime.js";
import type { MemoryStateType, MemoryStateUpdate } from "../state.js";
import { ContextDigestSchema } from "../types.js";

export function createFormatContextNode(runtime: WorkflowRuntime) {
  return async (state: MemoryStateType): Promise<MemoryStateUpdate> => {
    if (!runtime.options.format_enabled) {
      return { currentNode: "formatContext" };
    }
    if (!state.contextPackage) {
      throw new Error("formatContext requires a context package");
    }
    await runtime.events.record(
      "node_started",
      { node: "formatContext", call_key: "format:package" },
      null,
    );
    const promptName = runtime.options.format_prompt;
    const prompt = await runtime.prompts.render(promptName, {
      question: state.question,
      question_date: state.questionDate,
      context_package: formatContextPackage(state.contextPackage),
    });
    const response = await runtime.models.generateStructured({
      role: "format",
      callKey: "format:package",
      prompt,
      schemaName: "context_digest_v1",
      schema: ContextDigestSchema,
      artifacts: runtime.artifacts,
    });
    const digest = ContextDigestSchema.parse(response.value);
    return {
      contextDigest: digest,
      formatGeneration: response.generation,
      currentNode: "formatContext",
    };
  };
}
