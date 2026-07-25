import { writeFile } from "node:fs/promises";

const elements = [];
const nodes = new Map();
let sequence = 0;
const updated = 1784851200000;

const palette = {
  llm: { stroke: "#6741d9", fill: "#e5dbff" },
  algorithm: { stroke: "#1864ab", fill: "#d0ebff" },
  store: { stroke: "#e67700", fill: "#fff3bf" },
  benchmark: { stroke: "#495057", fill: "#e9ecef" },
  observer: { stroke: "#087f5b", fill: "#c3fae8" },
  output: { stroke: "#0b7285", fill: "#c5f6fa" },
  warning: { stroke: "#c92a2a", fill: "#ffe3e3" },
};

function base(id, type, x, y, width, height) {
  sequence += 1;
  return {
    id,
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: `a${String(sequence).padStart(5, "0")}`,
    roundness: type === "rectangle" ? { type: 3 } : null,
    seed: 1139 + sequence * 101,
    version: 1,
    versionNonce: 7919 + sequence * 131,
    isDeleted: false,
    boundElements: [],
    updated,
    link: null,
    locked: false,
  };
}

function addText(id, x, y, width, value, options = {}) {
  const fontSize = options.fontSize ?? 18;
  const lines = value.split("\n").length;
  const height = Math.max(fontSize * 1.25, lines * fontSize * 1.28);
  const element = {
    ...base(id, "text", x, y, width, height),
    strokeColor: options.color ?? "#212529",
    strokeWidth: 1,
    roughness: 0,
    fontSize,
    fontFamily: options.fontFamily ?? 5,
    text: value,
    rawText: value,
    textAlign: options.align ?? "left",
    verticalAlign: "middle",
    containerId: null,
    originalText: value,
    autoResize: false,
    lineHeight: 1.28,
  };
  if (options.groupId) element.groupIds = [options.groupId];
  elements.push(element);
  return element;
}

function addNode(id, x, y, width, height, label, category, options = {}) {
  const colors = palette[category];
  if (!colors) throw new Error(`Unknown category: ${category}`);
  const type = options.shape ?? "rectangle";
  const element = {
    ...base(id, type, x, y, width, height),
    strokeColor: colors.stroke,
    backgroundColor: colors.fill,
    strokeWidth: options.strokeWidth ?? 2,
    strokeStyle: options.dashed ? "dashed" : "solid",
    roundness: type === "rectangle" ? { type: 3 } : null,
    groupIds: [`group-${id}`],
  };
  elements.push(element);
  addText(`${id}-label`, x + 14, y + 10, width - 28, label, {
    fontSize: options.fontSize ?? 16,
    align: "center",
    color: options.textColor ?? "#212529",
    fontFamily: options.fontFamily ?? 5,
    groupId: `group-${id}`,
  });
  nodes.set(id, element);
  return element;
}

function addPanel(id, x, y, width, height, title, subtitle, options = {}) {
  const element = {
    ...base(id, "rectangle", x, y, width, height),
    strokeColor: options.stroke ?? "#adb5bd",
    backgroundColor: options.fill ?? "#f8f9fa",
    opacity: options.opacity ?? 65,
    strokeWidth: options.strokeWidth ?? 2,
    strokeStyle: options.dashed ? "dashed" : "solid",
    roundness: { type: 3 },
  };
  elements.push(element);
  addText(`${id}-title`, x + 22, y + 14, width - 44, title, {
    fontSize: options.titleSize ?? 22,
    color: options.titleColor ?? "#343a40",
  });
  if (subtitle) {
    addText(`${id}-subtitle`, x + 22, y + 48, width - 44, subtitle, {
      fontSize: options.subtitleSize ?? 13,
      color: "#6c757d",
      fontFamily: 3,
    });
  }
  return element;
}

function addLane(id, y, height, number, title, subtitle) {
  addPanel(
    id,
    45,
    y,
    3420,
    height,
    `${number}  ${title}`,
    subtitle,
    { dashed: true, opacity: 48, titleSize: 23 },
  );
}

function anchor(node, side) {
  switch (side) {
    case "left":
      return [node.x, node.y + node.height / 2];
    case "right":
      return [node.x + node.width, node.y + node.height / 2];
    case "top":
      return [node.x + node.width / 2, node.y];
    case "bottom":
      return [node.x + node.width / 2, node.y + node.height];
    default:
      throw new Error(`Unknown side: ${side}`);
  }
}

function addArrow(id, fromId, toId, label, options = {}) {
  const from = nodes.get(fromId);
  const to = nodes.get(toId);
  if (!from || !to) throw new Error(`Unknown endpoint: ${fromId} -> ${toId}`);
  const startSide = options.startSide ?? "right";
  const endSide = options.endSide ?? "left";
  const [startX, startY] = anchor(from, startSide);
  const [endX, endY] = anchor(to, endSide);
  const absolutePoints = [
    [startX, startY],
    ...(options.via ?? []),
    [endX, endY],
  ];
  const points = absolutePoints.map(([x, y]) => [x - startX, y - startY]);
  const arrow = {
    ...base(id, "arrow", startX, startY, endX - startX, endY - startY),
    strokeColor: options.color ?? "#495057",
    strokeStyle: options.dashed ? "dashed" : "solid",
    strokeWidth: options.strokeWidth ?? 2,
    roundness: { type: 2 },
    points,
    lastCommittedPoint: null,
    startBinding: { elementId: fromId, focus: 0, gap: 5 },
    endBinding: { elementId: toId, focus: 0, gap: 5 },
    startArrowhead: null,
    endArrowhead: "arrow",
    elbowed: false,
  };
  elements.push(arrow);
  from.boundElements.push({ id, type: "arrow" });
  to.boundElements.push({ id, type: "arrow" });

  if (label) {
    const labelX = options.labelX ?? startX + (endX - startX) / 2 - 95;
    const labelY = options.labelY ?? startY + (endY - startY) / 2 - 22;
    addText(`${id}-label`, labelX, labelY, options.labelWidth ?? 190, label, {
      fontSize: options.labelSize ?? 12,
      align: "center",
      color: options.color ?? "#495057",
      fontFamily: 3,
    });
  }
}

// Header and direct-reading key.
addText(
  "title",
  55,
  28,
  1850,
  "Architecture 0003.2 — Hybrid Graph Reader Repair",
  { fontSize: 36, color: "#212529" },
);
addText(
  "subtitle",
  58,
  80,
  2200,
  "TypeScript LangGraph · query-blind Contexto/Shino · lossless lexical safety plane · no embeddings · compact evidence-only answer",
  { fontSize: 18, color: "#495057" },
);

addNode("legend-llm", 60, 125, 255, 54, "PURPLE  ·  LLM CALL", "llm", { fontSize: 14 });
addNode("legend-alg", 335, 125, 285, 54, "BLUE  ·  LOCAL ALGORITHM", "algorithm", { fontSize: 14 });
addNode("legend-store", 640, 125, 280, 54, "AMBER  ·  RETAINED STORE", "store", { fontSize: 14 });
addNode("legend-benchmark", 940, 125, 285, 54, "GRAY  ·  BENCHMARK I/O", "benchmark", { fontSize: 14 });
addNode("legend-observer", 1245, 125, 285, 54, "GREEN  ·  PASSIVE OBSERVER", "observer", { fontSize: 14 });
addNode("legend-output", 1550, 125, 255, 54, "CYAN  ·  AGENT OUTPUT", "output", { fontSize: 14 });

addNode(
  "call-formula",
  2790,
  42,
  630,
  214,
  "MODEL-CALL LEDGER — FOR N SESSIONS\n\nContexto: floor(N / B)   · every complete B\nShino:       floor(N / C)   · every complete C\nReader:      1                   · once per question\nAnswer:      1                   · once per question\n\nTOTAL AGENT LLM CALLS = floor(N/B) + floor(N/C) + 2\nExternal canonical judge = 1 separate LLM call",
  "benchmark",
  { fontSize: 15, strokeWidth: 3 },
);
addText(
  "no-token-note",
  1860,
  137,
  850,
  "Solid arrows = control flow   ·   dashed arrows = retained-data read/write\nAll blue, amber, and green operations are local and add zero model-token calls.",
  { fontSize: 14, color: "#495057", fontFamily: 3, align: "center" },
);

addPanel(
  "cadence-strip",
  60,
  278,
  3360,
  105,
  "CADENCE MAP",
  "",
  { fill: "#fff9db", stroke: "#f08c00", opacity: 100, titleSize: 18 },
);
addText(
  "cadence-strip-flow",
  96,
  323,
  3288,
  "Every session: archive + index  →  Every complete B: Contexto + coverage  →  Every complete C: Shino  →  Question arrives: keep partial tail raw → retrieve → Reader → Answer\nB3/C9 example: 1–3 Ctx₁ · 4–6 Ctx₂ · 7–9 Ctx₃ + Shino₁     |     no partial B/C flush     |     Reader and Answer run exactly once",
  { fontSize: 16, color: "#5f3d00", fontFamily: 3, align: "center" },
);

// Harness and isolation.
addLane(
  "lane-host",
  410,
  160,
  "0",
  "HARNESS + ISOLATED CASE HOST",
  "Stable Python benchmark lifecycle outside the memory design; one isolated LangGraph state and artifact namespace per case.",
);
addNode("harness", 510, 468, 330, 76, "LongMemEval harness\nreset · ingest · answer", "benchmark");
addNode("node-host", 1170, 468, 350, 76, "Node NDJSON host\nrun-global role limits", "algorithm");
addNode("case-state", 1845, 468, 350, 76, "Per-case LangGraph state\nquery-isolated memory", "algorithm");
addNode("artifact-namespace", 2520, 468, 360, 76, "Per-case artifact namespace\nappend-only + replayable", "store");
addArrow("arrow-harness-host", "harness", "node-host", "versioned RPC");
addArrow("arrow-host-case", "node-host", "case-state", "dispatch concurrently");
addArrow("arrow-case-artifacts", "case-state", "artifact-namespace", "persist events", {
  dashed: true,
  color: palette.store.stroke,
});

// Every-session lane.
addLane(
  "lane-session",
  600,
  240,
  "1",
  "EVERY SANITIZED SESSION — QUERY BLIND",
  "N local ingestions for N sessions. Assistant messages are retained; no LLM is called in this lane.",
);
addNode("sanitized-session", 220, 688, 300, 84, "Sanitized timestamped session\nuser + assistant turns", "benchmark");
addNode("ingest-session", 700, 688, 330, 84, "ALG-1  ingestSession\narchive · count · stable session ID", "algorithm", { fontSize: 14 });
addNode("raw-archive", 1250, 654, 310, 72, "Raw Session Archive\ncomplete role-tagged sessions", "store");
addNode("session-index-store", 1250, 746, 310, 72, "Session Search Documents\nUnicode + snake_case tokens", "store");
addNode("tail-store", 1810, 688, 340, 84, "Unprocessed B-session Tail\nlossless question-time fallback", "store");
addNode("b-counters", 2380, 688, 340, 84, "ALG-2  cadence counters\ngraphUntracked · summaryUntracked", "algorithm");
addNode("session-event", 2920, 688, 300, 84, "Session-ingested event\nhash chained", "store");
addArrow("arrow-session-ingest", "sanitized-session", "ingest-session", "ingest once");
addArrow("arrow-ingest-raw", "ingest-session", "raw-archive", "append", {
  dashed: true,
  color: palette.store.stroke,
  labelY: 650,
});
addArrow("arrow-ingest-index", "ingest-session", "session-index-store", "index complete session", {
  dashed: true,
  color: palette.store.stroke,
  labelY: 782,
});
addArrow("arrow-index-tail", "session-index-store", "tail-store", "retain remainder", {
  dashed: true,
  color: palette.store.stroke,
});
addArrow("arrow-tail-counters", "tail-store", "b-counters", "increment");
addArrow("arrow-counter-event", "b-counters", "session-event", "record", {
  dashed: true,
  color: palette.store.stroke,
});

// Query-blind memory construction.
addLane(
  "lane-construction",
  870,
  420,
  "2",
  "MEMORY CONSTRUCTION — EVERY COMPLETE B AND C SESSIONS",
  "Contexto and Shino never see the benchmark question. Missing graph facts remain reachable through the raw-session index.",
);
addNode("b-router", 145, 990, 280, 88, "ALG-3  B cadence router\ngraphUntracked ≥ B?", "algorithm");
addNode(
  "contexto",
  540,
  974,
  360,
  120,
  "LLM-1  MR. CONTEXTO\nexactly B sessions\natomic facts · time · quantity · updates",
  "llm",
  { fontSize: 14, strokeWidth: 3 },
);
addNode(
  "mutation-gate",
  1015,
  974,
  360,
  120,
  "ALG-4  Typed Mutation Gate\nschema · naming · provenance · $ref\natomic accept/reject + current/history",
  "algorithm",
  { fontSize: 15 },
);
addNode(
  "coverage-audit",
  1490,
  974,
  360,
  120,
  "ALG-5  Contexto Coverage Audit\ngraph_covered · duplicate\nsession_index_fallback",
  "algorithm",
  { fontSize: 15 },
);
addNode("master-graph", 1970, 922, 330, 82, "Canonical Master Graph\nsemantic JSON + provenance", "store");
addNode("mutation-ledger", 1970, 1030, 330, 82, "B-session Mutation Ledger\naccepted · rejected · graph hash", "store");
addNode("coverage-store", 1970, 1138, 330, 82, "Coverage / Fallback Ledger\nexact high-priority signals", "store");
addNode("c-router", 2430, 974, 280, 120, "ALG-6  C cadence router\nsummaryUntracked ≥ C?\nC ≥ B · C % B = 0", "algorithm");
addNode(
  "shino",
  2825,
  974,
  330,
  120,
  "LLM-2  MR. SHINO\nfull graph + C session IDs\nno raw sessions · no diff log",
  "llm",
  { fontSize: 15, strokeWidth: 3 },
);
addNode("summary-ledger", 2825, 1138, 330, 82, "C-session Summary Ledger\nsession IDs + graph revision", "store");

addArrow("arrow-counter-b", "b-counters", "b-router", "every completed ingest", {
  startSide: "bottom",
  endSide: "top",
  via: [[2550, 858], [285, 858]],
  labelX: 1260,
  labelY: 842,
  labelWidth: 270,
});
addArrow("arrow-b-contexto", "b-router", "contexto", "if complete B");
addArrow("arrow-contexto-mutation", "contexto", "mutation-gate", "typed operations");
addArrow("arrow-mutation-coverage", "mutation-gate", "coverage-audit", "accepted state");
addArrow("arrow-coverage-graph", "coverage-audit", "master-graph", "commit revision", {
  dashed: true,
  color: palette.store.stroke,
  endSide: "left",
  labelY: 920,
});
addArrow("arrow-coverage-mutations", "coverage-audit", "mutation-ledger", "record diff + warnings", {
  dashed: true,
  color: palette.store.stroke,
  endSide: "left",
  labelY: 1085,
});
addArrow("arrow-coverage-fallback", "coverage-audit", "coverage-store", "index uncovered signals", {
  dashed: true,
  color: palette.store.stroke,
  endSide: "left",
  labelY: 1176,
});
addArrow("arrow-coverage-c", "coverage-audit", "c-router", "mark B tracked", {
  via: [[1895, 953], [2360, 953], [2360, 1034]],
  labelX: 2070,
  labelY: 927,
});
addArrow("arrow-c-shino", "c-router", "shino", "if complete C");
addArrow("arrow-shino-ledger", "shino", "summary-ledger", "store summary", {
  startSide: "bottom",
  endSide: "top",
  dashed: true,
  color: palette.store.stroke,
});

// Question-time retrieval and reading.
addLane(
  "lane-question",
  1320,
  650,
  "3",
  "ONCE PER QUESTION — RETRIEVE → READ → ANSWER",
  "The raw-session BM25 plane is lossless. Graph paths and summaries expand retrieval keys; they never replace source turns.",
);
addNode("question", 110, 1510, 260, 92, "Question + question date", "benchmark");
addNode(
  "build-documents",
  465,
  1510,
  330,
  92,
  "ALG-7  Build Query + Memory Docs\nrole tags · provenance expansion\ntemporal terms are boosts, not filters",
  "algorithm",
  { fontSize: 14 },
);

addPanel(
  "retrieval-panel",
  900,
  1395,
  790,
  425,
  "HYBRID LOCAL RETRIEVAL — ZERO EMBEDDINGS",
  "Five independent channels · BM25 k1=1.2, b=0.75 · stable tie-breaking",
  { fill: "#e7f5ff", stroke: "#1971c2", opacity: 100, titleSize: 19 },
);
addNode("channel-sessions", 945, 1475, 315, 86, "CHANNEL 1\nComplete full-session BM25\nuser + assistant turns", "algorithm", { fontSize: 14 });
addNode("channel-graph", 1300, 1475, 315, 86, "CHANNEL 2\nGraph memory cells\npaths + current/history + provenance", "algorithm", { fontSize: 14 });
addNode("channel-summaries", 945, 1590, 315, 86, "CHANNEL 3\nShino summary BM25\nsecondary memory view", "algorithm", { fontSize: 14 });
addNode("channel-coverage", 1300, 1590, 315, 86, "CHANNEL 4\nCoverage fallback signals\nuncovered Contexto facts", "algorithm", { fontSize: 14 });
addNode("channel-tail", 1120, 1705, 315, 86, "CHANNEL 5\nUnprocessed B-session tail\ncomplete raw sessions", "algorithm", { fontSize: 14 });

addNode(
  "candidate-union",
  1785,
  1490,
  315,
  132,
  "ALG-8  Stable Candidate Union\n≤12 sessions · ≤12 graph cells\n≤4 summaries · ≤4 fallbacks",
  "algorithm",
  { fontSize: 15 },
);
addNode(
  "reader",
  2200,
  1480,
  315,
  152,
  "LLM-3  DEDICATED READER\nselect support · resolve conflicts\nanswer mode · facts · provenance\n≤8 sessions · ≤12 graph pointers",
  "llm",
  { fontSize: 15, strokeWidth: 3 },
);
addNode(
  "reader-safety",
  2615,
  1480,
  315,
  152,
  "ALG-9  Reader Plan Safety\nremove unknown references\nforce insufficient if ungrounded\nexpand selected + adjacent turns",
  "algorithm",
  { fontSize: 15 },
);
addNode(
  "compact-context",
  3030,
  1480,
  315,
  152,
  "ALG-10  Compact Context Compiler\nwhole evidence items only\nselected raw turns first\nno complete graph / arbitrary latest",
  "algorithm",
  { fontSize: 14 },
);

addNode(
  "answer-model",
  2200,
  1745,
  315,
  126,
  "LLM-4  FINAL ANSWERER\nreader plan + selected evidence\nstructured compact answer",
  "llm",
  { fontSize: 15, strokeWidth: 3 },
);
addNode(
  "answer-safety",
  2615,
  1745,
  315,
  126,
  "ALG-11  Answer Safety + Mapper\nremove unknown / duplicate citations\nreject restatement or unsupported claim",
  "algorithm",
  { fontSize: 13 },
);
addNode(
  "answer-result",
  3030,
  1745,
  315,
  126,
  "AnswerResult\nhypothesis · evidence · trace\nsupported / conflicted / insufficient",
  "output",
  { fontSize: 13, strokeWidth: 3 },
);

addArrow("arrow-question-docs", "question", "build-documents", "prepare");
addArrow("arrow-docs-sessions", "build-documents", "channel-sessions", "search", {
  endSide: "left",
  labelY: 1450,
});
addArrow("arrow-docs-graph", "build-documents", "channel-graph", "search", {
  endSide: "left",
  via: [[845, 1434], [1275, 1434]],
  labelX: 1010,
  labelY: 1410,
});
addArrow("arrow-docs-summaries", "build-documents", "channel-summaries", "search", {
  endSide: "left",
  via: [[850, 1650]],
  labelX: 760,
  labelY: 1628,
});
addArrow("arrow-docs-coverage", "build-documents", "channel-coverage", "search", {
  endSide: "left",
  via: [[850, 1687], [1275, 1687]],
  labelX: 1040,
  labelY: 1664,
});
addArrow("arrow-docs-tail", "build-documents", "channel-tail", "search", {
  endSide: "left",
  via: [[850, 1762], [1095, 1762]],
  labelX: 930,
  labelY: 1738,
});

for (const [channel, offset] of [
  ["channel-sessions", -52],
  ["channel-graph", -28],
  ["channel-summaries", 28],
  ["channel-coverage", 52],
  ["channel-tail", 76],
]) {
  addArrow(`arrow-${channel}-union`, channel, "candidate-union", "", {
    startSide: "right",
    endSide: "left",
    via: [[1735, 1556 + offset]],
    strokeWidth: 1,
  });
}
addArrow("arrow-union-reader", "candidate-union", "reader", "bounded candidates");
addArrow("arrow-reader-safety", "reader", "reader-safety", "structured ReaderPlan");
addArrow("arrow-safety-compact", "reader-safety", "compact-context", "selected evidence");
addArrow("arrow-compact-answer", "compact-context", "answer-model", "evidence-only prompt", {
  startSide: "bottom",
  endSide: "top",
  via: [[3188, 1686], [2358, 1686]],
  labelX: 2700,
  labelY: 1662,
});
addArrow("arrow-answer-safety", "answer-model", "answer-safety", "structured answer");
addArrow("arrow-safety-result", "answer-safety", "answer-result", "map");

// Visible retained-data reads into retrieval.
addArrow("read-raw-sessions", "raw-archive", "channel-sessions", "read exact sessions", {
  startSide: "bottom",
  endSide: "top",
  via: [[1405, 1320], [1102, 1320]],
  dashed: true,
  color: palette.store.stroke,
  labelX: 1140,
  labelY: 1296,
});
addArrow("read-master-graph", "master-graph", "channel-graph", "read cells + provenance", {
  startSide: "bottom",
  endSide: "top",
  via: [[2135, 1350], [1458, 1350]],
  dashed: true,
  color: palette.store.stroke,
  labelX: 1680,
  labelY: 1326,
});
addArrow("read-summary-ledger", "summary-ledger", "channel-summaries", "read summaries", {
  startSide: "bottom",
  endSide: "top",
  via: [[2990, 1370], [1102, 1370]],
  dashed: true,
  color: palette.store.stroke,
  labelX: 1960,
  labelY: 1346,
});
addArrow("read-coverage-ledger", "coverage-store", "channel-coverage", "read fallbacks", {
  startSide: "bottom",
  endSide: "top",
  via: [[2135, 1390], [1458, 1390]],
  dashed: true,
  color: palette.store.stroke,
  labelX: 1690,
  labelY: 1366,
});
addArrow("read-tail", "tail-store", "channel-tail", "read partial remainder", {
  startSide: "bottom",
  endSide: "top",
  via: [[1980, 1410], [1278, 1410]],
  dashed: true,
  color: palette.store.stroke,
  labelX: 1515,
  labelY: 1386,
});

// External validation.
addLane(
  "lane-judge",
  2000,
  180,
  "4",
  "EXTERNAL BENCHMARK VALIDATION",
  "Not part of the memory architecture. One canonical judge call per completed question; its cost is reported separately.",
);
addNode("reference-answer", 570, 2070, 310, 76, "Reference answer\nbenchmark-only secret", "benchmark", { dashed: true });
addNode(
  "canonical-judge",
  1420,
  2060,
  390,
  96,
  "JUDGE-1  Canonical GPT-4o Judge\nAnswerResult + reference answer",
  "benchmark",
  { dashed: true, fontSize: 15, strokeWidth: 3 },
);
addNode("judgment-report", 2370, 2070, 340, 76, "Official judgment + report", "benchmark");
addArrow("arrow-reference-judge", "reference-answer", "canonical-judge", "judge only", { dashed: true });
addArrow("arrow-result-judge", "answer-result", "canonical-judge", "completed answer", {
  startSide: "bottom",
  endSide: "top",
  via: [[3188, 1978], [1615, 1978]],
  dashed: true,
  labelX: 2270,
  labelY: 1954,
});
addArrow("arrow-judge-report", "canonical-judge", "judgment-report", "score");

// Passive observability.
addLane(
  "lane-observer",
  2210,
  310,
  "5",
  "ARTIFACT REPLAY + MEMORY OBSERVATORY — ZERO ADDITIONAL LLM CALLS",
  "Read-only observer: closing the browser cannot stop or alter a run. Legacy runs degrade to explicit empty states.",
);
addNode(
  "artifact-store",
  170,
  2310,
  420,
  104,
  "Retained Case Artifacts\nevents · graph · coverage · candidates\nReaderPlan · compact context · calls",
  "store",
  { fontSize: 15 },
);
addNode(
  "replay-validator",
  760,
  2310,
  390,
  104,
  "ALG-12  Deterministic Replay\nhash chain · graph hash · cached-call keys\nprompt/schema/model/input match",
  "algorithm",
  { fontSize: 15 },
);
addNode(
  "observer-api",
  1330,
  2310,
  350,
  104,
  "Hono REST + SSE\n127.0.0.1 · allowlisted read-only paths\nresume from event ID",
  "observer",
  { fontSize: 14 },
);
addNode(
  "observer-funnel",
  1870,
  2295,
  680,
  134,
  "MEMORY OBSERVATORY FUNNEL\nContexto coverage  →  retrieval channels  →  Reader selection  →  compact answer\nprompts · evidence · conflicts · tokens · latency · retries · cost",
  "observer",
  { fontSize: 14, strokeWidth: 3 },
);
addNode(
  "observer-exports",
  2730,
  2310,
  410,
  104,
  "Replay + Export\nbatch graph · provenance · before/after diff\nfinal SVG/PNG · legacy-safe views",
  "observer",
  { fontSize: 15 },
);
addArrow("arrow-artifacts-replay", "artifact-store", "replay-validator", "reconstruct");
addArrow("arrow-replay-api", "replay-validator", "observer-api", "verified state", {
  dashed: true,
  color: palette.observer.stroke,
});
addArrow("arrow-api-funnel", "observer-api", "observer-funnel", "read + stream", {
  dashed: true,
  color: palette.observer.stroke,
});
addArrow("arrow-funnel-export", "observer-funnel", "observer-exports", "inspect / export", {
  dashed: true,
  color: palette.observer.stroke,
});
addArrow("arrow-case-observer-artifacts", "artifact-namespace", "artifact-store", "observe immutable artifacts", {
  startSide: "bottom",
  endSide: "top",
  via: [[3385, 584], [3385, 2190], [380, 2190]],
  dashed: true,
  color: palette.observer.stroke,
  labelX: 1510,
  labelY: 2166,
  labelWidth: 300,
});

addPanel(
  "footer",
  60,
  2550,
  3360,
  112,
  "DESIGN INVARIANTS",
  "",
  { fill: "#f8f9fa", stroke: "#868e96", opacity: 100, titleSize: 17 },
);
addText(
  "footer-copy",
  95,
  2593,
  3290,
  "Query blind until retrieval  ·  no embeddings  ·  no hidden repair or answer retry  ·  no partial Contexto/Shino flush  ·  raw sessions remain the lossless safety plane\nDynamic graph improves structure; deterministic retrieval protects recall; Reader isolates evidence; compact Answer minimizes distraction.",
  { fontSize: 16, color: "#343a40", fontFamily: 3, align: "center" },
);

function validateDiagram() {
  const ids = new Set();
  for (const element of elements) {
    if (ids.has(element.id)) throw new Error(`Duplicate element ID: ${element.id}`);
    ids.add(element.id);
  }

  const elementById = new Map(elements.map((element) => [element.id, element]));
  const arrows = elements.filter((element) => element.type === "arrow");
  for (const arrow of arrows) {
    const source = arrow.startBinding?.elementId;
    const target = arrow.endBinding?.elementId;
    if (!source || !target || !elementById.has(source) || !elementById.has(target)) {
      throw new Error(`Broken arrow binding: ${arrow.id} (${source} -> ${target})`);
    }
    if (arrow.points.length < 2) throw new Error(`Arrow ${arrow.id} has fewer than two points`);
    const sourceBound = elementById
      .get(source)
      .boundElements.some((bound) => bound.id === arrow.id && bound.type === "arrow");
    const targetBound = elementById
      .get(target)
      .boundElements.some((bound) => bound.id === arrow.id && bound.type === "arrow");
    if (!sourceBound || !targetBound) throw new Error(`Incomplete boundElements for ${arrow.id}`);
  }

  const requiredCopy = [
    "floor(N/B) + floor(N/C) + 2",
    "Complete full-session BM25",
    "Graph memory cells",
    "Shino summary BM25",
    "Coverage fallback signals",
    "Unprocessed B-session tail",
    "DEDICATED READER",
    "Canonical GPT-4o Judge",
    "Contexto coverage  →  retrieval channels  →  Reader selection  →  compact answer",
  ];
  const allText = elements
    .filter((element) => element.type === "text")
    .map((element) => element.text)
    .join("\n");
  for (const phrase of requiredCopy) {
    if (!allText.includes(phrase)) throw new Error(`Missing required diagram copy: ${phrase}`);
  }

  return {
    elementCount: elements.length,
    arrowCount: arrows.length,
    nodeCount: nodes.size,
  };
}

const validation = validateDiagram();
const diagram = {
  type: "excalidraw",
  version: 2,
  source: "https://excalidraw.com",
  elements,
  appState: {
    gridSize: 20,
    gridStep: 5,
    gridModeEnabled: false,
    viewBackgroundColor: "#ffffff",
  },
  files: {},
};

const output = new URL("./0003.2-hybrid-graph-reader.excalidraw", import.meta.url);
await writeFile(output, `${JSON.stringify(diagram, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output: output.pathname, ...validation }, null, 2));
