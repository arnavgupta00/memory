import { createHash } from "node:crypto";

import type { ArchitectureCase } from "../benchmarks/architectureDataset.js";
import type { SessionAnnotation } from "./notesIndex.js";
import type {
  SemanticChunk,
  SemanticChunkSource,
  SemanticSession,
} from "./semanticTypes.js";

export const SEMANTIC_CHUNKER_VERSION = "session-turn-v1-512";
const TARGET_CHARACTERS = 2_048;
const OVERLAP_CHARACTERS = 256;

function sha256(parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
}

function normalizeText(text: string): string {
  return text.replaceAll(/\r\n?/gu, "\n").replaceAll(/[\t ]+/gu, " ").trim();
}

function splitText(text: string): string[] {
  const normalized = normalizeText(text);
  if (normalized.length <= TARGET_CHARACTERS) return normalized ? [normalized] : [];
  const output: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + TARGET_CHARACTERS, normalized.length);
    if (end < normalized.length) {
      const boundary = Math.max(
        normalized.lastIndexOf("\n", end),
        normalized.lastIndexOf(". ", end),
        normalized.lastIndexOf(" ", end),
      );
      if (boundary > start + TARGET_CHARACTERS / 2) end = boundary + 1;
    }
    const part = normalized.slice(start, end).trim();
    if (part) output.push(part);
    if (end >= normalized.length) break;
    start = Math.max(end - OVERLAP_CHARACTERS, start + 1);
  }
  return output;
}

function notesText(annotation: SessionAnnotation | undefined): string {
  if (!annotation) return "";
  const lines: string[] = [];
  if (annotation.facts.length > 0) {
    lines.push("[facts]");
    for (const fact of annotation.facts) lines.push(`- ${fact.text}`);
  }
  if (annotation.keyphrases.length > 0) {
    lines.push(`[keyphrases] ${annotation.keyphrases.join("; ")}`);
  }
  if (annotation.events.length > 0) {
    lines.push("[events]");
    for (const event of annotation.events) {
      lines.push(`- ${event.text}${event.date_hint ? ` (${event.date_hint})` : ""}`);
    }
  }
  return lines.join("\n");
}

function makeChunks(args: {
  session: SemanticSession;
  source: SemanticChunkSource;
  turnIndex: number | null;
  content: string;
}): SemanticChunk[] {
  return splitText(args.content).map((part, partIndex) => {
    const turnLabel = args.turnIndex === null ? "session_notes" : `turn_${String(args.turnIndex)}`;
    const text = [
      `[session_date] ${args.session.date || "unknown"}`,
      `[source] ${args.source}`,
      `[position] ${turnLabel}`,
      part,
    ].join("\n");
    return {
      chunkId: `chunk_${sha256([
        args.session.sessionId,
        args.source,
        String(args.turnIndex ?? -1),
        String(partIndex),
        text,
      ]).slice(0, 24)}`,
      sessionId: args.session.sessionId,
      sessionDate: args.session.date,
      source: args.source,
      turnIndex: args.turnIndex,
      partIndex,
      text,
    };
  });
}

export function chunkSemanticSession(session: SemanticSession): SemanticChunk[] {
  const chunks: SemanticChunk[] = [];
  const notes = notesText(session.annotation);
  if (notes) {
    chunks.push(...makeChunks({ session, source: "notes", turnIndex: null, content: notes }));
  }
  for (let turnIndex = 0; turnIndex < session.turns.length; turnIndex += 1) {
    const turn = session.turns[turnIndex];
    if (!turn) continue;
    chunks.push(...makeChunks({
      session,
      source: turn.role,
      turnIndex,
      content: turn.content,
    }));
  }
  if (chunks.length > 0) return chunks;
  return makeChunks({
    session,
    source: "notes",
    turnIndex: null,
    content: "(empty session)",
  });
}

export function semanticSessionsFromCase(
  item: ArchitectureCase,
  annotations: Map<string, SessionAnnotation>,
): SemanticSession[] {
  const sessions: SemanticSession[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < item.haystack_session_ids.length; index += 1) {
    const sessionId = item.haystack_session_ids[index];
    if (!sessionId || seen.has(sessionId)) continue;
    seen.add(sessionId);
    sessions.push({
      sessionId,
      date: item.haystack_dates[index] ?? "",
      turns: item.haystack_sessions[index] ?? [],
      annotation: annotations.get(sessionId),
    });
  }
  return sessions;
}

/** Local-only corpus identity. Raw IDs are hashed but never placed in provider text. */
export function semanticCorpusHash(sessions: SemanticSession[]): string {
  const hash = createHash("sha256");
  hash.update(`semantic-corpus\0${SEMANTIC_CHUNKER_VERSION}\0`);
  for (const session of sessions) {
    hash.update(session.sessionId).update("\0");
    for (const chunk of chunkSemanticSession(session)) {
      hash.update(chunk.chunkId).update("\0").update(chunk.text).update("\0");
    }
  }
  return hash.digest("hex");
}
