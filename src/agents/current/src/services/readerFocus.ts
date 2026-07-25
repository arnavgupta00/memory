import { Bm25Index } from "../retrieval/bm25.js";
import type {
  RetrievalCandidates,
  RetrievalDocument,
  SessionRetrievalCandidate,
  TailRetrievalCandidate,
} from "../retrieval/types.js";
import type { TimestampedSession } from "../types.js";

// Retrieval contributes at most 12 ranked sessions plus the unprocessed tail.
// Keep both channels visible: tail evidence must not disappear merely because
// the ranked session channel is already full.
const MAX_FOCUS_SESSIONS = 21;
// Preserve room for two independently ranked conversation windows plus one
// immediately following pair. The follow-up channel must not displace a second
// fact needed for comparison or multi-session reasoning.
const MAX_FOCUS_TURNS_PER_SESSION = 6;
const QUANTITATIVE_QUESTION =
  /\b(?:how many|how much|how long|what time|when|increase|decrease|difference|duration|total)\b/iu;
const QUANTITATIVE_VALUE =
  /\b(?:\d+(?:[.:/-]\d+)*|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|hundred|thousand)\b/iu;
const QUANTITATIVE_WINDOW_BOOST = 3;

export type ReaderFocusTurn = {
  sessionId: string;
  date: string;
  turnIndex: number;
  role: "user" | "assistant";
  content: string;
  retrievalRank: number;
};

type FocusSession = {
  session: TimestampedSession;
  retrievalRank: number;
};

type TurnLocator = {
  sessionIndex: number;
  turnIndexes: number[];
};

function uniqueFocusSessions(candidates: RetrievalCandidates): FocusSession[] {
  const seen = new Set<string>();
  const focused: FocusSession[] = [];
  const addCandidate = (
    candidate: SessionRetrievalCandidate | TailRetrievalCandidate,
  ): void => {
    const sessionId = candidate.session.session_id;
    if (seen.has(sessionId) || focused.length >= MAX_FOCUS_SESSIONS) return;
    seen.add(sessionId);
    focused.push({
      session: candidate.session,
      retrievalRank: candidate.rank,
    });
  };
  for (const candidate of candidates.sessions) addCandidate(candidate);
  for (const candidate of candidates.tailSessions) addCandidate(candidate);
  return focused;
}

function turnDocuments(
  sessions: FocusSession[],
): { documents: RetrievalDocument[]; locators: Map<string, TurnLocator> } {
  const documents: RetrievalDocument[] = [];
  const locators = new Map<string, TurnLocator>();
  sessions.forEach((candidate, sessionIndex) => {
    const windows: number[][] = [];
    for (let turnIndex = 0; turnIndex < candidate.session.turns.length;) {
      const turn = candidate.session.turns[turnIndex];
      const next = candidate.session.turns[turnIndex + 1];
      if (turn?.role === "user" && next?.role === "assistant") {
        windows.push([turnIndex, turnIndex + 1]);
        turnIndex += 2;
      } else {
        windows.push([turnIndex]);
        turnIndex += 1;
      }
    }
    windows.forEach((turnIndexes, windowIndex) => {
      const id = `reader-focus:${sessionIndex}:${windowIndex}`;
      documents.push({
        id,
        channel: "session",
        text: turnIndexes
          .map((turnIndex) => candidate.session.turns[turnIndex]?.content ?? "")
          .join("\n"),
        sessionIds: [candidate.session.session_id],
        date: candidate.session.date,
      });
      locators.set(id, { sessionIndex, turnIndexes });
    });
  });
  return { documents, locators };
}

function selectSessionTurnIndexes(
  session: TimestampedSession,
  rankedWindows: number[][],
): number[] {
  const selected = new Set<number>();
  const add = (turnIndex: number): void => {
    if (
      selected.size < MAX_FOCUS_TURNS_PER_SESSION
      && turnIndex >= 0
      && turnIndex < session.turns.length
    ) {
      selected.add(turnIndex);
    }
  };
  const addWindow = (turnIndexes: number[]): boolean => {
    const sizeBefore = selected.size;
    for (const turnIndex of turnIndexes) add(turnIndex);
    return selected.size > sizeBefore;
  };
  const followingConversationPair = (
    turnIndexes: number[],
  ): [number, number] | null => {
    if (turnIndexes.length !== 2) return null;
    const userIndex = turnIndexes[0];
    const assistantIndex = turnIndexes[1];
    if (
      userIndex === undefined
      || assistantIndex !== userIndex + 1
      || session.turns[userIndex]?.role !== "user"
      || session.turns[assistantIndex]?.role !== "assistant"
    ) {
      return null;
    }
    const nextUserIndex = assistantIndex + 1;
    const nextAssistantIndex = assistantIndex + 2;
    if (
      session.turns[nextUserIndex]?.role !== "user"
      || session.turns[nextAssistantIndex]?.role !== "assistant"
    ) {
      return null;
    }
    return [nextUserIndex, nextAssistantIndex];
  };
  const windows = rankedWindows.length > 0 ? rankedWindows : [[0, 1]];
  for (const turnIndexes of windows) {
    if (selected.size >= MAX_FOCUS_TURNS_PER_SESSION) break;
    const selectedRankedWindow = addWindow(turnIndexes);
    if (!selectedRankedWindow) continue;
    const followingPair = followingConversationPair(turnIndexes);
    if (
      followingPair !== null
      && selected.size + followingPair.filter((turnIndex) => !selected.has(turnIndex)).length
        <= MAX_FOCUS_TURNS_PER_SESSION
    ) {
      addWindow(followingPair);
    }
  }
  return [...selected].sort((left, right) => left - right);
}

export function focusReaderTurns(
  question: string,
  candidates: RetrievalCandidates,
): ReaderFocusTurn[] {
  const sessions = uniqueFocusSessions(candidates);
  const { documents, locators } = turnDocuments(sessions);
  const rankedBySession = new Map<number, number[][]>();
  if (documents.length > 0) {
    const documentById = new Map(
      documents.map((document) => [document.id, document]),
    );
    const quantitative = QUANTITATIVE_QUESTION.test(question);
    const results = new Bm25Index(documents)
      .search(question, documents.length)
      .sort((left, right) => {
        const leftText = documentById.get(left.documentId)?.text ?? "";
        const rightText = documentById.get(right.documentId)?.text ?? "";
        const leftScore =
          left.score
          + (quantitative && QUANTITATIVE_VALUE.test(leftText)
            ? QUANTITATIVE_WINDOW_BOOST
            : 0);
        const rightScore =
          right.score
          + (quantitative && QUANTITATIVE_VALUE.test(rightText)
            ? QUANTITATIVE_WINDOW_BOOST
            : 0);
        return (
          rightScore - leftScore
          || left.documentId.localeCompare(right.documentId)
        );
      });
    for (const result of results) {
      const locator = locators.get(result.documentId);
      if (locator === undefined) continue;
      const ranked = rankedBySession.get(locator.sessionIndex) ?? [];
      ranked.push(locator.turnIndexes);
      rankedBySession.set(locator.sessionIndex, ranked);
    }
  }
  const excerpts: ReaderFocusTurn[] = [];
  sessions.forEach((candidate, sessionIndex) => {
    const turnIndexes = selectSessionTurnIndexes(
      candidate.session,
      rankedBySession.get(sessionIndex) ?? [],
    );
    for (const turnIndex of turnIndexes) {
      const turn = candidate.session.turns[turnIndex];
      if (turn === undefined) continue;
      excerpts.push({
        sessionId: candidate.session.session_id,
        date: candidate.session.date,
        turnIndex,
        role: turn.role,
        content: turn.content,
        retrievalRank: candidate.retrievalRank,
      });
    }
  });
  return excerpts;
}
