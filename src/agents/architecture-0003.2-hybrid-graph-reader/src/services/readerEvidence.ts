import type { RetrievalCandidates } from "../retrieval/types.js";
import type { JsonValue } from "../types.js";
import {
  focusReaderTurns,
  type ReaderFocusTurn,
} from "./readerFocus.js";

export const READER_EVIDENCE_BYTE_BUDGET = 360_000;

export type ReaderPromptEvidence = {
  sessionCandidates: string;
  graphCandidates: string;
  summaryCandidates: string;
  coverageFallbackCandidates: string;
  tailCandidates: string;
  focusTurns: ReaderFocusTurn[];
  includedBytes: number;
  omittedItems: string[];
};

type PackedItem = {
  channel: "session" | "graph" | "summary" | "fallback" | "tail";
  id: string;
  value: JsonValue;
};

function focusedSessionItems(
  focusTurns: ReaderFocusTurn[],
): PackedItem[] {
  const grouped = new Map<string, {
    sessionId: string;
    date: string;
    retrievalRank: number;
    turns: JsonValue[];
  }>();
  for (const turn of focusTurns) {
    const group = grouped.get(turn.sessionId) ?? {
      sessionId: turn.sessionId,
      date: turn.date,
      retrievalRank: turn.retrievalRank,
      turns: [],
    };
    group.turns.push({
      turnIndex: turn.turnIndex,
      role: turn.role,
      content: turn.content,
    });
    grouped.set(turn.sessionId, group);
  }
  return [...grouped.values()].map((value): PackedItem => ({
    channel: "session",
    id: value.sessionId,
    value,
  }));
}

function serializedBytes(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function buildReaderPromptEvidence(
  candidates: RetrievalCandidates,
  byteBudget = READER_EVIDENCE_BYTE_BUDGET,
): ReaderPromptEvidence {
  if (!Number.isInteger(byteBudget) || byteBudget < 1) {
    throw new Error("reader evidence byte budget must be a positive integer");
  }
  const focusTurns = focusReaderTurns(candidates.question, candidates);
  const items: PackedItem[] = [
    ...focusedSessionItems(focusTurns),
    ...candidates.graphCells.map((candidate): PackedItem => ({
      channel: "graph",
      id: candidate.documentId,
      value: {
        retrievalRank: candidate.rank,
        retrievalScore: candidate.score,
        pointer: candidate.pointer,
        value: candidate.value,
        sourceSessionIds: candidate.sessionIds,
      },
    })),
    ...candidates.coverageFallbackSessions.map((candidate): PackedItem => ({
      channel: "fallback",
      id: candidate.documentId,
      value: {
        retrievalRank: candidate.rank,
        retrievalScore: candidate.score,
        signalId: candidate.signalId,
        sessionId: candidate.sessionId,
        turnIndex: candidate.turnIndex,
        text: candidate.text,
      },
    })),
    ...candidates.summaries.map((candidate): PackedItem => ({
      channel: "summary",
      id: candidate.documentId,
      value: {
        retrievalRank: candidate.rank,
        retrievalScore: candidate.score,
        windowId: candidate.summary.windowId,
        sessionIds: candidate.summary.sessionIds,
        graphRevision: candidate.summary.graphRevision,
        summary: candidate.summary.summary,
      },
    })),
  ];
  const included: Record<PackedItem["channel"], JsonValue[]> = {
    session: [],
    graph: [],
    summary: [],
    fallback: [],
    tail: [],
  };
  const omittedItems: string[] = [];
  let includedBytes = 0;
  for (const item of items) {
    const bytes = serializedBytes(item.value);
    if (includedBytes + bytes > byteBudget) {
      omittedItems.push(`${item.channel}:${item.id}`);
      continue;
    }
    included[item.channel].push(item.value);
    includedBytes += bytes;
  }
  return {
    sessionCandidates: JSON.stringify(included.session, null, 2),
    graphCandidates: JSON.stringify(included.graph, null, 2),
    summaryCandidates: JSON.stringify(included.summary, null, 2),
    coverageFallbackCandidates: JSON.stringify(included.fallback, null, 2),
    tailCandidates: JSON.stringify(included.tail, null, 2),
    focusTurns,
    includedBytes,
    omittedItems,
  };
}
