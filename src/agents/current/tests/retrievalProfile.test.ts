import { describe, expect, it } from "vitest";

import {
  answerShapedModeForQuestion,
  BROAD_HISTORY_RETRIEVAL_PROFILE,
  FOCUSED_RETRIEVAL_PROFILE,
  isBroadHistoryQuestion,
  retainMappedSession,
  retrievalProfileForQuestion,
  shouldUseAnswerShapedRetrieval,
} from "../src/retrieval/retrievalProfile.js";

describe("retrievalProfileForQuestion", () => {
  it.each([
    "Can you reconstruct the timeline of when I first mentioned each part of the project?",
    "How did our deployment discussions evolve throughout our conversations in order?",
    "List the product decisions in chronological order.",
  ])("routes broad-history language without benchmark metadata: %s", (question) => {
    expect(isBroadHistoryQuestion(question)).toBe(true);
    expect(retrievalProfileForQuestion(question)).toEqual(BROAD_HISTORY_RETRIEVAL_PROFILE);
  });

  it.each([
    "What data type did I choose for the price column?",
    "How many days passed between March 1 and March 15?",
    "What is my current preferred tennis racket?",
    "Compare the two amounts I mentioned last week.",
    "How did my contributions evolve together to support financial balance?",
    "Give me a comprehensive summary of the product work so far.",
    "Can you summarize how my approach developed over our conversations?",
    "Give me a summary of how I planned and completed the migration.",
  ])("keeps focused questions on the original limits: %s", (question) => {
    expect(isBroadHistoryQuestion(question)).toBe(false);
    expect(retrievalProfileForQuestion(question)).toEqual(FOCUSED_RETRIEVAL_PROFILE);
  });
});

describe("answerShapedModeForQuestion", () => {
  it.each([
    ["Reconstruct the project timeline in chronological order.", "timeline"],
    ["Give me a comprehensive summary of the product work so far.", "summary"],
    ["How many days passed between March 1 and March 15?", "temporal"],
    ["Have I written any unit tests, and if so, what coverage did I achieve?", "contradiction"],
    ["Has Kristen completed a Master's degree at Istanbul University?", "contradiction"],
    ["List all the deployment approaches I mentioned.", "aggregate"],
  ] as const)("routes %s through the %s workflow", (question, mode) => {
    expect(answerShapedModeForQuestion(question)).toBe(mode);
    expect(shouldUseAnswerShapedRetrieval(question)).toBe(true);
  });

  it.each([
    "What data type did I choose for the price column?",
    "What is my current preferred tennis racket?",
    "Compare the two amounts I mentioned last week.",
    "How did my contributions evolve together to support financial balance?",
    "How long are my weekly swimming sessions?",
    "When would be a good time to start a meaningful conversation this weekend?",
  ])("keeps protected focused shapes on the existing planner: %s", (question) => {
    expect(answerShapedModeForQuestion(question)).toBeNull();
    expect(shouldUseAnswerShapedRetrieval(question)).toBe(false);
  });
});

describe("retainMappedSession", () => {
  const broadQuestion = "Reconstruct the project timeline in chronological order.";

  it("drops broad lexical candidates that the map reader found irrelevant", () => {
    expect(retainMappedSession({
      question: broadQuestion,
      candidateStatus: "none_found",
      claimCount: 0,
    })).toBe(false);
    expect(retainMappedSession({
      question: broadQuestion,
      candidateStatus: "found",
      claimCount: 2,
    })).toBe(true);
  });

  it("preserves the focused-reader behavior", () => {
    expect(retainMappedSession({
      question: "What guitar did I buy?",
      candidateStatus: "none_found",
      claimCount: 0,
    })).toBe(true);
  });
});
