import { describe, expect, test } from "vitest";

import { retrieveMemory } from "../src/retrieval/hybridRetrieval.js";
import type {
  GraphMutationRecord,
  MasterContextGraph,
  SessionSummaryRecord,
  TimestampedSession,
} from "../src/types.js";

const sessions: TimestampedSession[] = [
  {
    session_id: "s1",
    date: "2025/01/01",
    turns: [
      { role: "user", content: "I used to practice yoga twice each week." },
      { role: "assistant", content: "That sounds consistent." },
    ],
  },
  {
    session_id: "s2",
    date: "2025/01/02",
    turns: [
      { role: "user", content: "I now practice yoga three times each week." },
      { role: "assistant", content: "Your routine has increased." },
    ],
  },
  {
    session_id: "s3",
    date: "2025/01/03",
    turns: [
      { role: "user", content: "I attended a pottery class." },
      { role: "assistant", content: "The glazing method I recommended was wax resist." },
    ],
  },
  {
    session_id: "s4",
    date: "2025/01/04",
    turns: [
      { role: "user", content: "My train arrived late." },
      { role: "assistant", content: "I hope tomorrow is smoother." },
    ],
  },
];

const graph: MasterContextGraph = {
  schemaVersion: 1,
  revision: 2,
  context: {
    routines: {
      user: {
        yoga_frequency: {
          memory_type: "measurement",
          current: {
            value: { count: 3, period: "week" },
            observed_at: "2025/01/02",
            effective_at: null,
            unit: "times_per_week",
          },
          history: {
            observation_old: {
              value: { count: 2, period: "week" },
              observed_at: "2025/01/01",
              effective_at: null,
              unit: "times_per_week",
            },
          },
        },
      },
    },
  },
  provenanceByPointer: {
    "/context/routines/user/yoga_frequency/current/value/count": [
      {
        sessionId: "s2",
        turnIndex: 0,
        sessionDate: "2025/01/02",
        batchId: "batch-1",
        excerpt: "I now practice yoga three times each week.",
      },
    ],
    "/context/routines/user/yoga_frequency/history/observation_old/value/count": [
      {
        sessionId: "s1",
        turnIndex: 0,
        sessionDate: "2025/01/01",
        batchId: "batch-1",
        excerpt: "I used to practice yoga twice each week.",
      },
    ],
  },
};

const summaries: SessionSummaryRecord[] = [{
  windowId: "window-1",
  sessionIds: ["s1", "s2", "s3"],
  graphRevision: 2,
  summary: "The yoga routine changed and a pottery method was recommended.",
}];

const mutationRecords: GraphMutationRecord[] = [{
  batchId: "batch-1",
  sessionIds: ["s1", "s2", "s3"],
  mode: "semantic_updates",
  explanation: "stored",
  accepted: true,
  diffs: [],
  graphRevisionBefore: 1,
  graphRevisionAfter: 2,
  graphHash: "hash",
  coverage: {
    schemaVersion: 1,
    batchId: "batch-1",
    graphRevisionBefore: 1,
    graphRevisionAfter: 2,
    graphHash: "hash",
    highPrioritySignalCount: 1,
    counts: { graphCovered: 0, duplicate: 0, sessionIndexFallback: 1 },
    signals: [{
      signalId: "fallback-1",
      sessionId: "s3",
      turnIndex: 1,
      text: "The glazing method was wax resist.",
      status: "session_index_fallback",
      requiredAnchors: [],
      matchedAnchors: [],
      matchedUpdateIndices: [],
      matchedPointers: [],
      rationale: "no_deterministic_match",
    }],
  },
}];

describe("hybrid retrieval", () => {
  test("searches lossless sessions, graph cells, summaries, coverage fallback, and tail independently", () => {
    const result = retrieveMemory({
      question: "What glazing method did you recommend for pottery?",
      questionDate: "2025/01/05",
      sessions,
      graph,
      summaries,
      mutationRecords,
      graphTrackedCount: 3,
      summaryTrackedCount: 3,
    });
    expect(result.candidates.sessions[0]?.session.session_id).toBe("s3");
    expect(result.candidates.summaries[0]?.summary.windowId).toBe("window-1");
    expect(result.candidates.coverageFallbackSessions[0]).toMatchObject({
      sessionId: "s3",
      signalId: "fallback-1",
    });
    expect(result.candidates.tailSessions[0]?.session.session_id).toBe("s4");
    expect(result.manifest.documentCounts).toEqual({
      session: 4,
      graph_cell: 1,
      summary: 1,
      coverage_fallback: 1,
      tail: 1,
    });
  });

  test("indexes graph current/history values and expands their raw source sessions", () => {
    const result = retrieveMemory({
      question: "How often do I practice yoga now and before?",
      questionDate: "2025/01/05",
      sessions,
      graph,
      summaries,
      mutationRecords,
      graphTrackedCount: 3,
      summaryTrackedCount: 3,
    });
    expect(result.candidates.graphCells[0]?.pointer).toBe(
      "/context/routines/user/yoga_frequency",
    );
    expect(result.candidates.graphCells[0]?.value).toContain("\"count\":3");
    expect(result.candidates.graphCells[0]?.value).toContain("\"count\":2");
    expect(result.candidates.sessions.map((item) => item.session.session_id)).toEqual(
      expect.arrayContaining(["s1", "s2"]),
    );
  });

  test("caps each retrieval channel at its declared bound", () => {
    const manySessions = Array.from({ length: 20 }, (_, index): TimestampedSession => ({
      session_id: `session-${String(index).padStart(2, "0")}`,
      date: `2025/01/${String(index + 1).padStart(2, "0")}`,
      turns: [{ role: "user", content: "I attended the recurring workshop." }],
    }));
    const result = retrieveMemory({
      question: "Which workshop did I attend?",
      questionDate: "2025/02/01",
      sessions: manySessions,
      graph: { schemaVersion: 1, revision: 0, context: {}, provenanceByPointer: {} },
      summaries: [],
      mutationRecords: [],
      graphTrackedCount: 18,
      summaryTrackedCount: 18,
    });
    expect(result.candidates.sessions).toHaveLength(12);
    expect(result.candidates.graphCells.length).toBeLessThanOrEqual(12);
    expect(result.candidates.summaries.length).toBeLessThanOrEqual(4);
    expect(result.candidates.coverageFallbackSessions.length).toBeLessThanOrEqual(4);
    expect(result.candidates.tailSessions).toHaveLength(2);
  });
});
