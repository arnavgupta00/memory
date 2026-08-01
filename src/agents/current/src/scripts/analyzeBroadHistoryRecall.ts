/**
 * Offline sensitivity analysis for broad-history retrieval. This script never
 * calls a model: it replays stored facet plans against the frozen notes/raw
 * views and reports gold recall as candidate depth and pool size change.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadArchitectureCases } from "../benchmarks/architectureDataset.js";
import { Bm25Index } from "../retrieval/bm25.js";
import {
  buildNotesDocuments,
  loadAnnotations,
} from "../retrieval/notesIndex.js";
import type { RetrievalDocument } from "../retrieval/types.js";

type QueryLane = { query: string; facet_ids: string[] };
type StoredPlan = {
  facets: Array<{ id: string }>;
  queries: QueryLane[];
};
type StoredCase = {
  question_id: string;
  question_type: string;
  gold: string[];
  trace: Array<{ plan?: StoredPlan }>;
};
type StoredRun = { cases: StoredCase[] };

const PROJECT_ROOT = resolve(import.meta.dirname, "../../../../../");
const RUN_ROOT = resolve(
  PROJECT_ROOT,
  "runs/beam-1m-canary-a-architecture-0008-20260731-r2",
);

function roleDocuments(
  sessionIds: string[],
  dates: string[],
  sessions: Array<Array<{ role: string; content: string }>>,
  role: "user" | "assistant" | "all",
): RetrievalDocument[] {
  return sessionIds.map((sessionId, index) => {
    const turns = sessions[index] ?? [];
    const text = turns
      .filter((turn) => role === "all" || turn.role === role)
      .map((turn) => turn.content)
      .join("\n");
    return {
      id: sessionId,
      sessionId,
      date: dates[index] ?? "",
      text,
      startTurn: 0,
      endTurn: Math.max(turns.length - 1, 0),
    };
  });
}

function recall(ids: string[], gold: string[]): number {
  if (gold.length === 0) return 0;
  const found = new Set(ids);
  return gold.filter((id) => found.has(id)).length / gold.length;
}

const dataset = loadArchitectureCases(resolve(RUN_ROOT, "input/dataset.json"));
const byId = new Map(dataset.map((item) => [item.question_id, item]));
const annotations = loadAnnotations(resolve(RUN_ROOT, "annotations"));
const stored = JSON.parse(
  readFileSync(resolve(RUN_ROOT, "retrieval/hybrid.json"), "utf8"),
) as StoredRun;
const broad = stored.cases.filter(
  (item) => item.question_type === "event_ordering" || item.question_type === "summarization",
);
const configurations = [
  { topK: 10, poolMax: 24 },
  { topK: 20, poolMax: 48 },
  { topK: 30, poolMax: 48 },
  { topK: 30, poolMax: 96 },
  { topK: 50, poolMax: 96 },
  { topK: 50, poolMax: 192 },
  { topK: 100, poolMax: 384 },
];

const summaries = configurations.map(() => new Map<string, number[]>());
for (const item of broad) {
  const raw = byId.get(item.question_id);
  const plan = item.trace[0]?.plan;
  if (!raw || !plan) throw new Error(`missing raw case or plan: ${item.question_id}`);
  const views = [
    new Bm25Index(buildNotesDocuments({
      sessionIds: raw.haystack_session_ids,
      datesBySessionId: new Map(
        raw.haystack_session_ids.map((id, index) => [id, raw.haystack_dates[index] ?? ""]),
      ),
      annotations,
    })),
    new Bm25Index(roleDocuments(
      raw.haystack_session_ids,
      raw.haystack_dates,
      raw.haystack_sessions,
      "user",
    )),
    new Bm25Index(roleDocuments(
      raw.haystack_session_ids,
      raw.haystack_dates,
      raw.haystack_sessions,
      "assistant",
    )),
    new Bm25Index(roleDocuments(
      raw.haystack_session_ids,
      raw.haystack_dates,
      raw.haystack_sessions,
      "all",
    )),
  ];
  const lanes: QueryLane[] = [
    { query: raw.question, facet_ids: plan.facets.map((facet) => facet.id) },
    ...plan.queries,
  ];
  const ranked = views.flatMap((view) =>
    lanes.flatMap((lane) => view.search(lane.query, 100))
  );
  for (let index = 0; index < configurations.length; index += 1) {
    const configuration = configurations[index];
    const summary = summaries[index];
    if (!configuration || !summary) continue;
    const scores = new Map<string, number>();
    for (const hit of ranked) {
      if (hit.rank > configuration.topK) continue;
      scores.set(hit.documentId, (scores.get(hit.documentId) ?? 0) + 1 / (60 + hit.rank));
    }
    const pool = [...scores.entries()]
      .sort(([leftId, left], [rightId, right]) => right - left || leftId.localeCompare(rightId))
      .slice(0, configuration.poolMax)
      .map(([id]) => id);
    const values = summary.get(item.question_type) ?? [];
    values.push(recall(pool, item.gold));
    summary.set(item.question_type, values);
  }
}
for (let index = 0; index < configurations.length; index += 1) {
  const configuration = configurations[index];
  const summary = summaries[index];
  if (!configuration || !summary) continue;
  const values = Object.fromEntries(
    [...summary].map(([type, scores]) => [
      type,
      scores.reduce((sum, value) => sum + value, 0) / scores.length,
    ]),
  );
  console.log(JSON.stringify({ ...configuration, ...values }));
}
