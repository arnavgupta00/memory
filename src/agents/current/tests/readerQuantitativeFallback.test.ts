import { describe, expect, test } from "vitest";

import type { ReaderFocusTurn } from "../src/services/readerFocus.js";
import { recoverQuantitativeReaderPlan } from "../src/services/readerQuantitativeFallback.js";
import type { ReaderPlan } from "../src/types.js";

const abstain: ReaderPlan = {
  supportStatus: "insufficient",
  answerMode: "abstain",
  selectedSessions: [],
  selectedGraphPointers: [],
  evidenceFacts: [],
  conflicts: [],
};

function turn(
  sessionId: string,
  retrievalRank: number,
  content: string,
): ReaderFocusTurn {
  return {
    sessionId,
    date: "2025/01/01",
    turnIndex: 0,
    role: "user",
    content,
    retrievalRank,
  };
}

describe("quantitative reader fallback", () => {
  test("never reverses an explicit insufficiency decision from numeric distractors", () => {
    const result = recoverQuantitativeReaderPlan({
      question: "How long have I lived in my current apartment in Shinjuku?",
      plan: abstain,
      focusTurns: [
        turn(
          "travel",
          1,
          "A bus from the Shinjuku terminal takes around 3-4 hours.",
        ),
        turn("grammar", 2, "Choose option 1 or option 2."),
      ],
    });

    expect(result).toEqual({
      plan: abstain,
      applied: false,
      sourceSessionIds: [],
    });
  });

  test("leaves real quantitative operands for the Reader rather than inventing a plan", () => {
    const result = recoverQuantitativeReaderPlan({
      question: "What time did I reach the clinic on Monday?",
      plan: abstain,
      focusTurns: [
        turn("duration", 1, "It took me two hours to get to the clinic."),
        turn("departure", 2, "I left home at 7 AM on Monday."),
      ],
    });

    expect(result).toEqual({
      plan: abstain,
      applied: false,
      sourceSessionIds: [],
    });
  });

  test("preserves an already sufficient Reader plan unchanged", () => {
    const sufficient: ReaderPlan = {
      supportStatus: "sufficient",
      answerMode: "direct",
      selectedSessions: [{
        sessionId: "supported",
        turnIndexes: [0],
        purpose: "direct_answer",
      }],
      selectedGraphPointers: [],
      evidenceFacts: [{
        statement: "The supported value is three.",
        sessionIds: ["supported"],
        graphPointers: [],
      }],
      conflicts: [],
    };
    const result = recoverQuantitativeReaderPlan({
      question: "What is the supported value?",
      plan: sufficient,
      focusTurns: [turn("supported", 1, "The supported value is three.")],
    });

    expect(result).toEqual({
      plan: sufficient,
      applied: false,
      sourceSessionIds: [],
    });
  });
});
