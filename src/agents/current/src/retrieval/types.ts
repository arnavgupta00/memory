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
};

export const DEFAULT_RETRIEVAL_OPTIONS: RetrievalOptions = {
  windowTurns: 4,
  windowStride: 2,
  topK: 24,
  charBudget: 40_000,
  maxTurnChars: 4_000,
  temporalBoost: 0.15,
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
