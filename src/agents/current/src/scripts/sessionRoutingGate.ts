/**
 * Offline session-routing recall gate.
 * Measures whether the deterministic session index + lexical overlap would
 * surface gold sessions that BM25 missed, before wiring the LLM expand loop.
 *
 * usage: sessionRoutingGate.ts --run <run-dir> [--focus qid,qid]
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSessionIndex } from "../retrieval/sessionIndex.js";
import { tokenizeForPackage } from "../nodes/selectContext.js";
import type { TimestampedSession, Turn } from "../types.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const DATASET_PATH = resolve(PROJECT_ROOT, "data/raw/longmemeval_s_cleaned.json");
const REPORT_ROOT = resolve(PROJECT_ROOT, "runs/local-archive/backbone");

type RawTurn = {
  role: "user" | "assistant";
  content: string;
  has_answer?: boolean;
};

type RawCase = {
  question_id: string;
  question: string;
  question_type: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: RawTurn[][];
};

function parseArgs(argv: string[]): { runDir: string; focus: Set<string> | null; topK: number } {
  let runDir = "";
  let focus: Set<string> | null = null;
  let topK = 8;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if ((arg === "--run" || arg === "--run-dir") && next) {
      runDir = next;
      index += 1;
      continue;
    }
    if (arg === "--focus" && next) {
      focus = new Set(next.split(",").map((item) => item.trim()).filter(Boolean));
      index += 1;
      continue;
    }
    if (arg === "--top-k" && next) {
      topK = Number(next);
      index += 1;
    }
  }
  if (!runDir) {
    throw new Error("usage: sessionRoutingGate.ts --run <run-dir> [--focus qid,qid] [--top-k 8]");
  }
  const resolved = runDir.startsWith("/") ? runDir : resolve(PROJECT_ROOT, runDir);
  return { runDir: resolved, focus, topK };
}

function toSessions(raw: RawCase): TimestampedSession[] {
  return raw.haystack_session_ids.map((sessionId, index) => {
    const date = raw.haystack_dates[index];
    const turns = raw.haystack_sessions[index];
    if (!date || !turns) throw new Error(`incomplete haystack for ${raw.question_id}`);
    return {
      session_id: sessionId,
      date,
      turns: turns.map(
        (turn): Turn => ({
          role: turn.role,
          content: turn.content,
        }),
      ),
    };
  });
}

function goldSessionIds(raw: RawCase): Set<string> {
  const out = new Set<string>();
  for (let sessionIndex = 0; sessionIndex < raw.haystack_sessions.length; sessionIndex += 1) {
    const sessionId = raw.haystack_session_ids[sessionIndex];
    const turns = raw.haystack_sessions[sessionIndex];
    if (!sessionId || !turns) continue;
    if (turns.some((turn) => turn.has_answer === true)) out.add(sessionId);
  }
  return out;
}

function scoreEntry(
  questionTokens: Set<string>,
  entry: { opener: string; terms: string[]; date: string },
): number {
  let score = 0;
  for (const token of tokenizeForPackage(entry.opener)) {
    if (questionTokens.has(token)) score += 2;
  }
  for (const term of entry.terms) {
    if (questionTokens.has(term)) score += 3;
  }
  return score;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dataset = JSON.parse(readFileSync(DATASET_PATH, "utf8")) as RawCase[];
  const byId = new Map(dataset.map((item) => [item.question_id, item]));
  const predictions = readFileSync(resolve(args.runDir, "predictions.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { question_id: string });

  const retrievalGaps = [
    "6d550036",
    "75832dbd",
    "92a0aa75",
    "a08a253f",
    "ba358f49",
    "gpt4_194be4b3",
    "gpt4_2f8be40d",
    "gpt4_372c3eed",
    "gpt4_7abb270c",
    "gpt4_7f6b06db",
    "gpt4_d6585ce8",
    "gpt4_d6585ce9",
    "gpt4_e061b84f",
  ];
  const targetIds = args.focus ?? new Set(retrievalGaps);

  let cases = 0;
  let goldSessionsTotal = 0;
  let missedByBundle = 0;
  let recoverableByIndex = 0;
  const rows: Array<Record<string, unknown>> = [];

  for (const pred of predictions) {
    const questionId = pred.question_id;
    if (!targetIds.has(questionId)) continue;
    const raw = byId.get(questionId);
    if (!raw) continue;
    const retrievalPath = resolve(args.runDir, "agent-artifacts/cases", questionId, "retrieval.json");
    if (!existsSync(retrievalPath)) continue;
    const retrieval = JSON.parse(readFileSync(retrievalPath, "utf8")) as {
      spans: Array<{ session_id: string }>;
    };
    const bundleSessions = new Set(retrieval.spans.map((span) => span.session_id));
    const gold = goldSessionIds(raw);
    const sessions = toSessions(raw);
    const index = buildSessionIndex(sessions);
    const questionTokens = tokenizeForPackage(raw.question);
    const ranked = index
      .map((entry) => ({
        sessionId: entry.sessionId,
        score: scoreEntry(questionTokens, entry),
        inBundle: bundleSessions.has(entry.sessionId),
      }))
      .filter((row) => row.score > 0)
      .sort((left, right) => right.score - left.score || left.sessionId.localeCompare(right.sessionId))
      .slice(0, args.topK);
    const routed = new Set(ranked.map((row) => row.sessionId));
    // Series neighbors: answer_foo_1 ↔ answer_foo_2 share a prefix before the final _N.
    const seriesOf = (sessionId: string): string => {
      const match = /^(.*)_\d+$/.exec(sessionId);
      return match?.[1] ?? sessionId;
    };
    const seedSeries = new Set(
      [...bundleSessions, ...routed].map((sessionId) => seriesOf(sessionId)),
    );
    for (const entry of index) {
      if (seedSeries.has(seriesOf(entry.sessionId))) routed.add(entry.sessionId);
    }

    const missing = [...gold].filter((sessionId) => !bundleSessions.has(sessionId));
    const recovered = missing.filter((sessionId) => routed.has(sessionId));

    cases += 1;
    goldSessionsTotal += gold.size;
    missedByBundle += missing.length;
    recoverableByIndex += recovered.length;

    rows.push({
      question_id: questionId,
      question_type: raw.question_type,
      gold_sessions: [...gold],
      missing_from_bundle: missing,
      recovered_by_index: recovered,
      top_routed: ranked,
    });
  }

  const report = {
    runDir: args.runDir,
    cases,
    goldSessionsTotal,
    missedByBundle,
    recoverableByIndex,
    recoveryRate: missedByBundle ? recoverableByIndex / missedByBundle : 1,
    rows,
  };
  mkdirSync(REPORT_ROOT, { recursive: true });
  const outPath = resolve(
    REPORT_ROOT,
    `session-routing-gate-${args.runDir.split("/").pop() ?? "run"}.json`,
  );
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        outPath,
        cases: report.cases,
        missedByBundle: report.missedByBundle,
        recoverableByIndex: report.recoverableByIndex,
        recoveryRate: report.recoveryRate,
      },
      null,
      2,
    ),
  );
}

main();
