import type {
  JsonValue,
  MasterContextGraph,
  ReaderPlan,
  SourceReference,
  TimestampedSession,
} from "../types.js";

export const FINAL_EVIDENCE_BYTE_BUDGET = 36_000;
export const FINAL_EVIDENCE_CHARS_PER_TOKEN = 4;

type SessionPurpose = ReaderPlan["selectedSessions"][number]["purpose"];
type EvidenceFact = ReaderPlan["evidenceFacts"][number];
type ReaderConflict = ReaderPlan["conflicts"][number];

export type CompactEvidenceTurn = {
  turnIndex: number;
  role: "user" | "assistant";
  content: string;
  selection: "reader_selected" | "adjacent_context";
};

export type CompactEvidenceSession = {
  sessionId: string;
  date: string;
  purposes: SessionPurpose[];
  turns: CompactEvidenceTurn[];
};

export type CompactGraphEvidence = {
  pointer: string;
  value: JsonValue;
  sources: SourceReference[];
};

export type CompactFinalEvidencePayload = {
  schemaVersion: 1;
  readerDecision: {
    supportStatus: ReaderPlan["supportStatus"];
    answerMode: ReaderPlan["answerMode"];
  };
  evidenceFacts: EvidenceFact[];
  conflicts: ReaderConflict[];
  graphEvidence: CompactGraphEvidence[];
  sessions: CompactEvidenceSession[];
};

export type CompactFinalEvidencePackage = {
  payload: CompactFinalEvidencePayload;
  byteBudget: number;
  promptByteEstimate: number;
  promptTokenEstimate: number;
  omittedItems: string[];
};

type SelectedSession = {
  session: TimestampedSession;
  purposes: SessionPurpose[];
  primaryTurnIndexes: number[];
  turnIndexes: number[];
};

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function decodePointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function valueAtPointer(
  graph: MasterContextGraph,
  pointer: string,
): JsonValue | undefined {
  const segments = pointer.split("/").slice(1).map(decodePointerSegment);
  if (segments.shift() !== "context") return undefined;
  let value: JsonValue = graph.context;
  for (const segment of segments) {
    if (
      value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || !Object.hasOwn(value, segment)
    ) {
      return undefined;
    }
    const next: JsonValue | undefined = value[segment];
    if (next === undefined) return undefined;
    value = next;
  }
  return value;
}

function sourceKey(source: SourceReference): string {
  return [
    source.sessionId,
    source.turnIndex,
    source.sessionDate,
    source.batchId,
    source.excerpt ?? "",
  ].join("\u0000");
}

function pointerSources(
  graph: MasterContextGraph,
  pointer: string,
): SourceReference[] {
  const sources = Object.entries(graph.provenanceByPointer)
    .filter(([candidate]) =>
      candidate === pointer || candidate.startsWith(`${pointer}/`),
    )
    .flatMap(([, candidateSources]) => candidateSources);
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = sourceKey(source);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function selectedSessions(
  plan: ReaderPlan,
  sessions: readonly TimestampedSession[],
  graph: MasterContextGraph,
): SelectedSession[] {
  const sessionsById = new Map(
    sessions.map((session) => [session.session_id, session]),
  );
  const selected = new Map<string, SelectedSession>();
  const include = (
    sessionId: string,
    purpose: SessionPurpose,
    requestedTurnIndexes: readonly number[],
  ): void => {
    if (!selected.has(sessionId) && selected.size >= 8) return;
    const session = sessionsById.get(sessionId);
    if (session === undefined) return;
    const existing = selected.get(sessionId) ?? {
      session,
      purposes: [],
      primaryTurnIndexes: [],
      turnIndexes: [],
    };
    existing.purposes = unique([...existing.purposes, purpose]);
    existing.primaryTurnIndexes = unique([
      ...existing.primaryTurnIndexes,
      ...requestedTurnIndexes,
    ])
      .filter((turnIndex) =>
        turnIndex >= 0 && turnIndex < session.turns.length,
      )
      .sort((left, right) => left - right);
    existing.turnIndexes = unique([
      ...existing.turnIndexes,
      ...requestedTurnIndexes.flatMap((turnIndex) => [
        turnIndex - 1,
        turnIndex,
        turnIndex + 1,
      ]),
    ])
      .filter((turnIndex) =>
        turnIndex >= 0 && turnIndex < session.turns.length,
      )
      .sort((left, right) => left - right);
    selected.set(sessionId, existing);
  };
  for (const item of plan.selectedSessions) {
    include(item.sessionId, item.purpose, item.turnIndexes);
  }
  for (const pointer of plan.selectedGraphPointers) {
    for (const source of pointerSources(graph, pointer)) {
      include(source.sessionId, "context", [source.turnIndex]);
    }
  }
  return [...selected.values()];
}

function serializedBytes(payload: CompactFinalEvidencePayload): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

function withFact(
  payload: CompactFinalEvidencePayload,
  fact: EvidenceFact,
): CompactFinalEvidencePayload {
  return { ...payload, evidenceFacts: [...payload.evidenceFacts, fact] };
}

function withConflict(
  payload: CompactFinalEvidencePayload,
  conflict: ReaderConflict,
): CompactFinalEvidencePayload {
  return { ...payload, conflicts: [...payload.conflicts, conflict] };
}

function withGraphEvidence(
  payload: CompactFinalEvidencePayload,
  evidence: CompactGraphEvidence,
): CompactFinalEvidencePayload {
  return { ...payload, graphEvidence: [...payload.graphEvidence, evidence] };
}

function withTurn(
  payload: CompactFinalEvidencePayload,
  selected: SelectedSession,
  turn: CompactEvidenceTurn,
): CompactFinalEvidencePayload {
  const sessionIndex = payload.sessions.findIndex(
    (session) => session.sessionId === selected.session.session_id,
  );
  if (sessionIndex < 0) {
    return {
      ...payload,
      sessions: [
        ...payload.sessions,
        {
          sessionId: selected.session.session_id,
          date: selected.session.date,
          purposes: selected.purposes,
          turns: [turn],
        },
      ],
    };
  }
  return {
    ...payload,
    sessions: payload.sessions.map((session, index) =>
      index === sessionIndex
        ? { ...session, turns: [...session.turns, turn] }
        : session,
    ),
  };
}

export function buildCompactFinalEvidencePackage(args: {
  plan: ReaderPlan;
  sessions: readonly TimestampedSession[];
  graph: MasterContextGraph;
  byteBudget?: number;
}): CompactFinalEvidencePackage {
  const byteBudget = args.byteBudget ?? FINAL_EVIDENCE_BYTE_BUDGET;
  if (!Number.isInteger(byteBudget) || byteBudget < 1) {
    throw new Error("final evidence byte budget must be a positive integer");
  }
  let payload: CompactFinalEvidencePayload = {
    schemaVersion: 1,
    readerDecision: {
      supportStatus: args.plan.supportStatus,
      answerMode: args.plan.answerMode,
    },
    evidenceFacts: [],
    conflicts: [],
    graphEvidence: [],
    sessions: [],
  };
  if (serializedBytes(payload) > byteBudget) {
    throw new Error("final evidence byte budget cannot fit the package envelope");
  }
  const omittedItems: string[] = [];
  const tryInclude = (
    itemId: string,
    nextPayload: CompactFinalEvidencePayload,
  ): void => {
    if (serializedBytes(nextPayload) <= byteBudget) {
      payload = nextPayload;
    } else {
      omittedItems.push(itemId);
    }
  };

  const retainedSessions = selectedSessions(
    args.plan,
    args.sessions,
    args.graph,
  );
  const selectedSessionIds = new Set(
    retainedSessions.map((item) => item.session.session_id),
  );
  const selectedPointers = new Set(args.plan.selectedGraphPointers.slice(0, 12));
  const includeTurns = (
    selection: CompactEvidenceTurn["selection"],
    indexesFor: (selected: SelectedSession) => readonly number[],
  ): void => {
    for (const selected of retainedSessions) {
      for (const turnIndex of indexesFor(selected)) {
        const turn = selected.session.turns[turnIndex];
        if (turn === undefined) continue;
        tryInclude(
          `session:${selected.session.session_id}:turn:${turnIndex}`,
          withTurn(payload, selected, {
            turnIndex,
            role: turn.role,
            content: turn.content,
            selection,
          }),
        );
      }
    }
  };
  includeTurns("reader_selected", (selected) =>
    selected.primaryTurnIndexes
  );
  includeTurns("adjacent_context", (selected) =>
    selected.turnIndexes.filter(
      (turnIndex) => !selected.primaryTurnIndexes.includes(turnIndex),
    )
  );

  args.plan.evidenceFacts.slice(0, 12).forEach((fact, factIndex) => {
    const filtered: EvidenceFact = {
      ...fact,
      sessionIds: unique(
        fact.sessionIds.filter((sessionId) => selectedSessionIds.has(sessionId)),
      ),
      graphPointers: unique(
        fact.graphPointers.filter((pointer) => selectedPointers.has(pointer)),
      ),
    };
    if (
      filtered.sessionIds.length === 0
      && filtered.graphPointers.length === 0
    ) {
      omittedItems.push(`fact:${factIndex}:unselected_source`);
      return;
    }
    tryInclude(`fact:${factIndex}`, withFact(payload, filtered));
  });

  args.plan.conflicts.forEach((conflict, conflictIndex) => {
    tryInclude(
      `conflict:${conflictIndex}`,
      withConflict(payload, conflict),
    );
  });

  args.plan.selectedGraphPointers.slice(0, 12)
    .forEach((pointer, pointerIndex) => {
      const value = valueAtPointer(args.graph, pointer);
      if (value === undefined) {
        omittedItems.push(`graph:${pointerIndex}:unknown_pointer`);
        return;
      }
      tryInclude(
        `graph:${pointerIndex}`,
        withGraphEvidence(payload, {
          pointer,
          value,
          sources: pointerSources(args.graph, pointer),
        }),
      );
    });

  const promptByteEstimate = serializedBytes(payload);
  return {
    payload,
    byteBudget,
    promptByteEstimate,
    promptTokenEstimate: Math.ceil(
      promptByteEstimate / FINAL_EVIDENCE_CHARS_PER_TOKEN,
    ),
    omittedItems,
  };
}
