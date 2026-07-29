import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { Bm25Index } from "./bm25.js";
import type { Bm25SearchResult, RetrievalDocument } from "./types.js";

export type SessionFact = {
  text: string;
  turn_index: number;
};

export type SessionEvent = {
  text: string;
  date_hint: string;
  turn_index: number;
};

export type SessionAnnotation = {
  facts: SessionFact[];
  keyphrases: string[];
  events: SessionEvent[];
};

export type NotesHit = {
  sessionId: string;
  rank: number;
  score: number;
  snippet: string;
  matchedTerms: string[];
};

function asAnnotation(raw: unknown): SessionAnnotation | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const facts = Array.isArray(obj.facts) ? obj.facts : [];
  const keyphrases = Array.isArray(obj.keyphrases) ? obj.keyphrases : [];
  const events = Array.isArray(obj.events) ? obj.events : [];
  return {
    facts: facts
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
      .map((item) => ({
        text: String(item.text ?? ""),
        turn_index: Number(item.turn_index ?? 0),
      }))
      .filter((item) => item.text.trim().length > 0),
    keyphrases: keyphrases.map((item) => String(item)).filter((item) => item.trim().length > 0),
    events: events
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
      .map((item) => ({
        text: String(item.text ?? ""),
        date_hint: String(item.date_hint ?? ""),
        turn_index: Number(item.turn_index ?? 0),
      }))
      .filter((item) => item.text.trim().length > 0),
  };
}

/** Load session annotations from a cache dir (`_index.json` or per-session files). */
export function loadAnnotations(cacheDir: string): Map<string, SessionAnnotation> {
  const out = new Map<string, SessionAnnotation>();
  const indexPath = join(cacheDir, "_index.json");
  if (existsSync(indexPath)) {
    const payload = JSON.parse(readFileSync(indexPath, "utf8")) as {
      sessions?: Record<string, unknown>;
    };
    for (const [sessionId, raw] of Object.entries(payload.sessions ?? {})) {
      const ann = asAnnotation(raw);
      if (ann) out.set(sessionId, ann);
    }
    return out;
  }
  for (const name of readdirSync(cacheDir)) {
    if (!name.endsWith(".json") || name.startsWith("_")) continue;
    const payload = JSON.parse(readFileSync(join(cacheDir, name), "utf8")) as Record<
      string,
      unknown
    >;
    const sessionId = String(payload.session_id ?? name.replace(/\.json$/, ""));
    const ann = asAnnotation(payload);
    if (ann) out.set(sessionId, ann);
  }
  return out;
}

/** Flatten an annotation into BM25-indexable text. */
export function formatNotesDocumentText(
  sessionId: string,
  date: string,
  annotation: SessionAnnotation | undefined,
): string {
  const lines = [`[session_id] ${sessionId}`, `[session_date] ${date}`];
  if (!annotation) {
    lines.push("[notes] (empty)");
    return lines.join("\n");
  }
  if (annotation.facts.length > 0) {
    lines.push("[facts]");
    for (const fact of annotation.facts) {
      lines.push(`- ${fact.text}`);
    }
  }
  if (annotation.keyphrases.length > 0) {
    lines.push(`[keyphrases] ${annotation.keyphrases.join("; ")}`);
  }
  if (annotation.events.length > 0) {
    lines.push("[events]");
    for (const event of annotation.events) {
      const hint = event.date_hint ? ` (${event.date_hint})` : "";
      lines.push(`- ${event.text}${hint}`);
    }
  }
  if (annotation.facts.length === 0 && annotation.keyphrases.length === 0 && annotation.events.length === 0) {
    lines.push("[notes] (empty)");
  }
  return lines.join("\n");
}

export function buildNotesDocuments(args: {
  sessionIds: string[];
  datesBySessionId: Map<string, string>;
  annotations: Map<string, SessionAnnotation>;
}): RetrievalDocument[] {
  const uniqueIds = [...new Set(args.sessionIds)];
  return uniqueIds.map((sessionId) => {
    const date = args.datesBySessionId.get(sessionId) ?? "";
    const annotation = args.annotations.get(sessionId);
    return {
      id: sessionId,
      text: formatNotesDocumentText(sessionId, date, annotation),
      sessionId,
      date,
      startTurn: 0,
      endTurn: 0,
    };
  });
}

export function buildNotesBm25Index(args: {
  sessionIds: string[];
  datesBySessionId: Map<string, string>;
  annotations: Map<string, SessionAnnotation>;
}): Bm25Index {
  return new Bm25Index(
    buildNotesDocuments({
      sessionIds: args.sessionIds,
      datesBySessionId: args.datesBySessionId,
      annotations: args.annotations,
    }),
  );
}

function snippetFor(annotation: SessionAnnotation | undefined, maxChars = 280): string {
  if (!annotation) return "(no notes)";
  const parts: string[] = [];
  for (const fact of annotation.facts.slice(0, 3)) parts.push(fact.text);
  if (annotation.keyphrases.length > 0) {
    parts.push(`keyphrases: ${annotation.keyphrases.slice(0, 6).join("; ")}`);
  }
  const text = parts.join(" | ");
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

export function searchNotesBm25(args: {
  index: Bm25Index;
  query: string;
  topK: number;
  annotations: Map<string, SessionAnnotation>;
}): NotesHit[] {
  const topK = [5, 10, 20].includes(args.topK) ? args.topK : 10;
  const results: Bm25SearchResult[] = args.index.search(args.query, topK);
  return results.map((result) => ({
    sessionId: result.documentId,
    rank: result.rank,
    score: result.score,
    snippet: snippetFor(args.annotations.get(result.documentId)),
    matchedTerms: result.matchedTerms,
  }));
}

/** Case-insensitive substring match over annotation text. */
export function grepNotes(args: {
  sessionIds: string[];
  annotations: Map<string, SessionAnnotation>;
  patterns: string[];
  limit?: number;
}): NotesHit[] {
  const limit = args.limit ?? 20;
  const patterns = args.patterns
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0)
    .slice(0, 5);
  if (patterns.length === 0) return [];

  const hits: NotesHit[] = [];
  for (const sessionId of new Set(args.sessionIds)) {
    const annotation = args.annotations.get(sessionId);
    const text = formatNotesDocumentText(sessionId, "", annotation).toLowerCase();
    const matched = patterns.filter((pattern) => text.includes(pattern.toLowerCase()));
    if (matched.length === 0) continue;
    hits.push({
      sessionId,
      rank: hits.length + 1,
      score: matched.length,
      snippet: snippetFor(annotation),
      matchedTerms: matched,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}
