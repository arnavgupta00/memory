export type RetrievalProfile = {
  scope: "focused" | "broad_history";
  searchTopK: number;
  poolMax: number;
  bagMax: number;
};

export type AnswerShapedMode =
  | "timeline"
  | "summary"
  | "temporal"
  | "contradiction"
  | "aggregate";

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

const ANSWER_SHAPED_PATTERNS: Array<{
  mode: Exclude<AnswerShapedMode, "timeline">;
  patterns: RegExp[];
}> = [
  {
    mode: "summary",
    patterns: [
      /\b(?:summarize|summary|overview|recap)\b/iu,
      /\b(?:comprehensive|complete|overall)\b.{0,40}\b(?:history|journey|story|developments?|discussions?)\b/iu,
      /\b(?:history|journey|story)\b.{0,40}\b(?:so far|over time|throughout)\b/iu,
    ],
  },
  {
    mode: "temporal",
    patterns: [
      /\bhow many (?:days?|weeks?|months?|years?)\b.{0,100}\b(?:between|after|before|from)\b/iu,
      /\bhow long\b.{0,80}\b(?:between|from|until|before|after)\b/iu,
      /\b(?:elapsed|duration|time span|date range|interval)\b/iu,
      /\bwhich happened first\b/iu,
    ],
  },
  {
    mode: "contradiction",
    patterns: [
      /\b(?:contradict\w*|conflict\w*|inconsisten\w*|disagree\w*)\b/iu,
      /\bwhich (?:statement|version|claim) (?:is|was) (?:correct|right|current)\b/iu,
      /^\s*(?:have|has)\b/iu,
      /\bhave I\b.{0,100}\band if so\b/iu,
      /\bdid I\b.{0,100}\bor (?:did|was|were) I\b/iu,
    ],
  },
  {
    mode: "aggregate",
    patterns: [
      /\b(?:list|name|identify|enumerate) (?:all|every|each)\b/iu,
      /\bwhat (?:are|were) all (?:the )?\b/iu,
      /\b(?:each|every)\b.{0,50}\b(?:mentioned|discussed|described|used|tried|completed)\b/iu,
    ],
  },
];

/**
 * Route only question shapes that require complementary or coverage-complete
 * evidence through the more expensive answer-shaped planning workflow. The
 * decision uses question text alone: no benchmark labels or oracle metadata.
 */
export function answerShapedModeForQuestion(question: string): AnswerShapedMode | null {
  if (isBroadHistoryQuestion(question)) return "timeline";
  for (const candidate of ANSWER_SHAPED_PATTERNS) {
    if (candidate.patterns.some((pattern) => pattern.test(question))) return candidate.mode;
  }
  return null;
}

export function shouldUseAnswerShapedRetrieval(question: string): boolean {
  return answerShapedModeForQuestion(question) !== null;
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
