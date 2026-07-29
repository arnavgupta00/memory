/**
 * Offline U-WINDOW gate: compare gold-turn-in-span recall at windowTurns=2 vs 5
 * on a focused question-id list (or canary-1).
 *
 * Usage:
 *   pnpm --dir src/agents/current exec node --import tsx src/scripts/uwindowOfflineGate.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { retrieveMemory } from "../retrieval/index.js";
import type { TimestampedSession, Turn } from "../types.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const DATASET_PATH = resolve(PROJECT_ROOT, "data/raw/longmemeval_s_cleaned.json");
const ORACLE_PATH = resolve(PROJECT_ROOT, "data/raw/longmemeval_oracle.json");
const OUT_PATH = resolve(PROJECT_ROOT, "runs/local-archive/uwindow-offline-gate.json");

const SLICE = [
  "75832dbd",
  "92a0aa75",
  "a08a253f",
  "gpt4_2f8be40d",
  "gpt4_7f6b06db",
  "gpt4_d6585ce9",
  "0ddfec37",
  "129d1232",
  "2318644b",
  "28dc39ac",
  "2ce6a0f2",
  "36b9f61e",
  "031748ae_abs",
  "0862e8bf_abs",
  "0ddfec37_abs",
  "a96c20ee_abs",
  "031748ae",
  "078150f1",
  "099778bb",
  "0bb5a684",
] as const;

type RawTurn = { role: "user" | "assistant"; content: string; has_answer?: boolean };
type RawCase = {
  question_id: string;
  question_type: string;
  question: string;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: RawTurn[][];
};

function toSessions(raw: RawCase): TimestampedSession[] {
  return raw.haystack_session_ids.map((sessionId, index) => ({
    session_id: sessionId,
    date: raw.haystack_dates[index] ?? "",
    turns: (raw.haystack_sessions[index] ?? []).map(
      (turn): Turn => ({ role: turn.role, content: turn.content }),
    ),
  }));
}

function goldTurns(oracle: RawCase | undefined): Array<{ sessionId: string; turnIndex: number }> {
  if (!oracle) return [];
  const out: Array<{ sessionId: string; turnIndex: number }> = [];
  for (let s = 0; s < oracle.haystack_sessions.length; s += 1) {
    const sessionId = oracle.haystack_session_ids[s]!;
    const turns = oracle.haystack_sessions[s] ?? [];
    for (let t = 0; t < turns.length; t += 1) {
      if (turns[t]?.has_answer) out.push({ sessionId, turnIndex: t });
    }
  }
  return out;
}

function spanSet(
  spans: Array<{ sessionId: string; startTurn: number; endTurn: number }>,
): Set<string> {
  const set = new Set<string>();
  for (const span of spans) {
    for (let t = span.startTurn; t <= span.endTurn; t += 1) {
      set.add(`${span.sessionId}:${t}`);
    }
  }
  return set;
}

function measure(raw: RawCase, oracle: RawCase | undefined, windowTurns: number) {
  const result = retrieveMemory({
    question: raw.question,
    questionDate: raw.question_date,
    sessions: toSessions(raw),
    options: {
      windowTurns,
      windowStride: 1,
      topK: 48,
      charBudget: 80_000,
      maxTurnChars: 4_000,
      temporalBoost: 0.15,
    },
  });
  const gold = goldTurns(oracle);
  const spans = spanSet(
    result.spans.map((s) => ({
      sessionId: s.sessionId,
      startTurn: s.startTurn,
      endTurn: s.endTurn,
    })),
  );
  const hit = gold.filter((g) => spans.has(`${g.sessionId}:${g.turnIndex}`));
  return {
    questionId: raw.question_id,
    questionType: raw.question_type,
    abstention: raw.question_id.endsWith("_abs"),
    goldCount: gold.length,
    goldHit: hit.length,
    anyHit: gold.length === 0 ? null : hit.length > 0,
    allHit: gold.length === 0 ? null : hit.length === gold.length,
    spanCount: result.spans.length,
    characterCount: result.characterCount,
    estimatedTokens: result.estimatedTokens,
  };
}

const dataset = JSON.parse(readFileSync(DATASET_PATH, "utf8")) as RawCase[];
const oracleList = JSON.parse(readFileSync(ORACLE_PATH, "utf8")) as RawCase[];
const byId = new Map(dataset.map((c) => [c.question_id, c]));
const oracleById = new Map(oracleList.map((c) => [c.question_id, c]));

const rows = SLICE.map((qid) => {
  const raw = byId.get(qid);
  if (!raw) throw new Error(`missing case ${qid}`);
  const baseQid = qid.endsWith("_abs") ? qid.slice(0, -4) : qid;
  const oracle = oracleById.get(baseQid);
  return {
    qid,
    w2: measure(raw, oracle, 2),
    w5: measure(raw, oracle, 5),
  };
});

const answerable = rows.filter((r) => !r.w2.abstention);
const summarize = (key: "w2" | "w5") => {
  const any = answerable.filter((r) => r[key].anyHit).length;
  const all = answerable.filter((r) => r[key].allHit).length;
  const chars =
    answerable.reduce((s, r) => s + r[key].characterCount, 0) / Math.max(answerable.length, 1);
  const toks =
    answerable.reduce((s, r) => s + r[key].estimatedTokens, 0) / Math.max(answerable.length, 1);
  return { anyHit: any, allHit: all, n: answerable.length, meanChars: chars, meanTokens: toks };
};

const flips = answerable
  .filter((r) => r.w2.allHit !== r.w5.allHit || r.w2.anyHit !== r.w5.anyHit)
  .map((r) => ({
    qid: r.qid,
    w2: { any: r.w2.anyHit, all: r.w2.allHit, goldHit: r.w2.goldHit, gold: r.w2.goldCount },
    w5: { any: r.w5.anyHit, all: r.w5.allHit, goldHit: r.w5.goldHit, gold: r.w5.goldCount },
    deltaChars: r.w5.characterCount - r.w2.characterCount,
  }));

const report = {
  generatedAt: new Date().toISOString(),
  slice: [...SLICE],
  summary: { w2: summarize("w2"), w5: summarize("w5") },
  flips,
  rows,
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ summary: report.summary, flips: report.flips }, null, 2));
console.log(`wrote ${OUT_PATH}`);
