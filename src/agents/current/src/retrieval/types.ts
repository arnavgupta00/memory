import type { TimestampedSession, Turn } from "../types.js";

export type RetrievalDocument = {
  id: string;
  text: string;
  sessionId: string;
  date: string;
  startTurn: number;
  endTurn: number;
};

export type Bm25SearchResult = {
  documentId: string;
  score: number;
  bm25Score: number;
  temporalBoost: number;
  matchedTerms: string[];
  rank: number;
};

export type TurnWindow = {
  document: RetrievalDocument;
  turns: Turn[];
};

export type SelectedTurn = {
  turnIndex: number;
  role: Turn["role"];
  content: string;
  truncated: boolean;
};

export type SelectedSpan = {
  sessionId: string;
  date: string;
  startTurn: number;
  endTurn: number;
  turns: SelectedTurn[];
  bestRank: number;
  bestScore: number;
  matchedTerms: string[];
  characterCount: number;
};

export type RetrievalOptions = {
  windowTurns: number;
  windowStride: number;
  topK: number;
  charBudget: number;
  maxTurnChars: number;
  temporalBoost: number;
  /**
   * When true, BM25 indexes only user-turn text inside each window (assistant
   * turns remain in the span for packaging). Phase-1 winner on canary-1.
   * Defaults to true via DEFAULT_RETRIEVAL_OPTIONS / resolveRetrievalOptions.
   */
  indexUserTurnsOnly?: boolean;
  /** Optional session_id -> expansion text appended to every window of that session. */
  expansionBySessionId?: Record<string, string>;
  /**
   * Optional session_id -> turn_index -> expansion text for turn-anchored facts.
   * Appended only to windows that contain that turn.
   */
  expansionBySessionTurn?: Record<string, Record<string, string>>;
};

export const DEFAULT_RETRIEVAL_OPTIONS: RetrievalOptions = {
  windowTurns: 4,
  windowStride: 2,
  topK: 24,
  charBudget: 40_000,
  maxTurnChars: 4_000,
  temporalBoost: 0.15,
  indexUserTurnsOnly: true,
};

export type RetrievalInput = {
  question: string;
  questionDate: string;
  sessions: TimestampedSession[];
  options?: Partial<RetrievalOptions>;
};

export type RetrievalResult = {
  windows: TurnWindow[];
  ranked: Bm25SearchResult[];
  spans: SelectedSpan[];
  characterCount: number;
  estimatedTokens: number;
  options: RetrievalOptions;
};
