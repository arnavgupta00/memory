import { describe, expect, test } from "vitest";

import type {
  Bm25SearchResult,
  RetrievalCandidates,
} from "../src/retrieval/types.js";
import { createCandidateConstrainedReaderPlanSchema } from "../src/services/readerSchema.js";
import type { ReaderFocusTurn } from "../src/services/readerFocus.js";
import type { TimestampedSession } from "../src/types.js";

function searchResult(documentId: string, rank: number): Bm25SearchResult {
  return {
    documentId,
    score: 1,
    bm25Score: 1,
    temporalBoost: 0,
    matchedTerms: [],
    rank,
  };
}

const firstSession: TimestampedSession = {
  session_id: "session-one",
  date: "2025/01/01",
  turns: [
    { role: "user", content: "My previous value was two." },
    { role: "assistant", content: "I will remember the previous value." },
  ],
};

const secondSession: TimestampedSession = {
  session_id: "session-two",
  date: "2025/01/02",
  turns: [
    { role: "user", content: "My current value is three." },
    { role: "assistant", content: "The current value is three." },
    { role: "user", content: "That is correct." },
  ],
};

function candidates(includeGraphPointer: boolean): RetrievalCandidates {
  return {
    schemaVersion: 1,
    question: "What is my current value?",
    questionDate: "2025/01/03",
    sessions: [
      { ...searchResult("session:one", 1), session: firstSession },
      { ...searchResult("session:two", 2), session: secondSession },
    ],
    graphCells: includeGraphPointer
      ? [{
          ...searchResult("graph:current-value", 1),
          pointer: "/context/measurements/current_value",
          value: "3",
          sessionIds: ["session-two"],
        }]
      : [],
    summaries: [],
    coverageFallbackSessions: [],
    tailSessions: [],
  };
}

function validPlan() {
  return {
    supportStatus: "sufficient" as const,
    answerMode: "knowledge_update" as const,
    selectedSessions: [
      {
        sessionId: "session-one",
        turnIndexes: [0, 1],
        purpose: "older_state" as const,
      },
      {
        sessionId: "session-two",
        turnIndexes: [0, 1, 2],
        purpose: "newer_state" as const,
      },
    ],
    selectedGraphPointers: ["/context/measurements/current_value"],
    evidenceFacts: [{
      statement: "The current value is three and the previous value was two.",
      sessionIds: ["session-one", "session-two"],
      graphPointers: ["/context/measurements/current_value"],
    }],
    conflicts: [],
  };
}

describe("candidate-constrained reader schema", () => {
  test("accepts a plan containing only supplied references", () => {
    const parsed = createCandidateConstrainedReaderPlanSchema(
      candidates(true),
    ).parse(validPlan());
    expect(parsed.selectedSessions.map((session) => session.sessionId)).toEqual([
      "session-one",
      "session-two",
    ]);
  });

  test("rejects unknown selected-session and evidence-fact IDs", () => {
    const schema = createCandidateConstrainedReaderPlanSchema(candidates(true));
    expect(schema.safeParse({
      ...validPlan(),
      selectedSessions: [{
        sessionId: "invented-session",
        turnIndexes: [0],
        purpose: "direct_answer",
      }],
    }).success).toBe(false);
    expect(schema.safeParse({
      ...validPlan(),
      evidenceFacts: [{
        statement: "An invented source.",
        sessionIds: ["invented-session"],
        graphPointers: [],
      }],
    }).success).toBe(false);
  });

  test("rejects a turn index that is invalid for its selected session", () => {
    const result = createCandidateConstrainedReaderPlanSchema(
      candidates(true),
    ).safeParse({
      ...validPlan(),
      selectedSessions: [{
        sessionId: "session-one",
        turnIndexes: [2],
        purpose: "direct_answer",
      }],
    });
    expect(result.success).toBe(false);
  });

  test("constrains turn indexes to the excerpts actually shown to the reader", () => {
    const focusTurns: ReaderFocusTurn[] = [{
      sessionId: "session-two",
      date: "2025/01/02",
      turnIndex: 1,
      role: "assistant",
      content: "The current value is three.",
      retrievalRank: 2,
    }];
    const schema = createCandidateConstrainedReaderPlanSchema(
      candidates(false),
      focusTurns,
    );
    expect(schema.safeParse({
      ...validPlan(),
      selectedSessions: [{
        sessionId: "session-two",
        turnIndexes: [1],
        purpose: "direct_answer",
      }],
      selectedGraphPointers: [],
      evidenceFacts: [{
        statement: "The current value is three.",
        sessionIds: ["session-two"],
        graphPointers: [],
      }],
    }).success).toBe(true);
    expect(schema.safeParse({
      ...validPlan(),
      selectedSessions: [{
        sessionId: "session-two",
        turnIndexes: [0],
        purpose: "direct_answer",
      }],
      selectedGraphPointers: [],
      evidenceFacts: [],
    }).success).toBe(false);
  });

  test("requires pointer arrays to be empty when no graph candidate exists", () => {
    const schema = createCandidateConstrainedReaderPlanSchema(candidates(false));
    expect(schema.safeParse({
      ...validPlan(),
      selectedGraphPointers: [],
      evidenceFacts: [{
        ...validPlan().evidenceFacts[0],
        graphPointers: [],
      }],
    }).success).toBe(true);
    expect(schema.safeParse({
      ...validPlan(),
      selectedGraphPointers: ["/context/measurements/current_value"],
    }).success).toBe(false);
    expect(schema.safeParse({
      ...validPlan(),
      selectedGraphPointers: [],
      evidenceFacts: validPlan().evidenceFacts,
    }).success).toBe(false);
  });

  test("accepts supplied graph pointers and rejects invented pointers", () => {
    const schema = createCandidateConstrainedReaderPlanSchema(candidates(true));
    expect(schema.safeParse(validPlan()).success).toBe(true);
    expect(schema.safeParse({
      ...validPlan(),
      selectedGraphPointers: ["/context/invented"],
    }).success).toBe(false);
  });
});
