import { describe, expect, it } from "vitest";

import {
  BROAD_HISTORY_RETRIEVAL_PROFILE,
  FOCUSED_RETRIEVAL_PROFILE,
  isBroadHistoryQuestion,
  retainMappedSession,
  retrievalProfileForQuestion,
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
