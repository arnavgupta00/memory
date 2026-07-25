import { describe, expect, test } from "vitest";

import { validateFinalAnswerSafety } from "../src/services/finalAnswerSafety.js";
import type {
  FinalAnswer,
  ReaderPlan,
  TimestampedSession,
} from "../src/types.js";

const sessions: TimestampedSession[] = [
  {
    session_id: "selected",
    date: "2025/01/01",
    turns: [
      { role: "user", content: "Which option did I choose?" },
      { role: "assistant", content: "You chose the amber option." },
      { role: "user", content: "That is correct." },
      { role: "assistant", content: "A later unrelated response." },
    ],
  },
  {
    session_id: "unselected",
    date: "2025/01/02",
    turns: [{ role: "user", content: "This session was not selected." }],
  },
];

function readerPlan(overrides: Partial<ReaderPlan> = {}): ReaderPlan {
  return {
    supportStatus: "sufficient",
    answerMode: "assistant_answer",
    selectedSessions: [{
      sessionId: "selected",
      turnIndexes: [1],
      purpose: "direct_answer",
    }],
    selectedGraphPointers: [],
    evidenceFacts: [{
      statement: "The selected option was amber.",
      sessionIds: ["selected"],
      graphPointers: [],
    }],
    conflicts: [],
    ...overrides,
  };
}

function answer(overrides: Partial<FinalAnswer> = {}): FinalAnswer {
  return {
    hypothesis: "You chose the amber option.",
    evidence: [{ sessionId: "selected", turnIndex: 1 }],
    supportStatus: "supported",
    ...overrides,
  };
}

describe("final answer safety", () => {
  test("accepts selected evidence and its adjacent paired turn", () => {
    const result = validateFinalAnswerSafety({
      question: "Which option did I choose?",
      answer: answer({
        evidence: [
          { sessionId: "selected", turnIndex: 0 },
          { sessionId: "selected", turnIndex: 1 },
          { sessionId: "selected", turnIndex: 2 },
        ],
      }),
      readerPlan: readerPlan(),
      sessions,
    });

    expect(result).toMatchObject({
      forcedInsufficient: false,
      issues: [],
      rejectedEvidence: [],
    });
    expect(result.answer.evidence).toHaveLength(3);
  });

  test("removes unknown, unselected, unrelated-turn, and duplicate evidence", () => {
    const result = validateFinalAnswerSafety({
      question: "Which option did I choose?",
      answer: answer({
        evidence: [
          { sessionId: "selected", turnIndex: 1 },
          { sessionId: "selected", turnIndex: 1 },
          { sessionId: "selected", turnIndex: 3 },
          { sessionId: "selected", turnIndex: 99 },
          { sessionId: "unselected", turnIndex: 0 },
          { sessionId: "missing", turnIndex: null },
        ],
      }),
      readerPlan: readerPlan(),
      sessions,
    });

    expect(result.forcedInsufficient).toBe(false);
    expect(result.answer.evidence).toEqual([
      { sessionId: "selected", turnIndex: 1 },
    ]);
    expect(result.rejectedEvidence.map((rejected) => rejected.reason))
      .toEqual([
        "duplicate",
        "turn_not_selected",
        "unknown_turn",
        "session_not_selected",
        "unknown_session",
      ]);
  });

  test("accepts a session-level reference within the reader boundary", () => {
    const result = validateFinalAnswerSafety({
      question: "Which option did I choose?",
      answer: answer({
        evidence: [{ sessionId: "selected", turnIndex: null }],
      }),
      readerPlan: readerPlan(),
      sessions,
    });

    expect(result.validEvidence).toEqual([
      { sessionId: "selected", turnIndex: null },
    ]);
    expect(result.forcedInsufficient).toBe(false);
  });

  test("rejects an exact question-restatement hypothesis", () => {
    const question = "Which option did I choose?";
    const result = validateFinalAnswerSafety({
      question,
      answer: answer({ hypothesis: `The user asked: "${question}"` }),
      readerPlan: readerPlan(),
      sessions,
    });

    expect(result.forcedInsufficient).toBe(true);
    expect(result.issues).toContainEqual({
      code: "question_restatement_hypothesis",
    });
    expect(result.answer).toEqual({
      hypothesis: "",
      evidence: [],
      supportStatus: "insufficient",
    });
  });

  test("forces a supported answer without valid evidence to insufficient", () => {
    const result = validateFinalAnswerSafety({
      question: "Which option did I choose?",
      answer: answer({
        evidence: [{ sessionId: "unselected", turnIndex: 0 }],
      }),
      readerPlan: readerPlan(),
      sessions,
    });

    expect(result.forcedInsufficient).toBe(true);
    expect(result.issues).toContainEqual({
      code: "supported_answer_without_valid_evidence",
    });
    expect(result.answer.supportStatus).toBe("insufficient");
    expect(result.answer.hypothesis).toBe("");
  });

  test("does not let the final answer override an insufficient reader", () => {
    const result = validateFinalAnswerSafety({
      question: "Which option did I choose?",
      answer: answer(),
      readerPlan: readerPlan({
        supportStatus: "insufficient",
        answerMode: "abstain",
        selectedSessions: [],
        evidenceFacts: [],
      }),
      sessions,
    });

    expect(result.forcedInsufficient).toBe(true);
    expect(result.issues).toEqual(expect.arrayContaining([
      { code: "reader_plan_insufficient" },
      { code: "supported_answer_without_valid_evidence" },
    ]));
    expect(result.answer).toEqual({
      hypothesis: "",
      evidence: [],
      supportStatus: "insufficient",
    });
  });

  test("retains a conflicted answer when it has valid selected evidence", () => {
    const result = validateFinalAnswerSafety({
      question: "Which option did I choose?",
      answer: answer({ supportStatus: "conflicted" }),
      readerPlan: readerPlan({ supportStatus: "conflicted" }),
      sessions,
    });

    expect(result.forcedInsufficient).toBe(false);
    expect(result.answer.supportStatus).toBe("conflicted");
  });
});
