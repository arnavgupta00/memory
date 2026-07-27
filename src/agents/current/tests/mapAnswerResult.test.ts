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

function makeRuntime(root: string): WorkflowRuntime {
  const artifacts = new ArtifactStore(root);
  return {
    options: {
      window_turns: 2,
      window_stride: 1,
      top_k: 48,
      char_budget: 80_000,
      max_turn_chars: 4_000,
      temporal_boost: 0.15,
      answer_prompt: "answer",
      select_enabled: false,
      select_prompt: "select-v2",
      package_max_turns: 24,
      package_char_budget: 12_000,
      package_supporting_enabled: true,
      package_sibling_sessions_enabled: true,
      package_sibling_session_max: 12,
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
}

describe("mapAnswerResult", () => {
  it("uses canned abstention only when insufficient and hypothesis is empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "backbone-map-"));
    try {
      const runtime = makeRuntime(root);
      await runtime.artifacts.initialize();
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
        evidenceTable: [],
        hypothesis: "   ",
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

  it("preserves a non-empty hypothesis even when supportStatus is insufficient", async () => {
    const root = await mkdtemp(join(tmpdir(), "backbone-map-keep-"));
    try {
      const runtime = makeRuntime(root);
      await runtime.artifacts.initialize();
      const state = emptyState("case-2");
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
        evidenceTable: [
          {
            date: "2023-01-01",
            fact: "17 poems",
            sessionId: "s1",
            turnIndex: 0,
          },
        ],
        hypothesis: "17 + 5 + 1 = 23 pieces completed.",
        supportStatus: "insufficient",
        evidence: [{ sessionId: "s1", turnIndex: 0 }],
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
      expect(update.answerResult?.hypothesis).toBe("17 + 5 + 1 = 23 pieces completed.");
      expect((update.answerResult?.trace as { support_status?: string }).support_status).toBe(
        "insufficient",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
