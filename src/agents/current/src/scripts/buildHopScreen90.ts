/**
 * Build the deterministic 90-question exposed screening slice used to compare
 * hop-retriever architectures before touching the fresh verification pool.
 *
 * Selection:
 * - all 28 hard and all 12 mid cases from answerable135;
 * - both easy misses from the opaque-ID v1 baseline;
 * - a seeded hash sample of the remaining easy cases within fixed type quotas.
 *
 * Usage:
 *   pnpm --dir src/agents/current exec node --import tsx \
 *     src/scripts/buildHopScreen90.ts
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const SOURCE_IDS = resolve(
  PROJECT_ROOT,
  "runs/local-archive/backbone/hop-teach/ids-answerable135.json",
);
const BASELINE_RUN = resolve(
  PROJECT_ROOT,
  "runs/local-archive/backbone/hop-gate-luna-h6-v1-answerable135-opaque.json",
);
const OUTPUT = resolve(
  PROJECT_ROOT,
  "src/agents/current/eval-slices/hop-screen90-v1.json",
);
const SEED = "hop-screen90-v1";

type Stratum = "hard" | "mid" | "easy";

type SliceCase = {
  question_id: string;
  stratum: Stratum;
  question_type: string;
  phase1_worst_rank: number | null;
  phase1_gold_ranks: number[];
};

type SourceSlice = {
  question_ids: string[];
  cases: SliceCase[];
};

type BaselineCase = {
  question_id: string;
  full_gold_in_bag: boolean;
};

const EASY_QUOTAS: Record<string, number> = {
  "knowledge-update": 10,
  "multi-session": 7,
  "single-session-assistant": 8,
  "single-session-preference": 5,
  "single-session-user": 9,
  "temporal-reasoning": 11,
};

function hashKey(questionId: string): string {
  return createHash("sha256").update(`${SEED}\0${questionId}`).digest("hex");
}

function countsBy(cases: SliceCase[], field: "stratum" | "question_type"): Record<string, number> {
  const values = [...new Set(cases.map((item) => item[field]))].sort();
  return Object.fromEntries(
    values.map((value) => [value, cases.filter((item) => item[field] === value).length]),
  );
}

function main(): void {
  const source = JSON.parse(readFileSync(SOURCE_IDS, "utf8")) as SourceSlice;
  const baseline = JSON.parse(readFileSync(BASELINE_RUN, "utf8")) as {
    cases: BaselineCase[];
  };
  const baselineById = new Map(
    baseline.cases.map((item) => [item.question_id, item]),
  );
  const selected = new Set(
    source.cases
      .filter((item) => item.stratum !== "easy")
      .map((item) => item.question_id),
  );

  for (const [questionType, quota] of Object.entries(EASY_QUOTAS)) {
    const candidates = source.cases.filter(
      (item) => item.stratum === "easy" && item.question_type === questionType,
    );
    const baselineMisses = candidates.filter(
      (item) => baselineById.get(item.question_id)?.full_gold_in_bag === false,
    );
    const remaining = candidates
      .filter((item) => !baselineMisses.includes(item))
      .sort((left, right) => hashKey(left.question_id).localeCompare(hashKey(right.question_id)));
    for (const item of [...baselineMisses, ...remaining].slice(0, quota)) {
      selected.add(item.question_id);
    }
  }

  const cases = source.cases.filter((item) => selected.has(item.question_id));
  const questionIds = source.question_ids.filter((questionId) => selected.has(questionId));
  const selectedBaseline = baseline.cases.filter((item) => selected.has(item.question_id));

  if (cases.length !== 90 || questionIds.length !== 90 || selected.size !== 90) {
    throw new Error(
      `expected 90 unique cases, got cases=${String(cases.length)} `
      + `question_ids=${String(questionIds.length)} selected=${String(selected.size)}`,
    );
  }
  if (new Set(questionIds).size !== 90) throw new Error("duplicate question ID in screen90");
  if (cases.filter((item) => item.stratum === "hard").length !== 28) {
    throw new Error("screen90 must contain all 28 hard cases");
  }
  if (cases.filter((item) => item.stratum === "mid").length !== 12) {
    throw new Error("screen90 must contain all 12 mid cases");
  }
  for (const [questionType, quota] of Object.entries(EASY_QUOTAS)) {
    const actual = cases.filter(
      (item) => item.stratum === "easy" && item.question_type === questionType,
    ).length;
    if (actual !== quota) {
      throw new Error(
        `easy quota mismatch for ${questionType}: ${String(actual)} != ${String(quota)}`,
      );
    }
  }

  const payload = {
    name: "hop-screen90-v1",
    description:
      "Exposed stress-screen slice: all hard and mid answerable135 cases, both "
      + "opaque-v1 easy misses, and a deterministic hash sample of remaining "
      + "easy cases within fixed type quotas. Not a population estimate or final holdout.",
    source_ids: "runs/local-archive/backbone/hop-teach/ids-answerable135.json",
    baseline_run:
      "runs/local-archive/backbone/hop-gate-luna-h6-v1-answerable135-opaque.json",
    selection_seed: SEED,
    selection: {
      hard: "all 28",
      mid: "all 12",
      easy_quotas: EASY_QUOTAS,
      easy_opaque_v1_misses_forced: true,
    },
    counts: {
      total: cases.length,
      by_stratum: countsBy(cases, "stratum"),
      by_question_type: countsBy(cases, "question_type"),
      opaque_v1_full_gold: selectedBaseline.filter((item) => item.full_gold_in_bag).length,
      opaque_v1_misses: selectedBaseline.filter((item) => !item.full_gold_in_bag).length,
    },
    question_ids: questionIds,
    cases,
  };

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`wrote ${OUTPUT}`);
  console.log(JSON.stringify(payload.counts, null, 2));
}

main();
