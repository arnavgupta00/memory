import { describe, expect, test } from "vitest";

import { retrieveMemory } from "../src/retrieval/hybridRetrieval.js";
import { buildReaderPromptEvidence } from "../src/services/readerEvidence.js";
import type { TimestampedSession } from "../src/types.js";

function session(id: string, content: string): TimestampedSession {
  return {
    session_id: id,
    date: "2025/01/01",
    turns: [{ role: "user", content }],
  };
}

describe("reader evidence budgets", () => {
  test("packs only whole candidate items and reports deterministic omissions", () => {
    const candidates = retrieveMemory({
      question: "Which workshop?",
      questionDate: "2025/01/02",
      sessions: [
        session("first", `workshop ${"a".repeat(200)}`),
        session("second", `workshop ${"b".repeat(200)}`),
        session("third", `workshop ${"c".repeat(200)}`),
      ],
      graph: { schemaVersion: 1, revision: 0, context: {}, provenanceByPointer: {} },
      summaries: [],
      mutationRecords: [],
      graphTrackedCount: 3,
      summaryTrackedCount: 0,
    }).candidates;
    const packed = buildReaderPromptEvidence(candidates, 900);
    const parsed = JSON.parse(packed.sessionCandidates) as unknown[];
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.length).toBeLessThan(3);
    expect(packed.omittedItems.length).toBeGreaterThan(0);
    expect(packed.includedBytes).toBeLessThanOrEqual(900);
  });

  test("exposes canonical session IDs and explicit turn indexes without internal document IDs", () => {
    const candidates = retrieveMemory({
      question: "Which workshop?",
      questionDate: "2025/01/02",
      sessions: [session("support", "I attended the ceramic workshop.")],
      graph: { schemaVersion: 1, revision: 0, context: {}, provenanceByPointer: {} },
      summaries: [],
      mutationRecords: [],
      graphTrackedCount: 1,
      summaryTrackedCount: 0,
    }).candidates;
    const packed = buildReaderPromptEvidence(candidates);
    expect(packed.sessionCandidates).toContain("\"sessionId\": \"support\"");
    expect(packed.sessionCandidates).toContain("\"turnIndex\": 0");
    expect(packed.sessionCandidates).not.toContain("\"documentId\"");
    expect(packed.sessionCandidates).not.toContain("session:000000:support");
    expect(packed.focusTurns).toEqual([
      {
        sessionId: "support",
        date: "2025/01/01",
        turnIndex: 0,
        role: "user",
        content: "I attended the ceramic workshop.",
        retrievalRank: 1,
      },
    ]);
  });

  test("rejects invalid budgets", () => {
    const empty = retrieveMemory({
      question: "?",
      questionDate: "2025/01/02",
      sessions: [],
      graph: { schemaVersion: 1, revision: 0, context: {}, provenanceByPointer: {} },
      summaries: [],
      mutationRecords: [],
      graphTrackedCount: 0,
      summaryTrackedCount: 0,
    }).candidates;
    expect(() => buildReaderPromptEvidence(empty, 0)).toThrow("positive integer");
  });
});
