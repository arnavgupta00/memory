import type { JsonValue, MasterContextGraph } from "../types.js";

function escape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

type Row = { pointer: string; label: string; depth: number; value: string };

function rows(value: JsonValue, pointer = "/context", depth = 0): Row[] {
  if (Array.isArray(value) || value === null || typeof value !== "object") {
    return [{ pointer, label: pointer.split("/").at(-1) ?? "context", depth, value: JSON.stringify(value) }];
  }
  const entries = Object.entries(value);
  if (!entries.length) return [{ pointer, label: pointer.split("/").at(-1) ?? "context", depth, value: "{}" }];
  return entries.flatMap(([key, child]) => [
    { pointer: `${pointer}/${key}`, label: key, depth, value: Array.isArray(child) || child === null || typeof child !== "object" ? JSON.stringify(child) : "" },
    ...rows(child, `${pointer}/${key}`, depth + 1).filter((row) => row.pointer !== `${pointer}/${key}`),
  ]);
}

export function renderGraphSvg(graph: MasterContextGraph): string {
  const items = rows(graph.context).slice(0, 300);
  const width = 1200;
  const rowHeight = 34;
  const height = Math.max(180, 90 + items.length * rowHeight);
  const content = items
    .map((row, index) => {
      const y = 86 + index * rowHeight;
      const x = 36 + row.depth * 28;
      const value = row.value ? ` = ${row.value}` : "";
      return `<g><circle cx="${x}" cy="${y - 5}" r="4" fill="#69d6b0"/><text x="${x + 14}" y="${y}" fill="#e8eefc" font-family="IBM Plex Mono, monospace" font-size="14">${escape(row.label + value)}</text></g>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#111522"/><text x="36" y="42" fill="#9e8cff" font-family="IBM Plex Sans, sans-serif" font-size="22" font-weight="700">Contexto master graph · revision ${graph.revision}</text>${content}</svg>`;
}
