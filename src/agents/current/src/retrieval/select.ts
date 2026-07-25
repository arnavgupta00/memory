import type { TimestampedSession } from "../types.js";
import type {
  Bm25SearchResult,
  SelectedSpan,
  SelectedTurn,
  TurnWindow,
} from "./types.js";

type RankedWindow = {
  window: TurnWindow;
  result: Bm25SearchResult;
};

function truncateContent(content: string, maxTurnChars: number): SelectedTurn["content"] {
  if (content.length <= maxTurnChars) return content;
  return `${content.slice(0, maxTurnChars)}…`;
}

function spanCharacterCount(turns: SelectedTurn[]): number {
  return turns.reduce((total, turn) => total + turn.content.length + turn.role.length + 8, 0);
}

function mergeIntervals(
  intervals: Array<{ start: number; end: number; ranks: number[]; scores: number[]; terms: string[] }>,
): Array<{ start: number; end: number; ranks: number[]; scores: number[]; terms: string[] }> {
  const sorted = [...intervals].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: typeof sorted = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (!previous || interval.start > previous.end + 1) {
      merged.push({
        start: interval.start,
        end: interval.end,
        ranks: [...interval.ranks],
        scores: [...interval.scores],
        terms: [...interval.terms],
      });
      continue;
    }
    previous.end = Math.max(previous.end, interval.end);
    previous.ranks.push(...interval.ranks);
    previous.scores.push(...interval.scores);
    previous.terms.push(...interval.terms);
  }
  return merged;
}

export function selectSpans(args: {
  sessions: TimestampedSession[];
  windows: TurnWindow[];
  ranked: Bm25SearchResult[];
  charBudget: number;
  maxTurnChars: number;
}): SelectedSpan[] {
  if (!Number.isInteger(args.charBudget) || args.charBudget < 0) {
    throw new Error("charBudget must be a nonnegative integer");
  }
  if (!Number.isInteger(args.maxTurnChars) || args.maxTurnChars < 1) {
    throw new Error("maxTurnChars must be a positive integer");
  }

  const windowById = new Map(args.windows.map((window) => [window.document.id, window]));
  const sessionById = new Map(args.sessions.map((session) => [session.session_id, session]));
  const rankedWindows: RankedWindow[] = [];
  for (const result of args.ranked) {
    const window = windowById.get(result.documentId);
    if (!window) throw new Error(`unknown ranked window: ${result.documentId}`);
    rankedWindows.push({ window, result });
  }

  const bySession = new Map<string, RankedWindow[]>();
  for (const item of rankedWindows) {
    const list = bySession.get(item.window.document.sessionId) ?? [];
    list.push(item);
    bySession.set(item.window.document.sessionId, list);
  }

  const candidateSpans: SelectedSpan[] = [];
  for (const [sessionId, items] of bySession) {
    const session = sessionById.get(sessionId);
    if (!session) throw new Error(`unknown session: ${sessionId}`);
    const intervals = mergeIntervals(
      items.map((item) => ({
        start: item.window.document.startTurn,
        end: item.window.document.endTurn,
        ranks: [item.result.rank],
        scores: [item.result.score],
        terms: item.result.matchedTerms,
      })),
    );
    for (const interval of intervals) {
      const turns: SelectedTurn[] = [];
      for (let turnIndex = interval.start; turnIndex <= interval.end; turnIndex += 1) {
        const turn = session.turns[turnIndex];
        if (!turn) throw new Error(`missing turn ${String(turnIndex)} in session ${sessionId}`);
        const truncated = turn.content.length > args.maxTurnChars;
        turns.push({
          turnIndex,
          role: turn.role,
          content: truncateContent(turn.content, args.maxTurnChars),
          truncated,
        });
      }
      candidateSpans.push({
        sessionId,
        date: session.date,
        startTurn: interval.start,
        endTurn: interval.end,
        turns,
        bestRank: Math.min(...interval.ranks),
        bestScore: Math.max(...interval.scores),
        matchedTerms: [...new Set(interval.terms)].sort((left, right) => left.localeCompare(right)),
        characterCount: spanCharacterCount(turns),
      });
    }
  }

  candidateSpans.sort(
    (left, right) =>
      left.bestRank - right.bestRank ||
      right.bestScore - left.bestScore ||
      left.sessionId.localeCompare(right.sessionId) ||
      left.startTurn - right.startTurn,
  );

  const selected: SelectedSpan[] = [];
  let used = 0;
  for (const span of candidateSpans) {
    if (selected.length === 0) {
      selected.push(span);
      used += span.characterCount;
      continue;
    }
    if (used + span.characterCount > args.charBudget) continue;
    selected.push(span);
    used += span.characterCount;
  }

  return selected.sort(
    (left, right) =>
      left.date.localeCompare(right.date) ||
      left.sessionId.localeCompare(right.sessionId) ||
      left.startTurn - right.startTurn,
  );
}

export function estimatePromptTokens(characterCount: number): number {
  return Math.ceil(characterCount / 4);
}
