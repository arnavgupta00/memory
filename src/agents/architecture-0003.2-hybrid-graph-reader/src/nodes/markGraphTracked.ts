import type { WorkflowRuntime } from "../runtime.js";
import { graphHash } from "../services/graphMutations.js";
import type { MemoryStateType, MemoryStateUpdate } from "../state.js";

export function createMarkGraphTrackedNode(runtime: WorkflowRuntime) {
  return async (state: MemoryStateType): Promise<MemoryStateUpdate> => {
    const tracked = state.graphTrackedCount + runtime.options.graph_batch_size;
    await runtime.events.record(
      "graph_sessions_tracked",
      { graph_tracked_count: tracked },
      graphHash(state.graph),
    );
    return { graphTrackedCount: tracked, currentNode: "markGraphTracked" };
  };
}
