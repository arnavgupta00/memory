/**
 * Infer a retrieval date range from each question (Phase-3 time-aware pruning).
 * Cached under --cache keyed by question_id.
 *
 * Usage:
 *   pnpm --dir src/agents/current exec node --import tsx \
 *     src/scripts/questionDateInfer.ts \
 *     --run runs/architecture-0005.4.4-canary1-breadth \
 *     --slice hard \
 *     --cache runs/local-archive/backbone/question-date-ranges-v1
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const DEFAULT_RUN = resolve(PROJECT_ROOT, "runs/architecture-0005.4.4-canary1-breadth");
const DEFAULT_DATASET = resolve(PROJECT_ROOT, "data/raw/longmemeval_s_cleaned.json");
const MODEL = "gpt-5.4-nano-2026-03-17";

const RangeSchema = z.object({
  has_temporal_constraint: z.boolean(),
  start_date: z.string().nullable(), // YYYY-MM-DD or null
  end_date: z.string().nullable(),
  rationale: z.string(),
});
type Range = z.infer<typeof RangeSchema>;

function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = "true";
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function artifactSessionOrder(runDir: string, qid: string): Record<string, number> | null {
  const path = resolve(runDir, "agent-artifacts/cases", qid, "retrieval.json");
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, "utf8")) as {
    spans?: Array<{ session_id: string; best_rank: number }>;
  };
  const best: Record<string, number> = {};
  for (const span of data.spans ?? []) {
    best[span.session_id] = Math.min(best[span.session_id] ?? 9999, span.best_rank);
  }
  return Object.fromEntries(
    Object.entries(best)
      .sort((a, b) => a[1] - b[1])
      .map(([sid], index) => [sid, index + 1]),
  );
}

async function main(): Promise<void> {
  loadDotEnv(resolve(PROJECT_ROOT, ".env"));
  const args = parseArgs(process.argv.slice(2));
  const runDir = resolve(PROJECT_ROOT, args.run ?? DEFAULT_RUN);
  const datasetPath = resolve(PROJECT_ROOT, args.dataset ?? DEFAULT_DATASET);
  const cacheDir = resolve(
    PROJECT_ROOT,
    args.cache ?? "runs/local-archive/backbone/question-date-ranges-v1",
  );
  const slice = args.slice ?? "answerable";
  const concurrency = Number(args.concurrency ?? "16");
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");

  const manifest = JSON.parse(readFileSync(resolve(runDir, "manifest.json"), "utf8")) as {
    selected_question_ids: string[];
  };
  const dataset = JSON.parse(readFileSync(datasetPath, "utf8")) as Array<{
    question_id: string;
    question: string;
    question_date: string;
    answer_session_ids?: string[];
  }>;
  const oracle = JSON.parse(
    readFileSync(resolve(PROJECT_ROOT, "data/raw/longmemeval_oracle.json"), "utf8"),
  ) as Array<{ question_id: string; answer_session_ids: string[] }>;
  const oracleMap = Object.fromEntries(oracle.map((item) => [item.question_id, item]));
  const byId = Object.fromEntries(dataset.map((item) => [item.question_id, item]));

  let qids = manifest.selected_question_ids.filter((q) => !q.endsWith("_abs"));
  if (slice === "hard" || slice === "hard12" || slice === "hard50") {
    const hard: string[] = [];
    const good: string[] = [];
    for (const q of qids) {
      const order = artifactSessionOrder(runDir, q);
      const gold = oracleMap[q]?.answer_session_ids;
      if (!order || !gold) continue;
      const ranks = gold.map((g) => order[g] ?? 999);
      const worst = Math.max(...ranks);
      if (ranks.length < gold.length || worst > 5) hard.push(q);
      else good.push(q);
    }
    if (slice === "hard") qids = hard;
    else if (slice === "hard12") qids = hard.slice(0, 12);
    else qids = [...hard, ...good.slice(0, 17)];
  }

  mkdirSync(cacheDir, { recursive: true });
  const pending = qids.filter((q) => !existsSync(resolve(cacheDir, `${q}.json`)));
  console.log(`slice=${slice} q=${String(qids.length)} pending=${String(pending.length)}`);

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 2 });
  let cursor = 0;
  let done = 0;

  async function one(qid: string): Promise<void> {
    const item = byId[qid];
    if (!item) return;
    const response = await openai.responses.parse({
      model: MODEL,
      temperature: 0,
      input: [
        {
          role: "system",
          content:
            "You extract a calendar date range for retrieving chat memory. "
            + "Given question_date (when the user is asking) and the question text, "
            + "decide whether the question constrains answers to a time window. "
            + "If yes, emit start_date and end_date as YYYY-MM-DD, widened by about "
            + "one week on each side when the cue is fuzzy. If the question has no "
            + "temporal constraint, set has_temporal_constraint=false and dates null. "
            + "Do not invent constraints from session content — only from the question.",
        },
        {
          role: "user",
          content:
            `question_date: ${item.question_date}\nquestion: ${item.question}`,
        },
      ],
      text: { format: zodTextFormat(RangeSchema, "question_date_range_v1") },
    });
    const value = response.output_parsed;
    if (!value) throw new Error("empty parse");
    writeFileSync(
      resolve(cacheDir, `${qid}.json`),
      JSON.stringify({ question_id: qid, ...value }, null, 2),
    );
    done += 1;
    if (done % 20 === 0 || done === pending.length) {
      console.log(`progress ${String(done)}/${String(pending.length)}`);
    }
  }

  async function worker(): Promise<void> {
    while (cursor < pending.length) {
      const i = cursor;
      cursor += 1;
      const q = pending[i];
      if (q) {
        try {
          await one(q);
        } catch (error) {
          console.error(`fail ${q}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(pending.length, 1)) }, () => worker()),
  );

  const ranges: Record<string, Range> = {};
  for (const q of qids) {
    const path = resolve(cacheDir, `${q}.json`);
    if (!existsSync(path)) continue;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Range & { question_id: string };
    ranges[q] = {
      has_temporal_constraint: raw.has_temporal_constraint,
      start_date: raw.start_date,
      end_date: raw.end_date,
      rationale: raw.rationale,
    };
  }
  writeFileSync(
    resolve(cacheDir, "_index.json"),
    JSON.stringify({ model: MODEL, count: Object.keys(ranges).length, ranges }, null, 2),
  );
  const withRange = Object.values(ranges).filter((r) => r.has_temporal_constraint).length;
  console.log(`done with_range=${String(withRange)}/${String(Object.keys(ranges).length)} cache=${cacheDir}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
