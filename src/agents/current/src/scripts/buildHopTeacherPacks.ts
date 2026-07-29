/**
 * Build hop-teacher packs for teach38 + all 500 LongMemEval questions.
 *
 * Usage:
 *   pnpm --dir src/agents/current run gate:hop-packs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatNotesDocumentText,
  loadAnnotations,
  type SessionAnnotation,
} from "../retrieval/notesIndex.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const DEFAULT_DATASET = resolve(PROJECT_ROOT, "data/raw/longmemeval_s_cleaned.json");
const DEFAULT_ORACLE = resolve(PROJECT_ROOT, "data/raw/longmemeval_oracle.json");
const DEFAULT_HOP27 = resolve(PROJECT_ROOT, "runs/local-archive/backbone/hop27-ids.json");
const DEFAULT_PHASE1 = resolve(
  PROJECT_ROOT,
  "runs/local-archive/backbone/rank-gate-answerable-phase1-none.json",
);
const DEFAULT_ANNOTATIONS = resolve(
  PROJECT_ROOT,
  "runs/local-archive/backbone/session-annotations-v1",
);
const DEFAULT_LUNA = resolve(PROJECT_ROOT, "runs/local-archive/backbone/hop-gate-luna-h6.json");
const DEFAULT_OUT = resolve(PROJECT_ROOT, "runs/local-archive/backbone/hop-teach");

type RawTurn = { role: "user" | "assistant"; content: string };
type RawCase = {
  question_id: string;
  question_type: string;
  question: string;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: RawTurn[][];
  answer_session_ids?: string[];
};

type Hop27 = {
  question_ids: string[];
  cases: Array<{ question_id: string; stratum: string }>;
};

type Phase1Case = {
  question_id: string;
  gold_ranks: number[];
  worst_rank: number | null;
};

type LunaCase = {
  question_id: string;
  full_gold_in_bag: boolean;
  steps: Array<{ tool: string; args: Record<string, unknown>; result_summary: string }>;
  bag: string[];
};

function userTurnsText(turns: RawTurn[] | undefined): string {
  if (!turns) return "(no turns)";
  const lines: string[] = [];
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    if (!turn || turn.role !== "user") continue;
    lines.push(`[turn ${String(i)}] ${turn.content}`);
  }
  return lines.length > 0 ? lines.join("\n\n") : "(no user turns)";
}

function notesCoverage(
  sessionIds: string[],
  annotations: Map<string, SessionAnnotation>,
): "full" | "partial" | "none" {
  let have = 0;
  for (const sid of new Set(sessionIds)) {
    if (annotations.has(sid)) have += 1;
  }
  const n = new Set(sessionIds).size;
  if (n === 0 || have === 0) return "none";
  if (have === n) return "full";
  return "partial";
}

function buildBatches(qidsByType: Map<string, string[]>, batchSize = 25): Array<{
  batch_id: string;
  question_types: string[];
  question_ids: string[];
}> {
  const batches: Array<{ batch_id: string; question_types: string[]; question_ids: string[] }> =
    [];
  // Round-robin pull from types to keep batches mixed / stratified.
  const queues = [...qidsByType.entries()].map(([type, ids]) => ({
    type,
    ids: [...ids],
  }));
  let batchNum = 0;
  while (queues.some((q) => q.ids.length > 0)) {
    const ids: string[] = [];
    const types = new Set<string>();
    while (ids.length < batchSize && queues.some((q) => q.ids.length > 0)) {
      for (const queue of queues) {
        if (ids.length >= batchSize) break;
        const next = queue.ids.shift();
        if (!next) continue;
        ids.push(next);
        types.add(queue.type);
      }
    }
    batchNum += 1;
    const nn = String(batchNum).padStart(2, "0");
    const typeLabel = [...types].sort().join("+").slice(0, 40);
    batches.push({
      batch_id: `batch-${nn}-${typeLabel || "mixed"}`,
      question_types: [...types].sort(),
      question_ids: ids,
    });
  }
  return batches;
}

function main(): void {
  const dataset = JSON.parse(readFileSync(DEFAULT_DATASET, "utf8")) as RawCase[];
  const oracleList = JSON.parse(readFileSync(DEFAULT_ORACLE, "utf8")) as Array<{
    question_id: string;
    answer_session_ids: string[];
  }>;
  const hop27 = JSON.parse(readFileSync(DEFAULT_HOP27, "utf8")) as Hop27;
  const phase1 = JSON.parse(readFileSync(DEFAULT_PHASE1, "utf8")) as { cases: Phase1Case[] };
  const annotations = loadAnnotations(DEFAULT_ANNOTATIONS);
  const lunaById = new Map<string, LunaCase>();
  if (existsSync(DEFAULT_LUNA)) {
    const luna = JSON.parse(readFileSync(DEFAULT_LUNA, "utf8")) as { cases: LunaCase[] };
    for (const item of luna.cases) lunaById.set(item.question_id, item);
  }

  const byId = new Map(dataset.map((item) => [item.question_id, item]));
  const oracle = new Map(oracleList.map((item) => [item.question_id, item.answer_session_ids]));
  const hopIds = new Set(hop27.question_ids);

  const hardOutside = phase1.cases
    .filter((item) => {
      const ranks = item.gold_ranks ?? [];
      const miss = ranks.length === 0;
      const worst = miss ? null : Math.max(...ranks);
      return (miss || (worst !== null && worst > 5)) && !hopIds.has(item.question_id);
    })
    .map((item) => item.question_id);

  const teachIds = [...hop27.question_ids, ...hardOutside];
  const teachMeta = {
    name: "teach38",
    hop27_count: hop27.question_ids.length,
    hard_outside_count: hardOutside.length,
    question_ids: teachIds,
    hop27_ids: hop27.question_ids,
    hard_outside_ids: hardOutside,
    hop27_strata: Object.fromEntries(hop27.cases.map((c) => [c.question_id, c.stratum])),
  };

  const packsDir = resolve(DEFAULT_OUT, "packs");
  mkdirSync(packsDir, { recursive: true });
  mkdirSync(resolve(DEFAULT_OUT, "methodology/per-qid"), { recursive: true });
  mkdirSync(resolve(DEFAULT_OUT, "methodology/corpus"), { recursive: true });

  const qidsByType = new Map<string, string[]>();

  for (const raw of dataset) {
    const gold = oracle.get(raw.question_id) ?? raw.answer_session_ids ?? [];
    const datesBySessionId = new Map<string, string>();
    const turnsBySessionId = new Map<string, RawTurn[]>();
    for (let i = 0; i < raw.haystack_session_ids.length; i += 1) {
      const sid = raw.haystack_session_ids[i];
      if (!sid) continue;
      datesBySessionId.set(sid, raw.haystack_dates[i] ?? "");
      turnsBySessionId.set(sid, raw.haystack_sessions[i] ?? []);
    }

    const goldSessions = gold.map((sessionId) => {
      const date = datesBySessionId.get(sessionId) ?? "";
      const annotation = annotations.get(sessionId);
      return {
        session_id: sessionId,
        date,
        has_notes: annotations.has(sessionId),
        notes_text: formatNotesDocumentText(sessionId, date, annotation),
        user_turns: userTurnsText(turnsBySessionId.get(sessionId)),
      };
    });

    const coverage = notesCoverage(raw.haystack_session_ids, annotations);
    const luna = lunaById.get(raw.question_id);
    const pack = {
      question_id: raw.question_id,
      question_type: raw.question_type,
      question: raw.question,
      question_date: raw.question_date,
      is_abstention: raw.question_id.endsWith("_abs"),
      gold_session_ids: gold,
      haystack_session_count: raw.haystack_session_ids.length,
      notes_coverage: coverage,
      annotated_session_count: [...new Set(raw.haystack_session_ids)].filter((sid) =>
        annotations.has(sid),
      ).length,
      gold_sessions: goldSessions,
      luna_h6_trace:
        luna && !luna.full_gold_in_bag
          ? {
              full_gold_in_bag: luna.full_gold_in_bag,
              bag: luna.bag,
              steps: luna.steps.slice(0, 12),
            }
          : null,
      in_teach38: teachIds.includes(raw.question_id),
      hop27_stratum: teachMeta.hop27_strata[raw.question_id] ?? null,
    };

    writeFileSync(resolve(packsDir, `${raw.question_id}.json`), JSON.stringify(pack, null, 2));

    const typeList = qidsByType.get(raw.question_type) ?? [];
    typeList.push(raw.question_id);
    qidsByType.set(raw.question_type, typeList);
  }

  // Stable order within types
  for (const [type, ids] of qidsByType) {
    ids.sort();
    qidsByType.set(type, ids);
  }

  const batches = buildBatches(qidsByType, 25);
  writeFileSync(resolve(DEFAULT_OUT, "ids-teach38.json"), JSON.stringify(teachMeta, null, 2));
  writeFileSync(
    resolve(DEFAULT_OUT, "batches-500.json"),
    JSON.stringify(
      {
        batch_size_target: 25,
        batch_count: batches.length,
        total_questions: dataset.length,
        batches,
      },
      null,
      2,
    ),
  );

  // sanity: every dataset qid in exactly one batch
  const seen = new Set<string>();
  for (const batch of batches) {
    for (const qid of batch.question_ids) {
      if (seen.has(qid)) throw new Error(`duplicate batch qid ${qid}`);
      seen.add(qid);
    }
  }
  if (seen.size !== dataset.length) {
    throw new Error(`batch coverage ${String(seen.size)} != dataset ${String(dataset.length)}`);
  }

  console.log(
    `wrote packs=${String(dataset.length)} teach38=${String(teachIds.length)} `
      + `(hop27=${String(hop27.question_ids.length)} hard_outside=${String(hardOutside.length)}) `
      + `batches=${String(batches.length)} out=${DEFAULT_OUT}`,
  );
  // touch byId to keep lint happy if unused in future
  void byId;
}

main();
