import type { TimestampedSession } from "../types.js";
import type { SelectedSpan } from "./types.js";

export function seriesPrefix(sessionId: string): string {
  const match = /^(.*)_\d+$/.exec(sessionId);
  return match?.[1] ?? sessionId;
}

/** Full-session span for a session already known to be relevant. */
export function sessionToFullSpan(session: TimestampedSession): SelectedSpan {
  const turns = session.turns.map((turn, turnIndex) => ({
    turnIndex,
    role: turn.role,
    content: turn.content,
    truncated: false,
  }));
  const characterCount = turns.reduce(
    (total, turn) => total + turn.content.length + turn.role.length + 8,
    0,
  );
  return {
    sessionId: session.session_id,
    date: session.date,
    startTurn: 0,
    endTurn: Math.max(0, session.turns.length - 1),
    turns,
    bestRank: 0,
    bestScore: 0,
    matchedTerms: [],
    characterCount,
  };
}

/**
 * Add full-session spans for haystack sessions that share an ID series prefix
 * with any already-selected span (answer_foo_1 ↔ answer_foo_2).
 */
export function expandSeriesSiblingSpans(args: {
  sessions: TimestampedSession[];
  spans: SelectedSpan[];
  maxSessions: number;
}): SelectedSpan[] {
  if (args.maxSessions <= 0 || args.spans.length === 0) return args.spans;
  const covered = new Set(args.spans.map((span) => span.sessionId));
  const seedSeries = new Set([...covered].map((sessionId) => seriesPrefix(sessionId)));
  const extras: SelectedSpan[] = [];
  for (const session of args.sessions) {
    if (extras.length >= args.maxSessions) break;
    if (covered.has(session.session_id)) continue;
    if (!seedSeries.has(seriesPrefix(session.session_id))) continue;
    extras.push(sessionToFullSpan(session));
    covered.add(session.session_id);
  }
  if (extras.length === 0) return args.spans;
  return [...args.spans, ...extras].sort(
    (left, right) =>
      left.date.localeCompare(right.date)
      || left.sessionId.localeCompare(right.sessionId)
      || left.startTurn - right.startTurn,
  );
}
