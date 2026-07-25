import type {
  ContextoSignalCoverage,
  GraphMutationRecord,
  JsonObject,
  JsonValue,
  MasterContextGraph,
  SessionSummaryRecord,
  TimestampedSession,
} from "../types.js";
import type { RetrievalDocument } from "./types.js";

export type GraphCellDocument = {
  document: RetrievalDocument;
  pointer: string;
  value: string;
};

export type SessionDocument = {
  document: RetrievalDocument;
  session: TimestampedSession;
};

export type CoverageFallbackDocument = {
  document: RetrievalDocument;
  signal: ContextoSignalCoverage;
};

function escapePointer(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMemoryCell(value: JsonValue | undefined): value is JsonObject {
  return isObject(value)
    && typeof value.memory_type === "string"
    && isObject(value.current)
    && isObject(value.history);
}

function sourcesBelow(
  graph: MasterContextGraph,
  pointer: string,
): Array<{ sessionId: string; excerpt: string | null }> {
  const seen = new Set<string>();
  const result: Array<{ sessionId: string; excerpt: string | null }> = [];
  for (const [sourcePointer, sources] of Object.entries(graph.provenanceByPointer)) {
    if (sourcePointer !== pointer && !sourcePointer.startsWith(`${pointer}/`)) continue;
    for (const source of sources) {
      const key = `${source.sessionId}\u0000${source.excerpt ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ sessionId: source.sessionId, excerpt: source.excerpt });
    }
  }
  return result.sort(
    (left, right) =>
      left.sessionId.localeCompare(right.sessionId) ||
      (left.excerpt ?? "").localeCompare(right.excerpt ?? ""),
  );
}

export function renderSession(session: TimestampedSession): string {
  return [
    `session_id: ${session.session_id}`,
    `date: ${session.date}`,
    ...session.turns.map((turn) => `[${turn.role}] ${turn.content}`),
  ].join("\n");
}

export function graphCellDocuments(graph: MasterContextGraph): GraphCellDocument[] {
  const documents: GraphCellDocument[] = [];
  const visit = (value: JsonValue, parts: string[]): void => {
    if (isMemoryCell(value)) {
      const pointer = `/context/${parts.map(escapePointer).join("/")}`;
      const sources = sourcesBelow(graph, pointer);
      const serialized = JSON.stringify(value);
      const sourceExcerpts = sources.flatMap((source) =>
        source.excerpt === null ? [] : [source.excerpt],
      );
      documents.push({
        pointer,
        value: serialized,
        document: {
          id: `graph:${pointer}`,
          channel: "graph_cell",
          text: [pointer, serialized, ...sourceExcerpts].join("\n"),
          sessionIds: [...new Set(sources.map((source) => source.sessionId))],
          date: null,
        },
      });
      return;
    }
    if (!isObject(value)) return;
    for (const [key, child] of Object.entries(value)) visit(child, [...parts, key]);
  };
  visit(graph.context, []);
  return documents.sort((left, right) => left.pointer.localeCompare(right.pointer));
}

function graphExpansionsBySession(
  graphDocuments: GraphCellDocument[],
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const graphDocument of graphDocuments) {
    for (const sessionId of graphDocument.document.sessionIds) {
      const items = result.get(sessionId) ?? [];
      items.push(graphDocument.document.text);
      result.set(sessionId, items);
    }
  }
  return result;
}

function summaryExpansionsBySession(
  summaries: SessionSummaryRecord[],
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const summary of summaries) {
    for (const sessionId of summary.sessionIds) {
      const items = result.get(sessionId) ?? [];
      items.push(`summary ${summary.windowId}: ${summary.summary}`);
      result.set(sessionId, items);
    }
  }
  return result;
}

export function sessionDocuments(args: {
  sessions: TimestampedSession[];
  graphDocuments: GraphCellDocument[];
  summaries: SessionSummaryRecord[];
}): SessionDocument[] {
  const graphExpansions = graphExpansionsBySession(args.graphDocuments);
  const summaryExpansions = summaryExpansionsBySession(args.summaries);
  return args.sessions.map((session, index) => ({
    session,
    document: {
      id: `session:${String(index).padStart(6, "0")}:${session.session_id}`,
      channel: "session",
      text: [
        renderSession(session),
        ...(graphExpansions.get(session.session_id) ?? []),
        ...(summaryExpansions.get(session.session_id) ?? []),
      ].join("\n"),
      sessionIds: [session.session_id],
      date: session.date,
    },
  }));
}

export function summaryDocuments(
  summaries: SessionSummaryRecord[],
): RetrievalDocument[] {
  return summaries.map((summary) => ({
    id: `summary:${summary.windowId}`,
    channel: "summary",
    text: `${summary.windowId}\n${summary.sessionIds.join(" ")}\n${summary.summary}`,
    sessionIds: [...summary.sessionIds],
    date: null,
  }));
}

export function coverageFallbackDocuments(
  mutationRecords: GraphMutationRecord[],
): CoverageFallbackDocument[] {
  const seen = new Set<string>();
  const results: CoverageFallbackDocument[] = [];
  for (const record of mutationRecords) {
    for (const signal of record.coverage?.signals ?? []) {
      if (signal.status !== "session_index_fallback" || seen.has(signal.signalId)) continue;
      seen.add(signal.signalId);
      results.push({
        signal,
        document: {
          id: `coverage:${signal.signalId}`,
          channel: "coverage_fallback",
          text: `${signal.sessionId}\n${signal.text}`,
          sessionIds: [signal.sessionId],
          date: null,
        },
      });
    }
  }
  return results.sort((left, right) =>
    left.document.id.localeCompare(right.document.id),
  );
}

export function tailDocuments(
  sessions: TimestampedSession[],
  graphTrackedCount: number,
): SessionDocument[] {
  return sessions.slice(graphTrackedCount).map((session, index) => ({
    session,
    document: {
      id: `tail:${String(graphTrackedCount + index).padStart(6, "0")}:${session.session_id}`,
      channel: "tail",
      text: renderSession(session),
      sessionIds: [session.session_id],
      date: session.date,
    },
  }));
}
