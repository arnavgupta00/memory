import { describe, expect, it } from "vitest";

import {
  assertNoRawSessionIdLeak,
  buildOpaqueSessionSpace,
} from "../src/retrieval/opaqueSessionIds.js";
import type { SessionAnnotation } from "../src/retrieval/notesIndex.js";

const EMPTY_ANNOTATION: SessionAnnotation = {
  facts: [],
  keyphrases: [],
  events: [],
};

describe("opaque hop-retriever session IDs", () => {
  it("assigns deterministic per-case handles without preserving label order", () => {
    const sessionIds = ["answer_gold_1", "history_decoy_1", "answer_gold_2"];
    const datesBySessionId = new Map(sessionIds.map((id, index) => [id, `2026-0${index + 1}-01`]));
    const annotations = new Map(sessionIds.map((id) => [id, EMPTY_ANNOTATION]));

    const first = buildOpaqueSessionSpace({
      namespace: "case-a",
      sessionIds,
      datesBySessionId,
      annotations,
    });
    const second = buildOpaqueSessionSpace({
      namespace: "case-a",
      sessionIds,
      datesBySessionId,
      annotations,
    });

    expect(first.sessionIds).toEqual(sessionIds.map((id) => first.realToOpaque.get(id)));
    expect(first.sessionIds).toEqual(second.sessionIds);
    expect([...first.realToOpaque.values()]).toEqual([...second.realToOpaque.values()]);
    expect(first.sessionIds.every((id) => /^memory_\d{3}$/.test(id))).toBe(true);
    expect(first.sessionIds.some((id) => id.includes("answer"))).toBe(false);
    expect(first.annotations.size).toBe(3);
  });

  it("uses a distinct permutation namespace per question", () => {
    const sessionIds = Array.from({ length: 20 }, (_, index) => `session_${String(index)}`);
    const datesBySessionId = new Map<string, string>();
    const annotations = new Map<string, SessionAnnotation>();

    const first = buildOpaqueSessionSpace({
      namespace: "case-a",
      sessionIds,
      datesBySessionId,
      annotations,
    });
    const second = buildOpaqueSessionSpace({
      namespace: "case-b",
      sessionIds,
      datesBySessionId,
      annotations,
    });

    expect([...first.realToOpaque]).not.toEqual([...second.realToOpaque]);
  });

  it("detects a raw identifier in model-visible text", () => {
    expect(() =>
      assertNoRawSessionIdLeak("hit memory_001", ["answer_gold_1", "decoy_1"]),
    ).not.toThrow();
    expect(() =>
      assertNoRawSessionIdLeak("hit answer_gold_1", ["answer_gold_1", "decoy_1"]),
    ).toThrow("raw session ID leaked");
  });
});
