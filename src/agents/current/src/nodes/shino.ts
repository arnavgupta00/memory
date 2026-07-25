import type { WorkflowRuntime } from "../runtime.js";
import { graphHash } from "../services/graphMutations.js";
import type { MemoryStateType, MemoryStateUpdate } from "../state.js";
import { ShinoOutputSchema } from "../types.js";

export function createShinoNode(runtime: WorkflowRuntime) {
  return async (state: MemoryStateType): Promise<MemoryStateUpdate> => {
    const size = runtime.options.summary_batch_size;
    const sessions = state.sessions.slice(state.summaryTrackedCount, state.summaryTrackedCount + size);
    if (sessions.length !== size) throw new Error("Shino requires one complete C-session window");
    const windowNumber = Math.floor(state.summaryTrackedCount / size) + 1;
    await runtime.events.record(
      "node_started",
      { node: "shino", call_key: `shino:window:${String(windowNumber).padStart(4, "0")}` },
      graphHash(state.graph),
    );
    const prompt = await runtime.prompts.render("shino", {
      master_graph: JSON.stringify(state.graph, null, 2),
      session_ids: JSON.stringify(sessions.map((session) => session.session_id)),
    });
    const response = await runtime.models.generateStructured({
      role: "shino",
      callKey: `shino:window:${String(windowNumber).padStart(4, "0")}`,
      prompt,
      schemaName: "shino_summary_v1",
      schema: ShinoOutputSchema,
      artifacts: runtime.artifacts,
    });
    return { pendingSummary: response.value, currentNode: "shino" };
  };
}
