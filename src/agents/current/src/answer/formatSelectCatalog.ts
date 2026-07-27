import type { SelectedSpan } from "../retrieval/types.js";

/** Enumerate every turn in the retrieval bundle so the selector picks IDs, not prose. */
export function formatSelectCatalog(spans: SelectedSpan[]): string {
  const lines: string[] = [];
  for (const span of spans) {
    for (const turn of span.turns) {
      const preview = turn.content.replaceAll("\n", " ").slice(0, 160);
      lines.push(
        `- sessionId=${span.sessionId} turnIndex=${String(turn.turnIndex)} date=${span.date} role=${turn.role} :: ${preview}`,
      );
    }
  }
  return lines.length === 0 ? "(no turns in retrieval bundle)" : lines.join("\n");
}
