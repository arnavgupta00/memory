import { describe, expect, test } from "vitest";

import { retrieveMemory } from "../src/retrieval/hybridRetrieval.js";
import {
  expandAdjacentTurns,
  sanitizeReaderPlan,
} from "../src/services/readerPlan.js";
import {
  ReaderPlanSchema,
  type MasterContextGraph,
  type ReaderPlan,
  type TimestampedSession,
} from "../src/types.js";

const sessions: TimestampedSession[] = [
  {
    session_id: "assistant-answer",
    date: "2025/01/01",
    turns: [
      { role: "user", content: "Which color should I choose?" },
      { role: "assistant", content: "I recommend the amber color." },
      { role: "user", content: "That works for me." },
    ],
  },
  {
    session_id: "older",
    date: "2025/01/02",
    turns: [{ role: "user", content: "I practiced twice each week." }],
  },
  {
    session_id: "newer",
    date: "2025/01/03",
    turns: [{ role: "user", content: "I now practice three times each week." }],
  },
  {
    session_id: "tail",
    date: "2025/01/04",
    turns: [{ role: "user", content: "The appointment starts at seven." }],
  },
];

const graph: MasterContextGraph = {
  schemaVersion: 1,
  revision: 1,
  context: {
    routines: {
      user: {
        practice_frequency: {
          memory_type: "measurement",
          current: {
            value: 3,
            observed_at: "2025/01/03",
            effective_at: null,
            unit: "times_per_week",
          },
          history: {
            observation_old: {
              value: 2,
              observed_at: "2025/01/02",
              effective_at: null,
              unit: "times_per_week",
            },
          },
        },
      },
    },
  },
  provenanceByPointer: {
    "/context/routines/user/practice_frequency/current/value": [{
      sessionId: "newer",
      turnIndex: 0,
      sessionDate: "2025/01/03",
      batchId: "b1",
      excerpt: "I now practice three times each week.",
    }],
    "/context/routines/user/practice_frequency/history/observation_old/value": [{
      sessionId: "older",
      turnIndex: 0,
      sessionDate: "2025/01/02",
      batchId: "b1",
      excerpt: "I practiced twice each week.",
    }],
  },
};

function candidates(question: string) {
  return retrieveMemory({
    question,
    questionDate: "2025/01/05",
    sessions,
    graph,
    summaries: [],
    mutationRecords: [],
    graphTrackedCount: 3,
    summaryTrackedCount: 0,
  }).candidates;
}

function plan(overrides: Partial<ReaderPlan> = {}): ReaderPlan {
  return {
    supportStatus: "sufficient",
    answerMode: "direct",
    selectedSessions: [{
      sessionId: "assistant-answer",
      turnIndexes: [1],
      purpose: "direct_answer",
    }],
    selectedGraphPointers: [],
    evidenceFacts: [{
      statement: "The assistant recommended amber.",
      sessionIds: ["assistant-answer"],
      graphPointers: [],
    }],
    conflicts: [],
    ...overrides,
  };
}

describe("reader plan contracts", () => {
  test.each([
    "direct",
    "knowledge_update",
    "temporal_comparison",
    "multi_session",
    "preference",
    "assistant_answer",
    "abstain",
  ] as const)("accepts the %s answer mode under one strict schema", (answerMode) => {
    expect(ReaderPlanSchema.parse(plan({ answerMode })).answerMode).toBe(answerMode);
  });

  test("retains assistant evidence and expands the adjacent user/assistant pair", () => {
    const expanded = expandAdjacentTurns({
      plan: plan({ answerMode: "assistant_answer" }),
      sessions,
    });
    expect(expanded[0]?.turns.map((turn) => turn.content)).toEqual([
      "Which color should I choose?",
      "I recommend the amber color.",
      "That works for me.",
    ]);
  });

  test("keeps older/newer update evidence and conflicts with valid graph provenance", () => {
    const pointer = "/context/routines/user/practice_frequency";
    const sanitized = sanitizeReaderPlan({
      raw: plan({
        answerMode: "knowledge_update",
        supportStatus: "conflicted",
        selectedSessions: [
          { sessionId: "older", turnIndexes: [0], purpose: "older_state" },
          { sessionId: "newer", turnIndexes: [0], purpose: "newer_state" },
        ],
        selectedGraphPointers: [pointer],
        evidenceFacts: [{
          statement: "The current frequency is three and the older value was two.",
          sessionIds: ["older", "newer"],
          graphPointers: [pointer],
        }],
        conflicts: [{
          olderStatement: "Twice each week.",
          newerStatement: "Three times each week.",
          resolution: "The newer direct statement supersedes the older value.",
        }],
      }),
      candidates: candidates("How often do I practice now?"),
      sessions,
      graph,
    });
    expect(sanitized.plan.supportStatus).toBe("conflicted");
    expect(sanitized.plan.selectedSessions).toHaveLength(2);
    expect(sanitized.plan.selectedGraphPointers).toEqual([pointer]);
    expect(sanitized.warnings).toEqual([]);
  });

  test("allows the unprocessed tail as evidence", () => {
    const sanitized = sanitizeReaderPlan({
      raw: plan({
        selectedSessions: [{
          sessionId: "tail",
          turnIndexes: [0],
          purpose: "direct_answer",
        }],
        evidenceFacts: [{
          statement: "The appointment starts at seven.",
          sessionIds: ["tail"],
          graphPointers: [],
        }],
      }),
      candidates: candidates("When does the appointment start?"),
      sessions,
      graph,
    });
    expect(sanitized.plan.selectedSessions[0]?.sessionId).toBe("tail");
  });

  test("removes unknown references and forces an unsupported plan to abstain", () => {
    const sanitized = sanitizeReaderPlan({
      raw: plan({
        selectedSessions: [{
          sessionId: "fabricated",
          turnIndexes: [99],
          purpose: "direct_answer",
        }],
        selectedGraphPointers: ["/context/fabricated/value"],
        evidenceFacts: [{
          statement: "A fabricated claim.",
          sessionIds: ["fabricated"],
          graphPointers: ["/context/fabricated/value"],
        }],
      }),
      candidates: candidates("What is unavailable?"),
      sessions,
      graph,
    });
    expect(sanitized.plan).toMatchObject({
      supportStatus: "insufficient",
      answerMode: "abstain",
      selectedSessions: [],
      selectedGraphPointers: [],
      evidenceFacts: [],
    });
    expect(sanitized.warnings.length).toBeGreaterThanOrEqual(3);
  });

  test("represents a clean abstention without inventing evidence", () => {
    const abstention = ReaderPlanSchema.parse({
      supportStatus: "insufficient",
      answerMode: "abstain",
      selectedSessions: [],
      selectedGraphPointers: [],
      evidenceFacts: [],
      conflicts: [],
    });
    expect(abstention.evidenceFacts).toEqual([]);
  });
});
