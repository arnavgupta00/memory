import { retrieveMemory } from "../retrieval/retrieve.js";
import type { SelectedSpan } from "../retrieval/types.js";
import type { WorkflowRuntime } from "../runtime.js";
import type { MemoryStateType, MemoryStateUpdate } from "../state.js";
import type { JsonObject } from "../types.js";

export function createRetrieveMemoryNode(runtime: WorkflowRuntime) {
  return async (state: MemoryStateType): Promise<MemoryStateUpdate> => {
    if (!state.question) throw new Error("retrieveMemory requires a question");
    const retrieval = retrieveMemory({
      question: state.question,
      questionDate: state.questionDate,
      sessions: state.sessions,
      options: {
        windowTurns: runtime.options.window_turns,
        windowStride: runtime.options.window_stride,
        topK: runtime.options.top_k,
        charBudget: runtime.options.char_budget,
        maxTurnChars: runtime.options.max_turn_chars,
        temporalBoost: runtime.options.temporal_boost,
      },
    });
    await runtime.artifacts.writeAtomic("retrieval.json", {
      span_count: retrieval.spans.length,
      character_count: retrieval.characterCount,
      estimated_tokens: retrieval.estimatedTokens,
      options: retrieval.options,
      spans: retrieval.spans.map((span: SelectedSpan) => ({
        session_id: span.sessionId,
        date: span.date,
        start_turn: span.startTurn,
        end_turn: span.endTurn,
        best_rank: span.bestRank,
        best_score: span.bestScore,
        matched_terms: span.matchedTerms,
        character_count: span.characterCount,
      })),
    } as unknown as JsonObject);
    await runtime.events.record(
      "memory_retrieved",
      {
        span_count: retrieval.spans.length,
        character_count: retrieval.characterCount,
        estimated_tokens: retrieval.estimatedTokens,
      },
      null,
    );
    return { retrieval, currentNode: "retrieveMemory" };
  };
}
