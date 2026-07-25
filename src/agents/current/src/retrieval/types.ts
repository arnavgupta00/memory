import { z } from "zod";

import type {
  GraphMutationRecord,
  MasterContextGraph,
  SessionSummaryRecord,
  TimestampedSession,
} from "../types.js";
import {
  SessionSummaryRecordSchema,
  TimestampedSessionSchema,
} from "../types.js";

export type RetrievalDocumentChannel =
  | "session"
  | "graph_cell"
  | "summary"
  | "coverage_fallback"
  | "tail";

export type RetrievalDocument = {
  id: string;
  channel: RetrievalDocumentChannel;
  text: string;
  sessionIds: string[];
  date: string | null;
};

export type Bm25SearchResult = {
  documentId: string;
  score: number;
  bm25Score: number;
  temporalBoost: number;
  matchedTerms: string[];
  rank: number;
};

export type SessionRetrievalCandidate = Bm25SearchResult & {
  session: TimestampedSession;
};

export type GraphCellRetrievalCandidate = Bm25SearchResult & {
  pointer: string;
  value: string;
  sessionIds: string[];
};

export type SummaryRetrievalCandidate = Bm25SearchResult & {
  summary: SessionSummaryRecord;
};

export type CoverageFallbackRetrievalCandidate = Bm25SearchResult & {
  signalId: string;
  sessionId: string;
  turnIndex: number;
  text: string;
};

export type TailRetrievalCandidate = Bm25SearchResult & {
  session: TimestampedSession;
};

export type RetrievalIndexManifest = {
  schemaVersion: 1;
  algorithm: "bm25";
  parameters: {
    k1: 1.2;
    b: 0.75;
    temporalBoost: number;
  };
  documentCounts: Record<RetrievalDocumentChannel, number>;
  sessionCount: number;
  graphRevision: number;
  graphTrackedCount: number;
  summaryTrackedCount: number;
};

export type RetrievalCandidates = {
  schemaVersion: 1;
  question: string;
  questionDate: string;
  sessions: SessionRetrievalCandidate[];
  graphCells: GraphCellRetrievalCandidate[];
  summaries: SummaryRetrievalCandidate[];
  coverageFallbackSessions: CoverageFallbackRetrievalCandidate[];
  tailSessions: TailRetrievalCandidate[];
};

export type RetrievalInput = {
  question: string;
  questionDate: string;
  sessions: TimestampedSession[];
  graph: MasterContextGraph;
  summaries: SessionSummaryRecord[];
  mutationRecords: GraphMutationRecord[];
  graphTrackedCount: number;
  summaryTrackedCount: number;
};

export type RetrievalOutput = {
  manifest: RetrievalIndexManifest;
  candidates: RetrievalCandidates;
};

export const Bm25SearchResultSchema = z.strictObject({
  documentId: z.string().min(1),
  score: z.number().nonnegative(),
  bm25Score: z.number().nonnegative(),
  temporalBoost: z.number().nonnegative(),
  matchedTerms: z.array(z.string()),
  rank: z.number().int().positive(),
});

export const RetrievalIndexManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  algorithm: z.literal("bm25"),
  parameters: z.strictObject({
    k1: z.literal(1.2),
    b: z.literal(0.75),
    temporalBoost: z.number().nonnegative(),
  }),
  documentCounts: z.strictObject({
    session: z.number().int().nonnegative(),
    graph_cell: z.number().int().nonnegative(),
    summary: z.number().int().nonnegative(),
    coverage_fallback: z.number().int().nonnegative(),
    tail: z.number().int().nonnegative(),
  }),
  sessionCount: z.number().int().nonnegative(),
  graphRevision: z.number().int().nonnegative(),
  graphTrackedCount: z.number().int().nonnegative(),
  summaryTrackedCount: z.number().int().nonnegative(),
});

export const RetrievalCandidatesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  question: z.string(),
  questionDate: z.string(),
  sessions: z.array(Bm25SearchResultSchema.extend({
    session: TimestampedSessionSchema,
  })).max(12),
  graphCells: z.array(Bm25SearchResultSchema.extend({
    pointer: z.string().startsWith("/context/"),
    value: z.string(),
    sessionIds: z.array(z.string()),
  })).max(12),
  summaries: z.array(Bm25SearchResultSchema.extend({
    summary: SessionSummaryRecordSchema,
  })).max(4),
  coverageFallbackSessions: z.array(Bm25SearchResultSchema.extend({
    signalId: z.string().min(1),
    sessionId: z.string().min(1),
    turnIndex: z.number().int().nonnegative(),
    text: z.string(),
  })).max(4),
  tailSessions: z.array(Bm25SearchResultSchema.extend({
    session: TimestampedSessionSchema,
  })),
});
