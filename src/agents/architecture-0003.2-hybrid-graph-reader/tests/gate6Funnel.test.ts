import { describe, expect, test } from "vitest";

import {
  exposedGroup,
  funnelStage,
  GATE6_EXPOSED_CASE_IDS,
  summarizeGate6,
  type Gate6CaseFunnel,
} from "../src/services/gate6Funnel.js";

function funnel(
  questionId: string,
  correct = true,
): Gate6CaseFunnel {
  const stage = funnelStage(["reference"], ["reference"]);
  return {
    questionId,
    questionType: questionId.endsWith("0")
      ? "temporal-reasoning"
      : "single-session-user",
    group: exposedGroup(questionId),
    referenceSessionIds: ["reference"],
    graphCoverage: stage,
    graphOrCoverageFallback: stage,
    retrievalCoverage: stage,
    readerSelection: stage,
    answerEvidence: stage,
    answer: {
      hypothesis: "answer",
      nonEmpty: true,
      supportStatus: "supported",
      invalidReferenceCount: 0,
    },
    canonicalJudgment: {
      model: "gpt-4o-2024-08-06",
      correct,
    },
    integrityRecovery: null,
    replayHashMatches: true,
    artifactIssues: [],
  };
}

describe("Gate 6 funnel reporting", () => {
  test("computes support and complete reference-session coverage", () => {
    expect(funnelStage(["one", "two"], ["two", "other"])).toEqual({
      observedSessionIds: ["other", "two"],
      matchedReferenceSessionIds: ["two"],
      referenceRecall: 0.5,
      supportHit: true,
      complete: false,
    });
  });

  test("passes exactly ten correct with five in each frozen group", () => {
    const failures = new Set<string>([
      GATE6_EXPOSED_CASE_IDS[0],
      GATE6_EXPOSED_CASE_IDS[6],
    ]);
    const summary = summarizeGate6({
      funnels: GATE6_EXPOSED_CASE_IDS.map((questionId) =>
        funnel(questionId, !failures.has(questionId)),
      ),
      failureCount: 0,
      retryCount: 4,
      modelCallCount: 100,
      agentCostUsd: 0.574,
    });

    expect(summary.overall.correct).toBe(10);
    expect(summary.groups["prior-six-1"].correct).toBe(5);
    expect(summary.groups["prior-six-2"].correct).toBe(5);
    expect(summary.retryRate).toBe(0.04);
    expect(summary.verdict).toBe("passed");
  });

  test("fails when either prior group drops below five", () => {
    const failures = new Set<string>([
      GATE6_EXPOSED_CASE_IDS[0],
      GATE6_EXPOSED_CASE_IDS[1],
    ]);
    const summary = summarizeGate6({
      funnels: GATE6_EXPOSED_CASE_IDS.map((questionId) =>
        funnel(questionId, !failures.has(questionId)),
      ),
      failureCount: 0,
      retryCount: 0,
      modelCallCount: 100,
      agentCostUsd: 0.1,
    });

    expect(summary.overall.correct).toBe(10);
    expect(summary.checks.eachPriorGroup).toBe(false);
    expect(summary.verdict).toBe("failed");
  });

  test("treats the retry and cost limits as strict and inclusive respectively", () => {
    const funnels = GATE6_EXPOSED_CASE_IDS.map((questionId) =>
      funnel(questionId),
    );
    expect(
      summarizeGate6({
        funnels,
        failureCount: 0,
        retryCount: 5,
        modelCallCount: 100,
        agentCostUsd: 0.1,
      }).checks.retryRate,
    ).toBe(false);
    expect(
      summarizeGate6({
        funnels,
        failureCount: 0,
        retryCount: 0,
        modelCallCount: 100,
        agentCostUsd: 0.574001,
      }).checks.agentCost,
    ).toBe(false);
  });
});
