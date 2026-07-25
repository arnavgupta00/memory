export const GATE6_EXPOSED_GROUP_1 = [
  "e47becba",
  "db467c8c",
  "a11281a2",
  "c8090214",
  "71315a70",
  "gpt4_1e4a8aeb",
] as const;

export const GATE6_EXPOSED_GROUP_2 = [
  "945e3d21",
  "73d42213",
  "e8a79c70",
  "195a1a1b",
  "8ebdbe50",
  "9a707b81",
] as const;

export const GATE6_EXPOSED_CASE_IDS = [
  ...GATE6_EXPOSED_GROUP_1,
  ...GATE6_EXPOSED_GROUP_2,
] as const;

export type FunnelStage = {
  observedSessionIds: string[];
  matchedReferenceSessionIds: string[];
  referenceRecall: number;
  supportHit: boolean;
  complete: boolean;
};

export type Gate6CaseFunnel = {
  questionId: string;
  questionType: string;
  group: "prior-six-1" | "prior-six-2";
  referenceSessionIds: string[];
  graphCoverage: FunnelStage;
  graphOrCoverageFallback: FunnelStage;
  retrievalCoverage: FunnelStage;
  readerSelection: FunnelStage;
  answerEvidence: FunnelStage;
  answer: {
    hypothesis: string;
    nonEmpty: boolean;
    supportStatus: string | null;
    invalidReferenceCount: number;
  };
  canonicalJudgment: {
    model: "gpt-4o-2024-08-06";
    correct: boolean;
  };
  integrityRecovery: {
    gateId: string;
    originalSnapshotSha256: string;
    originalSnapshotSchemaValid: boolean;
    originalSnapshotSchemaErrors: Array<{
      code: string;
      path: string;
      message: string;
    }>;
    replayGraphHash: string;
    predictionGraphHash: string;
    recoveredGraphHash: string;
    proofComplete: true;
  } | null;
  replayHashMatches: boolean;
  artifactIssues: string[];
};

export type Gate6Summary = {
  overall: { correct: number; count: number; accuracy: number };
  groups: Record<
    "prior-six-1" | "prior-six-2",
    { correct: number; count: number; accuracy: number }
  >;
  perQuestionType: Record<
    string,
    { correct: number; count: number; accuracy: number }
  >;
  replayMismatchCount: number;
  artifactIssueCount: number;
  failureCount: number;
  retryCount: number;
  modelCallCount: number;
  retryRate: number;
  agentCostUsd: number;
  checks: {
    overallAccuracy: boolean;
    eachPriorGroup: boolean;
    noQuestionTypeScoresZero: boolean;
    zeroFailures: boolean;
    zeroReplayMismatches: boolean;
    zeroArtifactIssues: boolean;
    retryRate: boolean;
    agentCost: boolean;
  };
  verdict: "passed" | "failed";
};

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function funnelStage(
  referenceSessionIds: readonly string[],
  observedSessionIds: readonly string[],
): FunnelStage {
  const reference = unique(referenceSessionIds);
  const observed = unique(observedSessionIds);
  const observedSet = new Set(observed);
  const matchedReferenceSessionIds = reference.filter((sessionId) =>
    observedSet.has(sessionId),
  );
  return {
    observedSessionIds: observed,
    matchedReferenceSessionIds,
    referenceRecall:
      reference.length === 0
        ? 1
        : matchedReferenceSessionIds.length / reference.length,
    supportHit:
      reference.length === 0 || matchedReferenceSessionIds.length > 0,
    complete: matchedReferenceSessionIds.length === reference.length,
  };
}

export function exposedGroup(
  questionId: string,
): "prior-six-1" | "prior-six-2" {
  if (
    (GATE6_EXPOSED_GROUP_1 as readonly string[]).includes(questionId)
  ) {
    return "prior-six-1";
  }
  if (
    (GATE6_EXPOSED_GROUP_2 as readonly string[]).includes(questionId)
  ) {
    return "prior-six-2";
  }
  throw new Error(`question is outside the frozen Gate 6 cohorts: ${questionId}`);
}

function accuracy(correct: number, count: number): number {
  return count === 0 ? 0 : correct / count;
}

export function summarizeGate6(args: {
  funnels: readonly Gate6CaseFunnel[];
  failureCount: number;
  retryCount: number;
  modelCallCount: number;
  agentCostUsd: number;
  globalArtifactIssueCount?: number;
}): Gate6Summary {
  const overallCorrect = args.funnels.filter(
    (item) => item.canonicalJudgment.correct,
  ).length;
  const groups: Gate6Summary["groups"] = {
    "prior-six-1": { correct: 0, count: 0, accuracy: 0 },
    "prior-six-2": { correct: 0, count: 0, accuracy: 0 },
  };
  const byType = new Map<string, boolean[]>();
  for (const funnel of args.funnels) {
    const group = groups[funnel.group];
    group.count += 1;
    if (funnel.canonicalJudgment.correct) group.correct += 1;
    const typeLabels = byType.get(funnel.questionType) ?? [];
    typeLabels.push(funnel.canonicalJudgment.correct);
    byType.set(funnel.questionType, typeLabels);
  }
  groups["prior-six-1"].accuracy = accuracy(
    groups["prior-six-1"].correct,
    groups["prior-six-1"].count,
  );
  groups["prior-six-2"].accuracy = accuracy(
    groups["prior-six-2"].correct,
    groups["prior-six-2"].count,
  );
  const perQuestionType: Gate6Summary["perQuestionType"] = {};
  for (const [questionType, labels] of [...byType].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const correct = labels.filter(Boolean).length;
    perQuestionType[questionType] = {
      correct,
      count: labels.length,
      accuracy: accuracy(correct, labels.length),
    };
  }
  const replayMismatchCount = args.funnels.filter(
    (item) => !item.replayHashMatches,
  ).length;
  const artifactIssueCount =
    (args.globalArtifactIssueCount ?? 0)
    + args.funnels.reduce(
      (total, item) => total + item.artifactIssues.length,
      0,
    );
  const retryRate =
    args.modelCallCount === 0 ? 1 : args.retryCount / args.modelCallCount;
  const checks = {
    overallAccuracy: overallCorrect >= 10 && args.funnels.length === 12,
    eachPriorGroup:
      groups["prior-six-1"].correct >= 5
      && groups["prior-six-1"].count === 6
      && groups["prior-six-2"].correct >= 5
      && groups["prior-six-2"].count === 6,
    noQuestionTypeScoresZero:
      Object.values(perQuestionType).length > 0
      && Object.values(perQuestionType).every((item) => item.correct > 0),
    zeroFailures: args.failureCount === 0,
    zeroReplayMismatches: replayMismatchCount === 0,
    zeroArtifactIssues: artifactIssueCount === 0,
    retryRate: retryRate < 0.05,
    agentCost: args.agentCostUsd <= 0.574,
  };
  return {
    overall: {
      correct: overallCorrect,
      count: args.funnels.length,
      accuracy: accuracy(overallCorrect, args.funnels.length),
    },
    groups,
    perQuestionType,
    replayMismatchCount,
    artifactIssueCount,
    failureCount: args.failureCount,
    retryCount: args.retryCount,
    modelCallCount: args.modelCallCount,
    retryRate,
    agentCostUsd: args.agentCostUsd,
    checks,
    verdict: Object.values(checks).every(Boolean) ? "passed" : "failed",
  };
}
