import type { WorkflowRuntime } from "../runtime.js";
import { classifyContextoCoverage } from "../services/contextoCoverage.js";
import { graphHash, applyContextoMutation } from "../services/graphMutations.js";
import type { MemoryStateType, MemoryStateUpdate } from "../state.js";
import type { GraphMutationRecord, JsonObject } from "../types.js";
import { errorMessage } from "../services/redaction.js";

export function createApplyGraphMutationNode(runtime: WorkflowRuntime) {
  return async (state: MemoryStateType): Promise<MemoryStateUpdate> => {
    const mutation = state.pendingMutation;
    const semanticRejection = state.pendingMutationRejection;
    if (!mutation && !semanticRejection) {
      throw new Error("applyGraphMutation requires a pending mutation or semantic rejection");
    }
    const size = runtime.options.graph_batch_size;
    const batchNumber = Math.floor(state.graphTrackedCount / size) + 1;
    const batchId = `b${String(batchNumber).padStart(4, "0")}`;
    const sessions = state.sessions.slice(state.graphTrackedCount, state.graphTrackedCount + size);
    const beforeRevision = state.graph.revision;
    const beforeGraph = state.graph;
    let graph = state.graph;
    let record: GraphMutationRecord;
    if (semanticRejection) {
      record = {
        batchId,
        sessionIds: sessions.map((session) => session.session_id),
        mode: "rejected",
        explanation: semanticRejection.explanation,
        accepted: false,
        rejectionReason: semanticRejection.reason,
        diffs: [],
        graphRevisionBefore: beforeRevision,
        graphRevisionAfter: beforeRevision,
        graphHash: graphHash(graph),
      };
    } else {
      if (!mutation) throw new Error("pending mutation disappeared before application");
      try {
        const applied = applyContextoMutation({
          graph: state.graph,
          mutation,
          batchId,
          sessions,
          allowReplacement: runtime.options.allow_graph_replacement,
        });
        graph = applied.graph;
        const explanation = mutation.mode === "semantic_updates"
          ? mutation.batchSummary
          : mutation.explanation;
        const accepted = mutation.mode === "semantic_updates"
          ? applied.acceptedUpdateCount > 0 || (mutation.updates.length === 0 && applied.rejectedUpdates.length === 0)
          : true;
        record = {
          batchId,
          sessionIds: sessions.map((session) => session.session_id),
          mode: mutation.mode,
          explanation,
          accepted,
          ...(accepted
            ? {}
            : { rejectionReason: applied.rejectedUpdates.map((item) => `update ${String(item.index)}: ${item.reason}`).join("; ") }),
          diffs: applied.diffs,
          graphRevisionBefore: beforeRevision,
          graphRevisionAfter: graph.revision,
          graphHash: graphHash(graph),
          acceptedUpdateCount: applied.acceptedUpdateCount,
          rejectedUpdates: applied.rejectedUpdates,
          auditWarnings: applied.auditWarnings,
          mutation,
        };
      } catch (error) {
        record = {
          batchId,
          sessionIds: sessions.map((session) => session.session_id),
          mode: "rejected",
          explanation: mutation.mode === "semantic_updates" ? mutation.batchSummary : mutation.explanation,
          accepted: false,
          rejectionReason: errorMessage(error),
          diffs: [],
          graphRevisionBefore: beforeRevision,
          graphRevisionAfter: beforeRevision,
          graphHash: graphHash(graph),
          mutation,
        };
      }
    }
    const coverage = classifyContextoCoverage({
      batchId,
      sessions,
      beforeGraph,
      afterGraph: graph,
      mutation: mutation ?? null,
      rejectedUpdateIndices: (record.rejectedUpdates ?? []).map((item) => item.index),
    });
    record = { ...record, coverage };
    await runtime.artifacts.writeAtomic(
      `contexto-coverage/${batchId}.json`,
      coverage as unknown as JsonObject,
    );
    await runtime.artifacts.writeAtomic(
      `graph-mutations/${batchId}.json`,
      record as unknown as JsonObject,
    );
    await runtime.artifacts.writeAtomic("final-graph.json", graph as unknown as JsonObject);
    await runtime.events.record(
      record.accepted ? "graph_mutation_applied" : "graph_mutation_rejected",
      record as unknown as JsonObject,
      record.graphHash,
    );
    return {
      graph,
      pendingMutation: null,
      pendingMutationRejection: null,
      mutationRecords: [...state.mutationRecords, record],
      warnings: [
        ...state.warnings,
        ...(record.rejectionReason ? [record.rejectionReason] : []),
        ...(record.rejectedUpdates ?? []).map((item) => `Contexto update ${String(item.index)} rejected: ${item.reason}`),
        ...(record.auditWarnings ?? []).map((warning) => `Contexto audit: ${warning}`),
      ],
      currentNode: "applyGraphMutation",
    };
  };
}
