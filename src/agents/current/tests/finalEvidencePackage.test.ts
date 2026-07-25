import { describe, expect, test } from "vitest";

import {
  buildCompactFinalEvidencePackage,
} from "../src/services/finalEvidencePackage.js";
import type {
  MasterContextGraph,
  ReaderPlan,
  TimestampedSession,
} from "../src/types.js";

const sessions: TimestampedSession[] = [
  {
    session_id: "selected",
    date: "2025/01/01",
    turns: [
      { role: "user", content: "The older routine was twice each week." },
      { role: "assistant", content: "That was the previous frequency." },
      { role: "user", content: "I now attend yoga three times each week." },
      { role: "assistant", content: "The current frequency is three times." },
      { role: "user", content: "This distant turn must not be included." },
    ],
  },
  {
    session_id: "unselected",
    date: "2025/01/02",
    turns: [{ role: "user", content: "Private unrelated conversation." }],
  },
];

const pointer = "/context/routines/yoga/current";
const graph: MasterContextGraph = {
  schemaVersion: 1,
  revision: 1,
  context: {
    routines: {
      yoga: {
        current: {
          frequency: "three times each week",
        },
        historical: {
          frequency: "twice each week",
        },
      },
    },
  },
  provenanceByPointer: {
    "/context/routines/yoga/current/frequency": [{
      sessionId: "selected",
      turnIndex: 2,
      sessionDate: "2025/01/01",
      batchId: "batch-1",
      excerpt: "I now attend yoga three times each week.",
    }],
    "/context/routines/yoga/historical/frequency": [{
      sessionId: "selected",
      turnIndex: 0,
      sessionDate: "2025/01/01",
      batchId: "batch-1",
      excerpt: "The older routine was twice each week.",
    }],
  },
};

function readerPlan(): ReaderPlan {
  return {
    supportStatus: "sufficient",
    answerMode: "knowledge_update",
    selectedSessions: [{
      sessionId: "selected",
      turnIndexes: [2],
      purpose: "newer_state",
    }],
    selectedGraphPointers: [pointer],
    evidenceFacts: [{
      statement: "The current yoga frequency is three times each week.",
      sessionIds: ["selected"],
      graphPointers: [pointer],
    }],
    conflicts: [{
      olderStatement: "The older routine was twice each week.",
      newerStatement: "The current routine is three times each week.",
      resolution: "Use the newer supported state.",
    }],
  };
}

describe("compact final evidence package", () => {
  test("contains only reader-selected evidence with adjacent raw turns", () => {
    const result = buildCompactFinalEvidencePackage({
      plan: readerPlan(),
      sessions,
      graph,
    });

    expect(result.payload.sessions).toEqual([{
      sessionId: "selected",
      date: "2025/01/01",
      purposes: ["newer_state", "context"],
      turns: [
        {
          turnIndex: 2,
          role: "user",
          content: "I now attend yoga three times each week.",
          selection: "reader_selected",
        },
        {
          turnIndex: 1,
          role: "assistant",
          content: "That was the previous frequency.",
          selection: "adjacent_context",
        },
        {
          turnIndex: 3,
          role: "assistant",
          content: "The current frequency is three times.",
          selection: "adjacent_context",
        },
      ],
    }]);
    expect(JSON.stringify(result.payload)).not.toContain("unselected");
    expect(JSON.stringify(result.payload)).not.toContain("distant turn");
    expect(result.payload.graphEvidence).toEqual([{
      pointer,
      value: { frequency: "three times each week" },
      sources: [graph.provenanceByPointer[
        "/context/routines/yoga/current/frequency"
      ]?.[0]],
    }]);
  });

  test("never truncates an evidence item to satisfy the byte budget", () => {
    const oversized = "distinct-ending".padStart(4_000, "x");
    const largeSession: TimestampedSession = {
      session_id: "large",
      date: "2025/01/03",
      turns: [
        { role: "user", content: oversized },
        { role: "assistant", content: "short adjacent answer" },
      ],
    };
    const plan: ReaderPlan = {
      supportStatus: "sufficient",
      answerMode: "direct",
      selectedSessions: [{
        sessionId: "large",
        turnIndexes: [0],
        purpose: "direct_answer",
      }],
      selectedGraphPointers: [],
      evidenceFacts: [{
        statement: "The selected session contains the answer.",
        sessionIds: ["large"],
        graphPointers: [],
      }],
      conflicts: [],
    };
    const result = buildCompactFinalEvidencePackage({
      plan,
      sessions: [largeSession],
      graph,
      byteBudget: 700,
    });

    expect(result.promptByteEstimate).toBeLessThanOrEqual(700);
    expect(result.omittedItems).toContain("session:large:turn:0");
    expect(JSON.stringify(result.payload)).not.toContain("distinct-ending");
    expect(result.payload.sessions[0]?.turns).toEqual([{
      turnIndex: 1,
      role: "assistant",
      content: "short adjacent answer",
      selection: "adjacent_context",
    }]);
  });

  test("reserves raw source turns before model-authored paraphrases", () => {
    const plan = readerPlan();
    plan.evidenceFacts = [{
      statement: "oversized".padEnd(5_000, "x"),
      sessionIds: ["selected"],
      graphPointers: [],
    }];
    plan.selectedGraphPointers = [];
    const result = buildCompactFinalEvidencePackage({
      plan,
      sessions,
      graph,
      byteBudget: 900,
    });

    expect(result.payload.sessions[0]?.turns.map((turn) => turn.turnIndex))
      .toEqual([2, 1, 3]);
    expect(result.payload.evidenceFacts).toEqual([]);
    expect(result.omittedItems).toContain("fact:0");
  });

  test("materializes graph provenance turns for a graph-only reader plan", () => {
    const plan: ReaderPlan = {
      supportStatus: "sufficient",
      answerMode: "direct",
      selectedSessions: [],
      selectedGraphPointers: [pointer],
      evidenceFacts: [{
        statement: "The graph contains the current yoga frequency.",
        sessionIds: [],
        graphPointers: [pointer],
      }],
      conflicts: [],
    };
    const result = buildCompactFinalEvidencePackage({
      plan,
      sessions,
      graph,
    });

    expect(result.payload.sessions).toHaveLength(1);
    expect(result.payload.sessions[0]?.sessionId).toBe("selected");
    expect(result.payload.sessions[0]?.turns.map((turn) => turn.turnIndex))
      .toEqual([2, 1, 3]);
    expect(result.payload.graphEvidence).toHaveLength(1);
  });

  test("caps selected sessions and facts independently of unchecked input", () => {
    const manySessions: TimestampedSession[] = Array.from(
      { length: 9 },
      (_, index) => ({
        session_id: `session-${index}`,
        date: "2025/01/01",
        turns: [{ role: "user" as const, content: `evidence ${index}` }],
      }),
    );
    const plan: ReaderPlan = {
      supportStatus: "sufficient",
      answerMode: "multi_session",
      selectedSessions: manySessions.map((session) => ({
        sessionId: session.session_id,
        turnIndexes: [0],
        purpose: "operand",
      })),
      selectedGraphPointers: [],
      evidenceFacts: Array.from({ length: 13 }, (_, index) => ({
        statement: `fact ${index}`,
        sessionIds: ["session-0"],
        graphPointers: [],
      })),
      conflicts: [],
    };
    const result = buildCompactFinalEvidencePackage({
      plan,
      sessions: manySessions,
      graph,
    });

    expect(result.payload.sessions).toHaveLength(8);
    expect(result.payload.evidenceFacts).toHaveLength(12);
  });

  test("is byte-stable and deterministic", () => {
    const first = buildCompactFinalEvidencePackage({
      plan: readerPlan(),
      sessions,
      graph,
    });
    const second = buildCompactFinalEvidencePackage({
      plan: readerPlan(),
      sessions,
      graph,
    });

    expect(second).toEqual(first);
    expect(first.promptByteEstimate).toBe(
      Buffer.byteLength(JSON.stringify(first.payload), "utf8"),
    );
    expect(first.promptTokenEstimate).toBe(
      Math.ceil(first.promptByteEstimate / 4),
    );
  });
});
