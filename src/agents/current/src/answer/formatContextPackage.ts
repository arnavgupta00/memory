import type { ContextPackage } from "../types.js";

function formatItem(
  item: ContextPackage["items"][number],
  index: number,
): string {
  const meta = [
    `### item ${String(index + 1)}`,
    `session ${item.sessionId} | date ${item.date} | turn ${String(item.turnIndex)} | ${item.role}`,
    item.why ? `why: ${item.why}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  return `${meta}\n${item.text}`;
}

/** Serialize a context package into the {{context_package}} fill-in. */
export function formatContextPackage(pkg: ContextPackage): string {
  const header = [
    `queryShape: ${pkg.queryShape}`,
    `setBoundary: ${pkg.setBoundary}`,
    `candidateStatus: ${pkg.candidateStatus}`,
    `missingRisk: ${pkg.missingRisk}`,
  ].join("\n");

  if (pkg.candidateStatus === "none_found" || pkg.items.length === 0) {
    return `${header}\n\n## NO MATCHING TURNS FOUND\n(empty selected set; do not invent members)`;
  }

  const selected = pkg.items.filter((item) => item.tier === "selected");
  const supporting = pkg.items.filter((item) => item.tier === "supporting");
  const sections: string[] = [header];

  sections.push("## SELECTED (matched the question)");
  if (selected.length === 0) {
    sections.push("(no selected turns)");
  } else {
    sections.push(selected.map((item, index) => formatItem(item, index + 1)).join("\n\n"));
  }

  if (supporting.length > 0) {
    sections.push(
      "## SUPPORTING (same sessions; use when they bear on the question)",
    );
    sections.push(
      supporting.map((item, index) => formatItem(item, index + 1)).join("\n\n"),
    );
  }

  return sections.join("\n\n");
}
