import { END, START, StateGraph } from "@langchain/langgraph";

import { createFinalAnswerNode } from "./nodes/finalAnswer.js";
import { createIngestSessionNode } from "./nodes/ingestSession.js";
import { createMapAnswerResultNode } from "./nodes/mapAnswerResult.js";
import { createRetrieveMemoryNode } from "./nodes/retrieveMemory.js";
import { createSelectContextNode } from "./nodes/selectContext.js";
import type { WorkflowRuntime } from "./runtime.js";
import { MemoryState } from "./state.js";

export function createMemoryWorkflow(runtime: WorkflowRuntime) {
  const routeAction = (state: typeof MemoryState.State) =>
    state.action === "ingest" ? "ingestSession" : "retrieveMemory";

  const afterRetrieve = () =>
    runtime.options.select_enabled ? "selectContext" : "finalAnswer";

  return new StateGraph(MemoryState)
    .addNode("ingestSession", createIngestSessionNode(runtime))
    .addNode("retrieveMemory", createRetrieveMemoryNode(runtime))
    .addNode("selectContext", createSelectContextNode(runtime))
    .addNode("finalAnswer", createFinalAnswerNode(runtime))
    .addNode("mapAnswerResult", createMapAnswerResultNode(runtime))
    .addConditionalEdges(START, routeAction, {
      ingestSession: "ingestSession",
      retrieveMemory: "retrieveMemory",
      [END]: END,
    })
    .addEdge("ingestSession", END)
    .addConditionalEdges("retrieveMemory", afterRetrieve, {
      selectContext: "selectContext",
      finalAnswer: "finalAnswer",
    })
    .addEdge("selectContext", "finalAnswer")
    .addEdge("finalAnswer", "mapAnswerResult")
    .addEdge("mapAnswerResult", END)
    .compile();
}
