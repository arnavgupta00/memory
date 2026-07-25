import { writeFile } from "node:fs/promises";

const elements = [];
const boxes = new Map();
let sequence = 0;
const now = 1784764800000;

function base(id, type, x, y, width, height) {
  sequence += 1;
  return {
    id, type, x, y, width, height, angle: 0, strokeColor: "#1e1e1e",
    backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2,
    strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null,
    index: `a${String(sequence).padStart(4, "0")}`, roundness: type === "rectangle" ? { type: 3 } : null,
    seed: 1000 + sequence * 37, version: 1, versionNonce: 9000 + sequence * 41,
    isDeleted: false, boundElements: [], updated: now, link: null, locked: false,
  };
}

function text(id, x, y, width, value, options = {}) {
  const fontSize = options.fontSize ?? 18;
  const lines = value.split("\n").length;
  const item = {
    ...base(id, "text", x, y, width, Math.max(fontSize * 1.25, lines * fontSize * 1.25)),
    strokeColor: options.color ?? "#1e1e1e", strokeWidth: 1, roughness: 0,
    fontSize, fontFamily: options.fontFamily ?? 5, text: value, rawText: value,
    textAlign: options.align ?? "left", verticalAlign: "middle", containerId: null,
    originalText: value, autoResize: false, lineHeight: 1.25,
  };
  elements.push(item);
  return item;
}

function box(id, x, y, width, height, label, category, options = {}) {
  const palette = {
    llm: ["#7048e8", "#e5dbff"],
    algorithm: ["#1971c2", "#d0ebff"],
    store: ["#f08c00", "#fff3bf"],
    benchmark: ["#495057", "#e9ecef"],
    observer: ["#2b8a3e", "#d3f9d8"],
    answer: ["#087f5b", "#c3fae8"],
  };
  const [stroke, fill] = palette[category];
  const shape = options.shape ?? "rectangle";
  const item = { ...base(id, shape, x, y, width, height), strokeColor: stroke, backgroundColor: fill };
  if (options.dashed) item.strokeStyle = "dashed";
  item.groupIds = [`group-${id}`];
  elements.push(item);
  text(`${id}-label`, x + 12, y + 10, width - 24, label, {
    fontSize: options.fontSize ?? 16,
    align: "center",
    color: "#1e1e1e",
  }).groupIds = [`group-${id}`];
  boxes.set(id, item);
  return item;
}

function lane(id, y, height, title, subtitle) {
  const item = { ...base(id, "rectangle", 45, y, 1810, height), strokeColor: "#adb5bd", backgroundColor: "#f8f9fa", opacity: 52 };
  item.strokeStyle = "dashed";
  elements.push(item);
  text(`${id}-title`, 65, y + 14, 340, title, { fontSize: 22, color: "#343a40" });
  text(`${id}-subtitle`, 65, y + 46, 420, subtitle, { fontSize: 13, color: "#6c757d" });
}

function arrow(id, from, to, label, options = {}) {
  const source = boxes.get(from);
  const target = boxes.get(to);
  if (!source || !target) throw new Error(`unknown arrow endpoint ${from} -> ${to}`);
  const sx = source.x + source.width;
  const sy = source.y + source.height / 2;
  const tx = target.x;
  const ty = target.y + target.height / 2;
  const vertical = options.vertical === true;
  const startX = vertical ? source.x + source.width / 2 : sx;
  const startY = vertical ? source.y + source.height : sy;
  const endX = vertical ? target.x + target.width / 2 : tx;
  const endY = vertical ? target.y : ty;
  const absolutePoints = [[startX, startY], ...(options.via ?? []), [endX, endY]];
  const points = absolutePoints.map(([x, y]) => [x - startX, y - startY]);
  const item = {
    ...base(id, "arrow", startX, startY, endX - startX, endY - startY),
    strokeColor: options.color ?? "#495057", backgroundColor: "transparent",
    strokeStyle: options.dashed ? "dashed" : "solid", roundness: { type: 2 },
    points, lastCommittedPoint: null,
    startBinding: { elementId: from, focus: 0, gap: 5 },
    endBinding: { elementId: to, focus: 0, gap: 5 },
    startArrowhead: null, endArrowhead: "arrow", elbowed: false,
  };
  elements.push(item);
  source.boundElements.push({ id, type: "arrow" });
  target.boundElements.push({ id, type: "arrow" });
  if (label) {
    const lx = startX + (endX - startX) / 2 - 80;
    const ly = startY + (endY - startY) / 2 - 22;
    text(`${id}-label`, lx, ly, 160, label, { fontSize: 12, align: "center", color: options.color ?? "#495057", fontFamily: 3 });
  }
}

text("title", 55, 28, 1320, "Architecture 0003.1 — Semantic Memory + Evidence Projection", { fontSize: 34, color: "#212529" });
text("subtitle", 58, 78, 1360, "TypeScript LangGraph agent · YAML prompts · query-blind memory construction · no embeddings", { fontSize: 18, color: "#495057" });

box("legend-llm", 60, 120, 245, 54, "PURPLE · LLM call", "llm");
box("legend-alg", 325, 120, 270, 54, "BLUE · local algorithm", "algorithm");
box("legend-store", 615, 120, 255, 54, "AMBER · retained data", "store");
box("legend-benchmark", 890, 120, 270, 54, "GRAY · benchmark I/O", "benchmark");
box("legend-observer", 1180, 120, 270, 54, "GREEN · passive observer", "observer");

box("formula", 1475, 82, 365, 205,
  "LLM CALLS FOR N SESSIONS\n\nContexto  floor(N / B)\nShino       floor(N / C)\nAnswer      1\n\nTotal = floor(N/B) + floor(N/C) + 1\n\nSignal · evidence · replay = 0 LLM calls",
  "benchmark", { fontSize: 14 });

lane("runtime-lane", 310, 170, "0 · HARNESS + RUN HOST", "One host per benchmark run · isolated state and artifacts per case");
box("harness", 470, 354, 275, 82, "LongMemEval harness\nreset · ingest · answer", "benchmark");
box("node-host", 870, 354, 310, 82, "Node NDJSON host v1\nshared role semaphores", "algorithm");
box("case-state", 1310, 354, 310, 82, "Per-case LangGraph state\nartifact namespace", "algorithm");
arrow("a-harness-host", "harness", "node-host", "versioned RPC");
arrow("a-host-case", "node-host", "case-state", "dispatch concurrently");

lane("ingest-lane", 510, 255, "1 · EVERY SESSION — QUERY BLIND", "Zero model calls · archive the session and surface exact high-value user clauses");
box("sanitized-session", 245, 594, 225, 76, "Sanitized session\nfrom harness", "benchmark");
box("ingest", 565, 594, 245, 76, "ALG-1 ingestSession\narchive + count", "algorithm");
box("raw-archive", 900, 552, 250, 68, "Raw session archive", "store");
box("latest-tail", 900, 666, 250, 68, "Latest 9 raw sessions\nincludes partial B/C tail", "store");
box("signal-index", 1245, 565, 270, 94, "ALG-2 Personal Signal Index\nfirst-person · time · quantity · change", "algorithm", { fontSize: 15 });
box("signal-ledger", 1570, 565, 245, 94, "High-priority signal ledger\nexact · stable ID · unverified", "store");
arrow("a-session-ingest", "sanitized-session", "ingest", "one at a time");
arrow("a-ingest-archive", "ingest", "raw-archive", "append", { dashed: true, color: "#f08c00" });
arrow("a-ingest-tail", "ingest", "latest-tail", "retain", { dashed: true, color: "#f08c00" });
arrow("a-ingest-signals", "ingest", "signal-index", "scan user turns");
arrow("a-signals-ledger", "signal-index", "signal-ledger", "retain exact clauses", { dashed: true, color: "#f08c00" });

lane("construction-lane", 795, 385, "2 · MEMORY CONSTRUCTION — QUERY BLIND", "Contexto every complete B sessions · Shino every complete C sessions · partial tail never flushed");
box("b-router", 150, 900, 220, 78, "ALG-3 B cadence\ngraphUntracked ≥ B?", "algorithm");
box("contexto", 465, 886, 275, 106, "LLM-1 Mr. Contexto\nexactly B sessions + signal candidates\n+ compact semantic catalog", "llm", { fontSize: 15 });
box("mutation-gate", 835, 886, 285, 106, "ALG-4 Semantic Write Gate\nvalidate each update · salvage valid\nstable paths · current/history", "algorithm", { fontSize: 15 });
box("master-graph", 1215, 836, 290, 74, "Canonical master graph\nsemantic tree + provenance", "store");
box("diff-ledger", 1215, 944, 290, 74, "B-session mutation ledger\naccepted + rejected indices", "store");
box("c-router", 1585, 892, 225, 78, "ALG-5 C cadence\nsummaryUntracked ≥ C?", "algorithm");
box("shino", 1525, 1052, 285, 90, "LLM-2 Mr. Shino\nfull graph + C session IDs only", "llm");
box("summary-ledger", 1185, 1058, 265, 78, "C-session summary ledger", "store");
arrow("a-ingest-b", "ingest", "b-router", "after ingest", { vertical: true, via: [[687, 778], [260, 778]] });
arrow("a-b-contexto", "b-router", "contexto", "every complete B");
arrow("a-contexto-gate", "contexto", "mutation-gate", "typed semantic updates");
arrow("a-gate-graph", "mutation-gate", "master-graph", "commit revision", { dashed: true, color: "#f08c00" });
arrow("a-gate-diff", "mutation-gate", "diff-ledger", "record decisions", { dashed: true, color: "#f08c00" });
arrow("a-gate-c", "mutation-gate", "c-router", "mark B tracked");
arrow("a-c-shino", "c-router", "shino", "every complete C", { vertical: true });
arrow("a-shino-summary", "shino", "summary-ledger", "attach IDs + revision", { dashed: true, color: "#f08c00" });
arrow("a-signals-contexto", "signal-ledger", "contexto", "batch candidates", {
  vertical: true, dashed: true, color: "#f08c00", via: [[1692, 780], [602, 780]],
});

lane("answer-lane", 1210, 340, "3 · ONCE PER QUESTION", "Only this lane sees the question · one final LLM call · deterministic evidence preparation");
box("question", 65, 1320, 210, 78, "Question + question date", "benchmark");
box("projection", 350, 1308, 265, 102, "ALG-6 Question Evidence Projection\nlexical · canonical first\nconservative signal fallback", "algorithm", { fontSize: 15 });
box("assemble", 700, 1308, 285, 102, "ALG-7 Compact Context Builder\nprojection + graph + summaries\n+ diffs + latest 9", "algorithm", { fontSize: 15 });
box("final-answer", 1080, 1308, 235, 102, "LLM-3 Final Answerer\nstructured answer\nvalid-time reasoning", "llm");
box("map-result", 1400, 1308, 205, 102, "ALG-8 mapAnswerResult\nvalidate citations", "algorithm");
box("answer-result", 1670, 1308, 165, 102, "AnswerResult\nhypothesis\nevidence · trace", "answer");
box("dedupe", 65, 1442, 210, 76, "ALG-9 Provenance Deduplicator\nquery blind", "algorithm");
box("direct-evidence", 350, 1442, 265, 76, "Direct-evidence ledger\nexact excerpts + graph paths", "store");
box("memory-inputs", 700, 1442, 285, 76, "Retained memory inputs\ngraph · summaries · diffs · latest 9", "store");
box("final-context", 1080, 1442, 235, 76, "Final context artifact\nfull diagnostic package", "store");
arrow("a-question-projection", "question", "projection", "ask");
arrow("a-projection-assemble", "projection", "assemble", "ranked excerpts");
arrow("a-assemble-answer", "assemble", "final-answer", "compact prompt");
arrow("a-answer-map", "final-answer", "map-result", "validate");
arrow("a-map-result", "map-result", "answer-result", "return");
arrow("a-graph-dedupe", "master-graph", "dedupe", "canonical provenance", {
  vertical: true, dashed: true, color: "#f08c00", via: [[1360, 1192], [170, 1192]],
});
arrow("a-dedupe-direct", "dedupe", "direct-evidence", "one copy per source", { dashed: true, color: "#f08c00" });
arrow("a-direct-projection", "direct-evidence", "projection", "", {
  vertical: true, dashed: true, color: "#f08c00",
});
arrow("a-signal-projection", "signal-ledger", "projection", "", {
  vertical: true, dashed: true, color: "#f08c00", via: [[1828, 1188], [482, 1188]],
});
arrow("a-graph-memory-inputs", "master-graph", "memory-inputs", "", {
  vertical: true, dashed: true, color: "#f08c00", via: [[1360, 1200], [842, 1200]],
});
arrow("a-inputs-assemble", "memory-inputs", "assemble", "", {
  vertical: true, dashed: true, color: "#f08c00",
});
arrow("a-assemble-artifact", "assemble", "final-context", "write full context", {
  vertical: true, dashed: true, color: "#f08c00",
});

lane("external-lane", 1580, 165, "4 · EXTERNAL VALIDATION", "Not part of the memory architecture · one canonical call per completed question");
box("judge", 610, 1625, 300, 78, "External GPT-4o canonical judge", "benchmark", { dashed: true });
box("report", 1030, 1625, 270, 78, "Judgment + report", "benchmark");
arrow("a-result-judge", "answer-result", "judge", "answer + reference", { vertical: true, dashed: true, color: "#495057", via: [[1752, 1565], [760, 1565]] });
arrow("a-judge-report", "judge", "report", "score");

lane("observer-lane", 1775, 205, "5 · ARTIFACTS + REPLAY + MEMORY OBSERVATORY", "Passive read-only lane · zero additional LLM calls · browser closure cannot affect runs");
box("events", 120, 1840, 245, 78, "Hash-chained events\nmodel-call artifacts", "store");
box("replay-guard", 465, 1840, 285, 78, "ALG-10 Replay Guard\naccepted indices only · verify hash", "algorithm");
box("verified-graph", 850, 1840, 235, 78, "Verified graph replay\nexact final hash", "store");
box("hono", 1185, 1840, 225, 78, "Hono REST + SSE\n127.0.0.1 only", "observer");
box("observatory", 1510, 1828, 300, 102, "React / Cytoscape Observatory\ntree · diffs · evidence\nprompts · costs · replay", "observer", { fontSize: 15 });
arrow("a-events-replay", "events", "replay-guard", "reconstruct");
arrow("a-replay-verified", "replay-guard", "verified-graph", "hash match", { dashed: true, color: "#f08c00" });
arrow("a-events-hono", "events", "hono", "read + stream", { dashed: true, color: "#2b8a3e" });
arrow("a-hono-ui", "hono", "observatory", "SSE event IDs", { dashed: true, color: "#2b8a3e" });

text("cadence-strip", 65, 2015, 1760,
  "CADENCE    B3/C9: sessions 1–3 Ctx₁ · 4–6 Ctx₂ · 7–9 Ctx₃ + Shino₁    |    B9/C9: sessions 1–9 Ctx₁ + Shino₁    |    question: keep remainder raw → project evidence → answer",
  { fontSize: 16, align: "center", color: "#343a40", fontFamily: 3 });

const diagram = {
  type: "excalidraw",
  version: 2,
  source: "https://excalidraw.com",
  elements,
  appState: { gridSize: 20, gridStep: 5, gridModeEnabled: false, viewBackgroundColor: "#ffffff" },
  files: {},
};

const output = new URL("./0003-contexto-shino-langgraph.excalidraw", import.meta.url);
await writeFile(output, `${JSON.stringify(diagram, null, 2)}\n`, "utf8");
