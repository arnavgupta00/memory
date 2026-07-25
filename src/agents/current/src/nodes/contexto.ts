import type { WorkflowRuntime } from "../runtime.js";
import { decodeContextoMutation } from "../services/contextoWire.js";
import { graphHash, semanticMemoryCatalog } from "../services/graphMutations.js";
import { personalSignalIndex } from "../services/personalSignals.js";
import { errorMessage } from "../services/redaction.js";
import type { MemoryStateType, MemoryStateUpdate } from "../state.js";
import { ContextoSemanticWireResponseSchema } from "../types.js";

export function createContextoNode(runtime: WorkflowRuntime) {
  return async (state: MemoryStateType): Promise<MemoryStateUpdate> => {
    const size = runtime.options.graph_batch_size;
    const sessions = state.sessions.slice(state.graphTrackedCount, state.graphTrackedCount + size);
    if (sessions.length !== size) throw new Error("Contexto requires one complete B-session batch");
    const batchNumber = Math.floor(state.graphTrackedCount / size) + 1;
    const batchId = `b${String(batchNumber).padStart(4, "0")}`;
    await runtime.events.record(
      "node_started",
      { node: "contexto", call_key: `contexto:batch:${String(batchNumber).padStart(4, "0")}` },
      graphHash(state.graph),
    );
    const labelledSessions = sessions.map((session, sessionIndex) => ({
      sessionSlot: `session_${String(sessionIndex + 1)}`,
      date: session.date,
      turns: session.turns.map((turn, turnIndex) => ({
        turnSlot: `turn_${String(turnIndex + 1)}`,
        role: turn.role,
        content: turn.content,
      })),
    }));
    const prompt = await runtime.prompts.render("contexto", {
      batch_id: batchId,
      memory_catalog: JSON.stringify(semanticMemoryCatalog(state.graph), null, 2),
      personal_signals: JSON.stringify(personalSignalIndex(sessions), null, 2),
      sessions: JSON.stringify(labelledSessions, null, 2),
    });
    const response = await runtime.models.generateStructured({
      role: "contexto",
      callKey: `contexto:batch:${String(batchNumber).padStart(4, "0")}`,
      prompt,
      schemaName: "contexto_semantic_wire_response_v6",
      schema: ContextoSemanticWireResponseSchema,
      artifacts: runtime.artifacts,
    });
    try {
      return {
        pendingMutation: decodeContextoMutation(
          response.value.mutation,
          { batchId, sessions, graph: state.graph },
        ),
        pendingMutationRejection: null,
        currentNode: "contexto",
      };
    } catch (error) {
      return {
        pendingMutation: null,
        pendingMutationRejection: {
          explanation: response.value.mutation.batchSummary,
          reason: errorMessage(error),
        },
        currentNode: "contexto:semantic-rejection",
      };
    }
  };
}
