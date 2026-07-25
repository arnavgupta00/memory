import type { DirectEvidenceExcerpt } from "./directEvidence.js";
import type { PersonalSignal } from "./personalSignals.js";

export type QuestionEvidenceExcerpt = {
  sessionId: string;
  turnIndex: number;
  sessionDate: string;
  excerpt: string;
  source: "canonical_provenance" | "unverified_signal";
  pointers: string[];
  matchedTerms: string[];
  containsTemporalCue: boolean;
  score: number;
};

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "did", "do", "does", "for", "from",
  "had", "has", "have", "how", "i", "in", "is", "it", "many", "me", "my", "of", "on",
  "or", "the", "to", "was", "were", "what", "when", "where", "which", "who", "with",
]);
const TEMPORAL_QUESTION = /\b(?:before|after|ago|when|how long|days?|weeks?|months?|years?)\b/i;
const UNSAFE_UNVERIFIED_CONTEXT = /\b(?:hypothetical|hypothetically|imagine|imagining|pretend|roleplay|role-play|fiction|fictional|write (?:a|the) story|suppose that)\b/i;

function stem(token: string): string {
  if (token.length > 5 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function terms(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
      .map(stem)
      .filter((token) => token.length > 1 && !STOP_WORDS.has(token)),
  );
}

function matches(questionTerms: Set<string>, text: string): string[] {
  const candidateTerms = terms(text);
  return [...questionTerms].filter((term) => candidateTerms.has(term)).sort();
}

function key(sessionId: string, turnIndex: number, excerpt: string): string {
  return `${sessionId}:${String(turnIndex)}:${excerpt}`;
}

export function selectQuestionEvidence(
  question: string,
  directEvidence: DirectEvidenceExcerpt[],
  highPrioritySignals: PersonalSignal[],
  limit = 12,
): QuestionEvidenceExcerpt[] {
  const questionTerms = terms(question);
  const temporalQuestion = TEMPORAL_QUESTION.test(question);
  const candidates = new Map<string, QuestionEvidenceExcerpt>();
  for (const evidence of directEvidence) {
    const textMatches = matches(questionTerms, evidence.excerpt);
    const pointerMatches = matches(questionTerms, evidence.pointers.join(" "));
    const matchedTerms = [...new Set([...textMatches, ...pointerMatches])].sort();
    if (matchedTerms.length === 0) continue;
    candidates.set(key(evidence.sessionId, evidence.turnIndex, evidence.excerpt), {
      ...evidence,
      source: "canonical_provenance",
      matchedTerms,
      score: (pointerMatches.length * 4) + (textMatches.length * 2)
        + (temporalQuestion && evidence.containsTemporalCue ? 3 : 0) + 2,
    });
  }
  for (const signal of highPrioritySignals) {
    const textMatches = matches(questionTerms, signal.text);
    if (textMatches.length < 2 || UNSAFE_UNVERIFIED_CONTEXT.test(signal.text)) continue;
    const signalKey = key(signal.sessionId, signal.turnIndex, signal.text);
    if (candidates.has(signalKey)) continue;
    const containsTemporalCue = signal.reasons.includes("time");
    candidates.set(signalKey, {
      sessionId: signal.sessionId,
      turnIndex: signal.turnIndex,
      sessionDate: signal.sessionDate,
      excerpt: signal.text,
      source: "unverified_signal",
      pointers: [],
      matchedTerms: textMatches,
      containsTemporalCue,
      score: (textMatches.length * 2) + (temporalQuestion && containsTemporalCue ? 3 : 0),
    });
  }
  return [...candidates.values()]
    .sort((left, right) => right.score - left.score
      || right.matchedTerms.length - left.matchedTerms.length
      || Number(right.source === "canonical_provenance") - Number(left.source === "canonical_provenance")
      || left.sessionDate.localeCompare(right.sessionDate)
      || left.sessionId.localeCompare(right.sessionId)
      || left.turnIndex - right.turnIndex)
    .slice(0, limit);
}
