import { Bm25Index, DEFAULT_TEMPORAL_BOOST } from "./bm25.js";
import {
  coverageFallbackDocuments,
  graphCellDocuments,
  sessionDocuments,
  summaryDocuments,
  tailDocuments,
} from "./documents.js";
import type {
  Bm25SearchResult,
  RetrievalDocument,
  RetrievalDocumentChannel,
  RetrievalInput,
  RetrievalOutput,
} from "./types.js";

function search(
  documents: RetrievalDocument[],
  question: string,
  limit: number,
): Bm25SearchResult[] {
  return new Bm25Index(documents).search(question, limit, DEFAULT_TEMPORAL_BOOST);
}

function searchWithFallback(
  documents: RetrievalDocument[],
  question: string,
): Bm25SearchResult[] {
  const matched = search(documents, question, documents.length);
  const matchedIds = new Set(matched.map((result) => result.documentId));
  const unmatched = documents
    .filter((document) => !matchedIds.has(document.id))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((document) => ({
      documentId: document.id,
      score: 0,
      bm25Score: 0,
      temporalBoost: 0,
      matchedTerms: [],
      rank: 0,
    }));
  return [...matched, ...unmatched].map((result, index) => ({
    ...result,
    rank: index + 1,
  }));
}

function countByChannel(
  documentSets: RetrievalDocument[][],
): Record<RetrievalDocumentChannel, number> {
  const result: Record<RetrievalDocumentChannel, number> = {
    session: 0,
    graph_cell: 0,
    summary: 0,
    coverage_fallback: 0,
    tail: 0,
  };
  for (const document of documentSets.flat()) result[document.channel] += 1;
  return result;
}

export function retrieveMemory(input: RetrievalInput): RetrievalOutput {
  const graphDocuments = graphCellDocuments(input.graph);
  const sessions = sessionDocuments({
    sessions: input.sessions,
    graphDocuments,
    summaries: input.summaries,
  });
  const summaries = summaryDocuments(input.summaries);
  const coverageFallbacks = coverageFallbackDocuments(input.mutationRecords);
  const tails = tailDocuments(input.sessions, input.graphTrackedCount);

  const rawSessionResults = search(
    sessions.map((item) => item.document),
    input.question,
    sessions.length,
  );
  const seenSessionIds = new Set<string>();
  const sessionResults = rawSessionResults.filter((result) => {
    const item = sessions.find((candidate) => candidate.document.id === result.documentId);
    const sessionId = item?.session.session_id;
    if (sessionId === undefined || seenSessionIds.has(sessionId)) return false;
    seenSessionIds.add(sessionId);
    return true;
  }).slice(0, 12).map((result, index) => ({ ...result, rank: index + 1 }));
  const graphResults = search(
    graphDocuments.map((item) => item.document),
    input.question,
    12,
  );
  const summaryResults = search(summaries, input.question, 4);
  const coverageResults = search(
    coverageFallbacks.map((item) => item.document),
    input.question,
    4,
  );
  const tailResults = searchWithFallback(
    tails.map((item) => item.document),
    input.question,
  );

  const sessionByDocumentId = new Map(
    sessions.map((item) => [item.document.id, item.session]),
  );
  const graphById = new Map(
    graphDocuments.map((item) => [item.document.id, item]),
  );
  const summaryById = new Map(
    input.summaries.map((summary) => [`summary:${summary.windowId}`, summary]),
  );
  const fallbackById = new Map(
    coverageFallbacks.map((item) => [item.document.id, item.signal]),
  );
  const tailById = new Map(
    tails.map((item) => [item.document.id, item.session]),
  );

  return {
    manifest: {
      schemaVersion: 1,
      algorithm: "bm25",
      parameters: {
        k1: 1.2,
        b: 0.75,
        temporalBoost: DEFAULT_TEMPORAL_BOOST,
      },
      documentCounts: countByChannel([
        sessions.map((item) => item.document),
        graphDocuments.map((item) => item.document),
        summaries,
        coverageFallbacks.map((item) => item.document),
        tails.map((item) => item.document),
      ]),
      sessionCount: input.sessions.length,
      graphRevision: input.graph.revision,
      graphTrackedCount: input.graphTrackedCount,
      summaryTrackedCount: input.summaryTrackedCount,
    },
    candidates: {
      schemaVersion: 1,
      question: input.question,
      questionDate: input.questionDate,
      sessions: sessionResults.flatMap((result) => {
        const session = sessionByDocumentId.get(result.documentId);
        return session ? [{ ...result, session }] : [];
      }),
      graphCells: graphResults.flatMap((result) => {
        const graphDocument = graphById.get(result.documentId);
        return graphDocument
          ? [{
              ...result,
              pointer: graphDocument.pointer,
              value: graphDocument.value,
              sessionIds: graphDocument.document.sessionIds,
            }]
          : [];
      }),
      summaries: summaryResults.flatMap((result) => {
        const summary = summaryById.get(result.documentId);
        return summary ? [{ ...result, summary }] : [];
      }),
      coverageFallbackSessions: coverageResults.flatMap((result) => {
        const signal = fallbackById.get(result.documentId);
        return signal
          ? [{
              ...result,
              signalId: signal.signalId,
              sessionId: signal.sessionId,
              turnIndex: signal.turnIndex,
              text: signal.text,
            }]
          : [];
      }),
      tailSessions: tailResults.flatMap((result) => {
        const session = tailById.get(result.documentId);
        return session ? [{ ...result, session }] : [];
      }),
    },
  };
}
