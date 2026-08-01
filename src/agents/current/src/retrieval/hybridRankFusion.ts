export type RetrieverFamily = "sparse" | "dense";

export type SessionRanking = {
  family: RetrieverFamily;
  queryIndex: number;
  sessionIds: string[];
};

export type FamilyFusionScore = {
  sessionId: string;
  score: number;
  sparseScore: number;
  denseScore: number;
  sparseRanks: Array<{ queryIndex: number; rank: number }>;
  denseRanks: Array<{ queryIndex: number; rank: number }>;
};

/**
 * Equal-family RRF. Scores are averaged over query lanes inside each family so
 * adding more sparse views or duplicate lanes cannot numerically outvote dense.
 */
export function familyBalancedRrf(args: {
  rankings: SessionRanking[];
  queryCount: number;
  k?: number;
}): FamilyFusionScore[] {
  const k = args.k ?? 60;
  const queryCount = Math.max(args.queryCount, 1);
  const scores = new Map<string, FamilyFusionScore>();
  for (const ranking of args.rankings) {
    const uniqueIds = [...new Set(ranking.sessionIds)];
    for (let index = 0; index < uniqueIds.length; index += 1) {
      const sessionId = uniqueIds[index];
      if (!sessionId) continue;
      const rank = index + 1;
      let score = scores.get(sessionId);
      if (!score) {
        score = {
          sessionId,
          score: 0,
          sparseScore: 0,
          denseScore: 0,
          sparseRanks: [],
          denseRanks: [],
        };
        scores.set(sessionId, score);
      }
      const contribution = 1 / (k + rank) / queryCount / 2;
      if (ranking.family === "sparse") {
        score.sparseScore += contribution;
        score.sparseRanks.push({ queryIndex: ranking.queryIndex, rank });
      } else {
        score.denseScore += contribution;
        score.denseRanks.push({ queryIndex: ranking.queryIndex, rank });
      }
      score.score += contribution;
    }
  }
  return [...scores.values()].sort(
    (left, right) => right.score - left.score || left.sessionId.localeCompare(right.sessionId),
  );
}

/** Best rank across sparse views yields exactly one sparse list per query. */
export function collapseSparseViews(
  rankedViews: string[][],
): string[] {
  const best = new Map<string, { rank: number; support: number }>();
  for (const view of rankedViews) {
    for (let index = 0; index < view.length; index += 1) {
      const sessionId = view[index];
      if (!sessionId) continue;
      const current = best.get(sessionId);
      if (!current) best.set(sessionId, { rank: index + 1, support: 1 });
      else {
        current.rank = Math.min(current.rank, index + 1);
        current.support += 1;
      }
    }
  }
  return [...best.entries()]
    .sort(
      ([leftId, left], [rightId, right]) =>
        left.rank - right.rank
        || right.support - left.support
        || leftId.localeCompare(rightId),
    )
    .map(([sessionId]) => sessionId);
}
