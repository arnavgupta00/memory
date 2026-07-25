import type { WorkflowRuntime } from "../runtime.js";
import { graphHash } from "../services/graphMutations.js";
import type { MemoryStateType, MemoryStateUpdate } from "../state.js";
import type { JsonObject, SessionSummaryRecord } from "../types.js";

export function createMarkSummaryTrackedNode(runtime: WorkflowRuntime) {
  return async (state: MemoryStateType): Promise<MemoryStateUpdate> => {
    if (!state.pendingSummary) throw new Error("markSummaryTracked requires a pending summary");
    const size = runtime.options.summary_batch_size;
    const sessions = state.sessions.slice(state.summaryTrackedCount, state.summaryTrackedCount + size);
    const windowNumber = Math.floor(state.summaryTrackedCount / size) + 1;
    const record: SessionSummaryRecord = {
      windowId: `c${String(windowNumber).padStart(4, "0")}`,
      sessionIds: sessions.map((session) => session.session_id),
      graphRevision: state.graph.revision,
      summary: state.pendingSummary.summary,
    };
    const existingSummaries = await runtime.artifacts.readJsonl("summaries");
    const existing = existingSummaries.find((item) => item.windowId === record.windowId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
      throw new Error(`summary window changed during resume: ${record.windowId}`);
    }
    if (!existing) await runtime.artifacts.append("summaries", record as unknown as JsonObject);
    await runtime.events.record(
      "summary_window_created",
      record as unknown as JsonObject,
      graphHash(state.graph),
    );
    return {
      summaries: [...state.summaries, record],
      summaryTrackedCount: state.summaryTrackedCount + size,
      pendingSummary: null,
      currentNode: "markSummaryTracked",
    };
  };
}
