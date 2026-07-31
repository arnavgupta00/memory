/**
 * Build the deterministic all-500 slice for Architecture 0008.
 *
 * The source dataset order is preserved. Cases are grouped as answerable or
 * abstention for retrieval reporting; the canonical report still groups by
 * the six official question types and separately reports abstention accuracy.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const DATASET = resolve(PROJECT_ROOT, "data/raw/longmemeval_s_cleaned.json");
const ORACLE = resolve(PROJECT_ROOT, "data/raw/longmemeval_oracle.json");
const DEFAULT_OUTPUT = resolve(
  PROJECT_ROOT,
  "src/agents/current/eval-slices/hop-full500-v1.json",
);

type DatasetCase = {
  question_id: string;
  question_type: string;
};

function parseArgs(argv: string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith("--")) continue;
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      output[key] = "true";
    } else {
      output[key] = value;
      index += 1;
    }
  }
  return output;
}

function countBy(values: string[]): Record<string, number> {
  return Object.fromEntries(
    [...new Set(values)]
      .sort()
      .map((value) => [value, values.filter((candidate) => candidate === value).length]),
  );
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const output = resolve(PROJECT_ROOT, args.out ?? DEFAULT_OUTPUT);
  const dataset = JSON.parse(readFileSync(DATASET, "utf8")) as DatasetCase[];
  const oracle = JSON.parse(readFileSync(ORACLE, "utf8")) as DatasetCase[];
  const oracleIds = new Set(oracle.map((item) => item.question_id));
  const questionIds = dataset.map((item) => item.question_id);

  if (dataset.length !== 500 || oracle.length !== 500) {
    throw new Error(
      `expected 500 dataset and oracle cases, got ${String(dataset.length)} and `
      + String(oracle.length),
    );
  }
  if (new Set(questionIds).size !== 500) throw new Error("dataset question IDs are not unique");
  if (questionIds.some((questionId) => !oracleIds.has(questionId))) {
    throw new Error("dataset and oracle question IDs differ");
  }

  const cases = dataset.map((item) => ({
    question_id: item.question_id,
    stratum: item.question_id.endsWith("_abs") ? "abstention" : "answerable",
    question_type: item.question_type,
  }));
  const strata = cases.map((item) => item.stratum);
  if (strata.filter((stratum) => stratum === "abstention").length !== 30) {
    throw new Error("expected exactly 30 abstention cases");
  }

  const payload = {
    name: "hop-full500-v1",
    description:
      "All 500 LongMemEval-S questions in frozen dataset order; 470 answerable and "
      + "30 abstention cases.",
    source_dataset: "data/raw/longmemeval_s_cleaned.json",
    source_oracle: "data/raw/longmemeval_oracle.json",
    counts: {
      total: cases.length,
      by_stratum: countBy(strata),
      by_question_type: countBy(cases.map((item) => item.question_type)),
    },
    question_ids: questionIds,
    cases,
  };

  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`wrote ${output}`);
  console.log(JSON.stringify(payload.counts, null, 2));
}

main();
