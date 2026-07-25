import { z } from "zod";

import type { RetrievalCandidates } from "../retrieval/types.js";
import {
  ReaderAnswerModeSchema,
  type ReaderPlan,
  ReaderSessionPurposeSchema,
} from "../types.js";
import type { ReaderFocusTurn } from "./readerFocus.js";

type SelectedSession = ReaderPlan["selectedSessions"][number];

const UnconstrainedSelectedSessionSchema: z.ZodType<SelectedSession> = z.strictObject({
  sessionId: z.string().min(1),
  turnIndexes: z.array(z.number().int().nonnegative()).min(1).max(32),
  purpose: ReaderSessionPurposeSchema,
});

function nonEmptyValues<T>(values: T[]): [T, ...T[]] | null {
  const first = values[0];
  return first === undefined ? null : [first, ...values.slice(1)];
}

function candidateTurnIndexes(
  candidates: RetrievalCandidates,
  focusTurns?: ReaderFocusTurn[],
): Map<string, Set<number>> {
  const indexesBySessionId = new Map<string, Set<number>>();
  const addSession = (sessionId: string, turnCount: number): void => {
    const indexes = indexesBySessionId.get(sessionId) ?? new Set<number>();
    for (let turnIndex = 0; turnIndex < turnCount; turnIndex += 1) {
      indexes.add(turnIndex);
    }
    indexesBySessionId.set(sessionId, indexes);
  };
  if (focusTurns === undefined) {
    for (const candidate of candidates.sessions) {
      addSession(candidate.session.session_id, candidate.session.turns.length);
    }
    for (const candidate of candidates.tailSessions) {
      addSession(candidate.session.session_id, candidate.session.turns.length);
    }
  } else {
    for (const turn of focusTurns) {
      const indexes = indexesBySessionId.get(turn.sessionId) ?? new Set<number>();
      indexes.add(turn.turnIndex);
      indexesBySessionId.set(turn.sessionId, indexes);
    }
  }
  for (const candidate of candidates.coverageFallbackSessions) {
    const indexes = indexesBySessionId.get(candidate.sessionId) ?? new Set<number>();
    indexes.add(candidate.turnIndex);
    indexesBySessionId.set(candidate.sessionId, indexes);
  }
  return indexesBySessionId;
}

function selectedSessionsSchema(
  indexesBySessionId: Map<string, Set<number>>,
): z.ZodType<SelectedSession[]> {
  const variants = [...indexesBySessionId.entries()].flatMap(
    ([sessionId, indexes]) => {
      const allowedIndexes = nonEmptyValues([...indexes].sort((left, right) => left - right));
      if (allowedIndexes === null) return [];
      return [z.strictObject({
        sessionId: z.literal(sessionId),
        turnIndexes: z.array(z.literal(allowedIndexes)).min(1).max(32),
        purpose: ReaderSessionPurposeSchema,
      })];
    },
  );
  const first = variants[0];
  if (first === undefined) {
    return z.array(UnconstrainedSelectedSessionSchema).max(0);
  }
  const itemSchema = variants.length === 1
    ? first
    : z.discriminatedUnion("sessionId", [first, ...variants.slice(1)]);
  return z.array(itemSchema).max(8);
}

function constrainedStrings(
  values: string[],
  maximum: number,
): z.ZodType<string[]> {
  const allowed = nonEmptyValues([...new Set(values)].sort());
  if (allowed === null) return z.array(z.string()).max(0);
  return z.array(z.literal(allowed)).max(maximum);
}

export function createCandidateConstrainedReaderPlanSchema(
  candidates: RetrievalCandidates,
  focusTurns?: ReaderFocusTurn[],
): z.ZodType<ReaderPlan> {
  const indexesBySessionId = candidateTurnIndexes(candidates, focusTurns);
  const sessionIds = [...indexesBySessionId.keys()];
  const graphPointers = candidates.graphCells.map((candidate) => candidate.pointer);
  const sessionReferencesSchema = constrainedStrings(sessionIds, 8);
  const graphReferencesSchema = constrainedStrings(graphPointers, 12);

  return z.strictObject({
    supportStatus: z.enum(["sufficient", "conflicted", "insufficient"]),
    answerMode: ReaderAnswerModeSchema,
    selectedSessions: selectedSessionsSchema(indexesBySessionId),
    selectedGraphPointers: graphReferencesSchema,
    evidenceFacts: z.array(z.strictObject({
      statement: z.string().min(1),
      sessionIds: sessionReferencesSchema,
      graphPointers: graphReferencesSchema,
    })).max(12),
    conflicts: z.array(z.strictObject({
      olderStatement: z.string().min(1),
      newerStatement: z.string().min(1),
      resolution: z.string().min(1),
    })).max(6),
  });
}
