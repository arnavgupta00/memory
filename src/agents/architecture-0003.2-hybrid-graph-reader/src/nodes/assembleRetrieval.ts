import type { WorkflowRuntime } from "../runtime.js";
import { retrieveMemory } from "../retrieval/hybridRetrieval.js";
import type { MemoryStateType, MemoryStateUpdate } from "../state.js";
import type { JsonObject } from "../types.js";

export function createAssembleRetrievalNode(runtime: WorkflowRuntime) {
  return async (state: MemoryStateType): Promise<MemoryStateUpdate> => {
    const output = retrieveMemory({
      question: state.question,
      questionDate: state.questionDate,
      sessions: state.sessions,
      graph: state.graph,
      summaries: state.summaries,
      mutationRecords: state.mutationRecords,
      graphTrackedCount: state.graphTrackedCount,
      summaryTrackedCount: state.summaryTrackedCount,
    });
    await Promise.all([
      runtime.artifacts.writeAtomic(
        "retrieval/index-manifest.json",
        output.manifest as unknown as JsonObject,
      ),
      runtime.artifacts.writeAtomic(
        "retrieval/candidates.json",
        output.candidates as unknown as JsonObject,
      ),
    ]);
    return {
      retrievalManifest: output.manifest,
      retrievalCandidates: output.candidates,
      currentNode: "assembleRetrieval",
    };
  };
}
