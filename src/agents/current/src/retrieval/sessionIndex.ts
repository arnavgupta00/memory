import type { TimestampedSession } from "../types.js";

export type SessionIndexEntry = {
  sessionId: string;
  date: string;
  opener: string;
  terms: string[];
};

export type SessionIndexOptions = {
  openerChars?: number;
  topTerms?: number;
};

const DEFAULT_OPENER_CHARS = 160;
const DEFAULT_TOP_TERMS = 8;

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "in", "on", "for", "to", "was", "were",
  "is", "are", "i", "my", "me", "we", "you", "that", "this", "with", "from",
  "at", "by", "as", "be", "been", "have", "has", "had", "it", "its", "over",
  "past", "before", "after", "which", "what", "how", "many", "did", "do",
  "most", "based", "user", "stated", "none", "than", "then", "into", "about",
  "just", "only", "also", "not", "any", "all", "can", "could", "would",
  "should", "will", "within",
]);

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (match.length < 3 || STOPWORDS.has(match)) continue;
    out.add(match);
  }
  return out;
}

function firstUserOpener(session: TimestampedSession, openerChars: number): string {
  for (const turn of session.turns) {
    if (turn.role !== "user") continue;
    const text = turn.content.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (text.length <= openerChars) return text;
    return `${text.slice(0, openerChars)}…`;
  }
  return "(no user turn)";
}

function sessionTokenCounts(session: TimestampedSession): Map<string, number> {
  const counts = new Map<string, number>();
  for (const turn of session.turns) {
    if (turn.role !== "user") continue;
    for (const token of tokenize(turn.content)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Deterministic per-case session index: id, date, opener, top tf-idf terms.
 * No write-time model calls — computed from the haystack alone.
 */
export function buildSessionIndex(
  sessions: TimestampedSession[],
  options: SessionIndexOptions = {},
): SessionIndexEntry[] {
  const openerChars = options.openerChars ?? DEFAULT_OPENER_CHARS;
  const topTerms = options.topTerms ?? DEFAULT_TOP_TERMS;
  const docs = sessions.map((session) => ({
    session,
    counts: sessionTokenCounts(session),
  }));
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const token of doc.counts.keys()) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }
  const n = Math.max(1, docs.length);
  return docs.map(({ session, counts }) => {
    const scored = [...counts.entries()].map(([token, tf]) => {
      const idf = Math.log((n + 1) / ((df.get(token) ?? 0) + 1)) + 1;
      return { token, score: tf * idf };
    });
    scored.sort(
      (left, right) =>
        right.score - left.score || left.token.localeCompare(right.token),
    );
    return {
      sessionId: session.session_id,
      date: session.date,
      opener: firstUserOpener(session, openerChars),
      terms: scored.slice(0, topTerms).map((row) => row.token),
    };
  });
}

/** Serialize the index for the select prompt fill-in. */
export function formatSessionIndex(entries: SessionIndexEntry[]): string {
  if (entries.length === 0) return "(no sessions)";
  return entries
    .map((entry) => {
      const terms = entry.terms.length > 0 ? entry.terms.join(", ") : "n/a";
      return (
        `- sessionId=${entry.sessionId} | date ${entry.date}`
        + `\n  opener: ${entry.opener}`
        + `\n  terms: ${terms}`
      );
    })
    .join("\n");
}
