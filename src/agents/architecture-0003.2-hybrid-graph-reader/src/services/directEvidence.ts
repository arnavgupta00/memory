import type { MasterContextGraph, SourceReference } from "../types.js";

export type DirectEvidenceExcerpt = {
  sessionId: string;
  turnIndex: number;
  sessionDate: string;
  excerpt: string;
  pointers: string[];
  containsTemporalCue: boolean;
};

const TEMPORAL_CUE = /\b(?:before|after|ago|earlier|later|during|since|until|today|yesterday|tomorrow|last|next|days?|weeks?|months?|years?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b/i;

function sourceKey(source: SourceReference): string {
  return `${source.sessionId}:${String(source.turnIndex)}:${source.excerpt ?? ""}`;
}

/**
 * Deduplicates trusted graph provenance without consulting the benchmark
 * question. This is an evidence ledger, not a retrieval stage.
 */
export function collectDirectEvidence(graph: MasterContextGraph): DirectEvidenceExcerpt[] {
  const bySource = new Map<string, DirectEvidenceExcerpt>();
  for (const [pointer, sources] of Object.entries(graph.provenanceByPointer)) {
    for (const source of sources) {
      if (!source.excerpt) continue;
      const key = sourceKey(source);
      const existing = bySource.get(key);
      if (existing) {
        if (!existing.pointers.includes(pointer)) existing.pointers.push(pointer);
        continue;
      }
      bySource.set(key, {
        sessionId: source.sessionId,
        turnIndex: source.turnIndex,
        sessionDate: source.sessionDate,
        excerpt: source.excerpt,
        pointers: [pointer],
        containsTemporalCue: TEMPORAL_CUE.test(source.excerpt),
      });
    }
  }
  return [...bySource.values()]
    .map((item) => ({ ...item, pointers: [...item.pointers].sort() }))
    .sort((left, right) => Number(right.containsTemporalCue) - Number(left.containsTemporalCue)
      || left.sessionDate.localeCompare(right.sessionDate)
      || left.sessionId.localeCompare(right.sessionId)
      || left.turnIndex - right.turnIndex
      || left.excerpt.localeCompare(right.excerpt));
}
