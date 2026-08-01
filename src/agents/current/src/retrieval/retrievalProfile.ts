export type RetrievalProfile = {
  scope: "focused" | "broad_history";
  searchTopK: number;
  poolMax: number;
  bagMax: number;
};

export const FOCUSED_RETRIEVAL_PROFILE: RetrievalProfile = {
  scope: "focused",
  searchTopK: 10,
  poolMax: 24,
  bagMax: 12,
};

/**
 * Broad-history candidates are cheap lexical hits. They are deliberately kept
 * wide here and filtered by the existing parallel per-session reader before
 * the final context package is assembled.
 */
export const BROAD_HISTORY_RETRIEVAL_PROFILE: RetrievalProfile = {
  scope: "broad_history",
  searchTopK: 50,
  poolMax: 192,
  bagMax: 192,
};

// The wide sweep is currently certified only for explicit timeline/order asks.
// General summaries need hierarchical claim reduction; a wide, shallow raw-turn
// package regressed their official BEAM score in the canary A/B.
const BROAD_HISTORY_PATTERNS = [
  /\b(?:reconstruct|build|create)\b.{0,60}\b(?:timeline|chronolog)/iu,
  /\b(?:timeline|chronological(?:ly)?)\b/iu,
  /\bin order\b/iu,
];

/**
 * Route explicit broad ordering from question language only. Benchmark labels
 * and oracle metadata are intentionally excluded so the policy transfers.
 */
export function isBroadHistoryQuestion(question: string): boolean {
  return BROAD_HISTORY_PATTERNS.some((pattern) => pattern.test(question));
}

export function retrievalProfileForQuestion(question: string): RetrievalProfile {
  return isBroadHistoryQuestion(question)
    ? BROAD_HISTORY_RETRIEVAL_PROFILE
    : FOCUSED_RETRIEVAL_PROFILE;
}

/**
 * Focused bags preserve the prior behavior. Broad-history bags use the map
 * reader as a semantic filter so lexical breadth does not consume the final
 * package with unrelated sessions.
 */
export function retainMappedSession(args: {
  question: string;
  candidateStatus: "found" | "none_found";
  claimCount: number;
}): boolean {
  return !isBroadHistoryQuestion(args.question)
    || (args.candidateStatus === "found" && args.claimCount > 0);
}
