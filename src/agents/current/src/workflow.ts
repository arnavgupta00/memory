import { END, START, StateGraph } from "@langchain/langgraph";

import { createApplyGraphMutationNode } from "./nodes/applyGraphMutation.js";
import { createAssembleContextNode } from "./nodes/assembleContext.js";
import { createAssembleRetrievalNode } from "./nodes/assembleRetrieval.js";
import { createContextoNode } from "./nodes/contexto.js";
import { createFinalAnswerNode } from "./nodes/finalAnswer.js";
import { createIngestSessionNode } from "./nodes/ingestSession.js";
import { createMapAnswerResultNode } from "./nodes/mapAnswerResult.js";
import { createMarkGraphTrackedNode } from "./nodes/markGraphTracked.js";
import { createMarkSummaryTrackedNode } from "./nodes/markSummaryTracked.js";
import { createReadMemoryNode } from "./nodes/readMemory.js";
import { createShinoNode } from "./nodes/shino.js";
import type { WorkflowRuntime } from "./runtime.js";
import { MemoryState } from "./state.js";

export function createMemoryWorkflow(runtime: WorkflowRuntime) {
  const routeAction = (state: typeof MemoryState.State) => {
    if (state.action === "ingest") return "ingestSession";
    if (state.action === "answer") return "assembleRetrieval";
    if (state.sessions.length - state.graphTrackedCount >= runtime.options.graph_batch_size) {
      return "contexto";
    }
    if (state.sessions.length - state.summaryTrackedCount >= runtime.options.summary_batch_size) {
      return "shino";
    }
    return END;
  };
  const routeGraphBatch = (state: typeof MemoryState.State) =>
    state.sessions.length - state.graphTrackedCount >= runtime.options.graph_batch_size
      ? "contexto"
      : END;
  const routeSummaryWindow = (state: typeof MemoryState.State) =>
    state.sessions.length - state.summaryTrackedCount >= runtime.options.summary_batch_size
      ? "shino"
      : END;

  return new StateGraph(MemoryState)
    .addNode("ingestSession", createIngestSessionNode(runtime))
    .addNode("contexto", createContextoNode(runtime))
    .addNode("applyGraphMutation", createApplyGraphMutationNode(runtime))
    .addNode("markGraphTracked", createMarkGraphTrackedNode(runtime))
    .addNode("shino", createShinoNode(runtime))
    .addNode("markSummaryTracked", createMarkSummaryTrackedNode(runtime))
    .addNode("assembleRetrieval", createAssembleRetrievalNode(runtime))
    .addNode("readMemory", createReadMemoryNode(runtime))
    .addNode("assembleContext", createAssembleContextNode(runtime))
    .addNode("finalAnswer", createFinalAnswerNode(runtime))
    .addNode("mapAnswerResult", createMapAnswerResultNode(runtime))
    .addConditionalEdges(START, routeAction, {
      ingestSession: "ingestSession",
      assembleRetrieval: "assembleRetrieval",
      contexto: "contexto",
      shino: "shino",
      [END]: END,
    })
    .addConditionalEdges("ingestSession", routeGraphBatch, { contexto: "contexto", [END]: END })
    .addEdge("contexto", "applyGraphMutation")
    .addEdge("applyGraphMutation", "markGraphTracked")
    .addConditionalEdges("markGraphTracked", routeSummaryWindow, { shino: "shino", [END]: END })
    .addEdge("shino", "markSummaryTracked")
    .addEdge("markSummaryTracked", END)
    .addEdge("assembleRetrieval", "readMemory")
    .addEdge("readMemory", "assembleContext")
    .addEdge("assembleContext", "finalAnswer")
    .addEdge("finalAnswer", "mapAnswerResult")
    .addEdge("mapAnswerResult", END)
    .compile();
}
