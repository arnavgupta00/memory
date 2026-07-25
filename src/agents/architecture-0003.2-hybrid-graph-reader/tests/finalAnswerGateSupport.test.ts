import { describe, expect, test } from "vitest";

import {
  applyGateAnswerSafety,
  buildOracleReaderPlan,
  percentile95,
  sessionsForGateCase,
  type GateDatasetCase,
} from "../src/services/finalAnswerGateSupport.js";

function answerableCase(): GateDatasetCase {
  return {
    question_id: "question-1",
    question_type: "single-session-assistant",
    question: "How many eggs were needed?",
    question_date: "2025/01/02",
    answer_session_ids: ["support"],
    haystack_dates: ["2025/01/01"],
    haystack_session_ids: ["support"],
    haystack_sessions: [[
      { role: "user", content: "How do I make an omelette?" },
      {
        role: "assistant",
        content: "Use two eggs.",
        has_answer: true,
      },
    ]],
  };
}

describe("final-answer gate support", () => {
  test("builds oracle evidence from annotations without copying the answer text", () => {
    const item = answerableCase();
    const plan = buildOracleReaderPlan(item);

    expect(plan.answerMode).toBe("assistant_answer");
    expect(plan.selectedSessions).toEqual([{
      sessionId: "support",
      turnIndexes: [1],
      purpose: "direct_answer",
    }]);
    expect(JSON.stringify(plan)).not.toContain("two eggs");
  });

  test("preserves a clean explicit abstention after final safety validation", () => {
    const item: GateDatasetCase = {
      ...answerableCase(),
      question_id: "question-1_abs",
      answer_session_ids: [],
    };
    const plan = buildOracleReaderPlan(item);
    const result = applyGateAnswerSafety({
      question: item.question,
      answer: {
        hypothesis: "The available memory does not contain that information.",
        evidence: [],
        supportStatus: "insufficient",
      },
      readerPlan: plan,
      sessions: sessionsForGateCase(item),
    });

    expect(result.explicitAbstentionAccepted).toBe(true);
    expect(result.answer.hypothesis).toContain("does not contain");
  });

  test("rejects evidence outside the reader boundary", () => {
    const item = answerableCase();
    const plan = buildOracleReaderPlan(item);
    const result = applyGateAnswerSafety({
      question: item.question,
      answer: {
        hypothesis: "Two eggs.",
        evidence: [{ sessionId: "invented", turnIndex: 0 }],
        supportStatus: "supported",
      },
      readerPlan: plan,
      sessions: sessionsForGateCase(item),
    });

    expect(result.rejectedEvidenceCount).toBe(1);
    expect(result.supportedWithoutEvidence).toBe(true);
    expect(result.answer.supportStatus).toBe("insufficient");
  });

  test("deduplicates valid citations without labeling them invalid", () => {
    const item = answerableCase();
    const plan = buildOracleReaderPlan(item);
    const result = applyGateAnswerSafety({
      question: item.question,
      answer: {
        hypothesis: "Two eggs.",
        evidence: [
          { sessionId: "support", turnIndex: 1 },
          { sessionId: "support", turnIndex: 1 },
        ],
        supportStatus: "supported",
      },
      readerPlan: plan,
      sessions: sessionsForGateCase(item),
    });

    expect(result.rejectedEvidenceCount).toBe(0);
    expect(result.duplicateEvidenceCount).toBe(1);
    expect(result.answer.evidence).toEqual([
      { sessionId: "support", turnIndex: 1 },
    ]);
  });

  test("computes the nearest-rank p95 deterministically", () => {
    expect(percentile95([])).toBe(0);
    expect(percentile95([10, 20, 30, 40, 50])).toBe(50);
    expect(percentile95(Array.from({ length: 20 }, (_, index) => index + 1)))
      .toBe(19);
  });
});
