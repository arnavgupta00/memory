import type { SelectedSpan } from "../retrieval/types.js";

/** Serialize selected spans into the {{retrieved_memory}} fill-in. */
export function formatRetrievedMemory(spans: SelectedSpan[]): string {
  if (spans.length === 0) return "(no memory retrieved)";
  return spans
    .map((span) => {
      const header = `### session ${span.sessionId} | date ${span.date} | turns ${String(span.startTurn)}-${String(span.endTurn)}`;
      const turns = span.turns
        .map(
          (turn) =>
            `[${turn.role} sessionId=${span.sessionId} turnIndex=${String(turn.turnIndex)}]\n${turn.content}`,
        )
        .join("\n\n");
      return `${header}\n${turns}`;
    })
    .join("\n\n");
}
