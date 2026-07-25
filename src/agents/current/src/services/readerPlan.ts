import type { RetrievalCandidates } from "../retrieval/types.js";
import type {
  MasterContextGraph,
  ReaderPlan,
  TimestampedSession,
} from "../types.js";

export type SanitizedReaderPlan = {
  plan: ReaderPlan;
  warnings: string[];
};

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function allowedGraphPointers(
  candidates: RetrievalCandidates,
  graph: MasterContextGraph,
): Set<string> {
  const candidatePointers = new Set(
    candidates.graphCells.map((candidate) => candidate.pointer),
  );
  return new Set(
    Object.keys(graph.provenanceByPointer).filter((pointer) =>
      candidatePointers.has(pointer)
      || [...candidatePointers].some((candidate) => pointer.startsWith(`${candidate}/`)),
    ).concat([...candidatePointers]),
  );
}

export function sanitizeReaderPlan(args: {
  raw: ReaderPlan;
  candidates: RetrievalCandidates;
  sessions: TimestampedSession[];
  graph: MasterContextGraph;
}): SanitizedReaderPlan {
  const warnings: string[] = [];
  const sessionsById = new Map(args.sessions.map((session) => [session.session_id, session]));
  const candidateSessionIds = new Set([
    ...args.candidates.sessions.map((candidate) => candidate.session.session_id),
    ...args.candidates.coverageFallbackSessions.map((candidate) => candidate.sessionId),
    ...args.candidates.tailSessions.map((candidate) => candidate.session.session_id),
  ]);
  const graphPointers = allowedGraphPointers(args.candidates, args.graph);
  const selectedSessions = args.raw.selectedSessions.flatMap((selected) => {
    const session = sessionsById.get(selected.sessionId);
    if (!session || !candidateSessionIds.has(selected.sessionId)) {
      warnings.push(`reader removed unknown session reference: ${selected.sessionId}`);
      return [];
    }
    const turnIndexes = unique(selected.turnIndexes)
      .filter((index) => index < session.turns.length)
      .sort((left, right) => left - right);
    if (turnIndexes.length === 0) {
      warnings.push(`reader removed session without valid turns: ${selected.sessionId}`);
      return [];
    }
    if (turnIndexes.length !== selected.turnIndexes.length) {
      warnings.push(`reader removed invalid turn references: ${selected.sessionId}`);
    }
    return [{ ...selected, turnIndexes }];
  });
  const selectedGraphPointers = unique(args.raw.selectedGraphPointers).filter((pointer) => {
    const valid = graphPointers.has(pointer);
    if (!valid) warnings.push(`reader removed unknown graph pointer: ${pointer}`);
    return valid;
  });
  const evidenceFacts = args.raw.evidenceFacts.flatMap((fact) => {
    const sessionIds = unique(fact.sessionIds).filter((sessionId) => {
      const valid = candidateSessionIds.has(sessionId) && sessionsById.has(sessionId);
      if (!valid) warnings.push(`reader removed unknown fact session: ${sessionId}`);
      return valid;
    });
    const factPointers = unique(fact.graphPointers).filter((pointer) => {
      const valid = graphPointers.has(pointer);
      if (!valid) warnings.push(`reader removed unknown fact pointer: ${pointer}`);
      return valid;
    });
    if (sessionIds.length === 0 && factPointers.length === 0) {
      warnings.push("reader removed unsupported evidence fact");
      return [];
    }
    return [{ ...fact, sessionIds, graphPointers: factPointers }];
  });
  const noValidEvidence =
    selectedSessions.length === 0
    && selectedGraphPointers.length === 0
    && evidenceFacts.length === 0;
  return {
    plan: {
      ...args.raw,
      supportStatus: noValidEvidence ? "insufficient" : args.raw.supportStatus,
      answerMode: noValidEvidence ? "abstain" : args.raw.answerMode,
      selectedSessions,
      selectedGraphPointers,
      evidenceFacts,
    },
    warnings,
  };
}

export function expandAdjacentTurns(args: {
  plan: ReaderPlan;
  sessions: TimestampedSession[];
}): TimestampedSession[] {
  const sessionsById = new Map(args.sessions.map((session) => [session.session_id, session]));
  return args.plan.selectedSessions.flatMap((selected) => {
    const session = sessionsById.get(selected.sessionId);
    if (!session) return [];
    const indexes = new Set<number>();
    for (const index of selected.turnIndexes) {
      indexes.add(index);
      if (index > 0) indexes.add(index - 1);
      if (index + 1 < session.turns.length) indexes.add(index + 1);
    }
    const turns = [...indexes]
      .sort((left, right) => left - right)
      .map((index) => session.turns[index])
      .filter((turn) => turn !== undefined);
    return [{ ...session, turns }];
  });
}
