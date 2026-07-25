import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createMapAnswerResultNode } from "../src/nodes/mapAnswerResult.js";
import type { WorkflowRuntime } from "../src/runtime.js";
import { ArtifactStore, EventRecorder } from "../src/services/artifacts.js";
import { emptyState } from "../src/state.js";
import { UNAVAILABLE_MEMORY_HYPOTHESIS } from "../src/types.js";
import type { RetrievalResult } from "../src/retrieval/types.js";

function retrieval(): RetrievalResult {
  return {
    windows: [],
    ranked: [],
    spans: [
      {
        sessionId: "s1",
        date: "2023-01-01",
        startTurn: 0,
        endTurn: 1,
        turns: [
          { turnIndex: 0, role: "user", content: "hi", truncated: false },
          { turnIndex: 1, role: "assistant", content: "hello", truncated: false },
        ],
        bestRank: 1,
        bestScore: 1,
        matchedTerms: ["hi"],
        characterCount: 10,
      },
    ],
    characterCount: 10,
    estimatedTokens: 3,
    options: {
      windowTurns: 2,
      windowStride: 1,
      topK: 48,
      charBudget: 80_000,
      maxTurnChars: 4_000,
      temporalBoost: 0.15,
    },
  };
}

describe("mapAnswerResult", () => {
  it("forces abstention text on insufficient and drops unknown citations", async () => {
    const root = await mkdtemp(join(tmpdir(), "backbone-map-"));
    try {
      const artifacts = new ArtifactStore(root);
      await artifacts.initialize();
      const runtime: WorkflowRuntime = {
        options: {
          window_turns: 2,
          window_stride: 1,
          top_k: 48,
          char_budget: 80_000,
          max_turn_chars: 4_000,
          temporal_boost: 0.15,
          answer_prompt: "answer",
        },
        artifacts,
        events: new EventRecorder(artifacts),
        models: {
          generateStructured: () => Promise.reject(new Error("unused")),
        },
        prompts: {
          render: () => Promise.reject(new Error("unused")),
        } as unknown as WorkflowRuntime["prompts"],
      };
      const state = emptyState("case-1");
      state.sessions = [
        {
          session_id: "s1",
          date: "2023-01-01",
          turns: [
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello" },
          ],
        },
      ];
      state.retrieval = retrieval();
      state.finalAnswerOutput = {
        hypothesis: "should be ignored",
        supportStatus: "insufficient",
        evidence: [
          { sessionId: "s1", turnIndex: 0 },
          { sessionId: "missing", turnIndex: 0 },
          { sessionId: "s1", turnIndex: 0 },
        ],
      };
      state.answerGeneration = {
        text: "{}",
        model: "test",
        provider: "openai",
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        latency_ms: 1,
        request_id: null,
        retry_count: 0,
      };
      const update = await createMapAnswerResultNode(runtime)(state);
      expect(update.answerResult?.hypothesis).toBe(UNAVAILABLE_MEMORY_HYPOTHESIS);
      expect(update.answerResult?.evidence).toEqual([{ session_id: "s1", turn_index: 0 }]);
      expect(update.warnings).toEqual(
        expect.arrayContaining([
          "dropped_unknown_evidence:missing:0",
          "dropped_duplicate_evidence:s1:0",
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
