import { describe, expect, test } from "vitest";

import {
  createCandidateConstrainedFinalAnswerSchema,
  FINAL_ANSWER_EVIDENCE_LIMIT,
} from "../src/services/finalAnswerSchema.js";
import type {
  CompactFinalEvidencePayload,
} from "../src/services/finalEvidencePackage.js";

function payload(): CompactFinalEvidencePayload {
  return {
    schemaVersion: 1,
    readerDecision: {
      supportStatus: "sufficient",
      answerMode: "knowledge_update",
    },
    evidenceFacts: [],
    conflicts: [],
    graphEvidence: [],
    sessions: [
      {
        sessionId: "older",
        date: "2025/01/01",
        purposes: ["older_state"],
        turns: [
          { turnIndex: 1, role: "user", content: "The old value was two.", selection: "reader_selected" },
          {
            turnIndex: 2,
            role: "assistant",
            content: "The previous value was two.",
            selection: "adjacent_context",
          },
        ],
      },
      {
        sessionId: "newer",
        date: "2025/01/02",
        purposes: ["newer_state"],
        turns: [
          { turnIndex: 4, role: "user", content: "The new value is three.", selection: "reader_selected" },
        ],
      },
    ],
  };
}

describe("candidate-constrained final-answer schema", () => {
  test("accepts canonical included turns and session-level null references", () => {
    const result = createCandidateConstrainedFinalAnswerSchema(payload()).parse({
      hypothesis: "The current value is three.",
      evidence: [
        { sessionId: "older", turnIndex: null },
        { sessionId: "older", turnIndex: 2 },
        { sessionId: "newer", turnIndex: 4 },
      ],
      supportStatus: "supported",
    });
    expect(result.evidence).toHaveLength(3);
  });

  test("rejects an unknown session ID", () => {
    const result = createCandidateConstrainedFinalAnswerSchema(payload()).safeParse({
      hypothesis: "Unsupported.",
      evidence: [{ sessionId: "invented", turnIndex: 0 }],
      supportStatus: "supported",
    });
    expect(result.success).toBe(false);
  });

  test("rejects a real turn index that was not included for that session", () => {
    const schema = createCandidateConstrainedFinalAnswerSchema(payload());
    expect(schema.safeParse({
      hypothesis: "The current value is three.",
      evidence: [{ sessionId: "newer", turnIndex: 2 }],
      supportStatus: "supported",
    }).success).toBe(false);
    expect(schema.safeParse({
      hypothesis: "The current value is three.",
      evidence: [{ sessionId: "older", turnIndex: 4 }],
      supportStatus: "supported",
    }).success).toBe(false);
  });

  test("caps the number of evidence references", () => {
    const evidence = Array.from(
      { length: FINAL_ANSWER_EVIDENCE_LIMIT + 1 },
      () => ({ sessionId: "older", turnIndex: 1 }),
    );
    expect(createCandidateConstrainedFinalAnswerSchema(payload()).safeParse({
      hypothesis: "Too many references.",
      evidence,
      supportStatus: "supported",
    }).success).toBe(false);
  });

  test("supports an empty abstention package without an empty enum", () => {
    const emptyPayload: CompactFinalEvidencePayload = {
      schemaVersion: 1,
      readerDecision: {
        supportStatus: "insufficient",
        answerMode: "abstain",
      },
      evidenceFacts: [],
      conflicts: [],
      graphEvidence: [],
      sessions: [],
    };
    const schema = createCandidateConstrainedFinalAnswerSchema(emptyPayload);
    expect(schema.safeParse({
      hypothesis: "The information is unavailable.",
      evidence: [],
      supportStatus: "insufficient",
    }).success).toBe(true);
    expect(schema.safeParse({
      hypothesis: "Invented answer.",
      evidence: [{ sessionId: "invented", turnIndex: null }],
      supportStatus: "supported",
    }).success).toBe(false);
  });
});
