import type { WorkflowRuntime } from "../runtime.js";
import type { MemoryStateType, MemoryStateUpdate } from "../state.js";
import type { JsonObject } from "../types.js";

export function createIngestSessionNode(runtime: WorkflowRuntime) {
  return async (state: MemoryStateType): Promise<MemoryStateUpdate> => {
    const incoming = state.incomingSession;
    if (!incoming) throw new Error("ingest action requires incomingSession");
    const sessions = [...state.sessions, incoming];
    const archived = await runtime.artifacts.readJsonl("sessions");
    const existingArchive = archived[state.sessions.length];
    if (existingArchive && JSON.stringify(existingArchive) !== JSON.stringify(incoming)) {
      throw new Error(`archived session changed at position ${String(state.sessions.length)}`);
    }
    if (!existingArchive) {
      await runtime.artifacts.append("sessions", incoming as unknown as JsonObject);
    }
    await runtime.events.record(
      "session_ingested",
      { session: incoming as unknown as JsonObject, session_number: sessions.length },
      null,
    );
    return { sessions, incomingSession: null, currentNode: "ingestSession" };
  };
}
