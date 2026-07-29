/**
 * Parallel session annotator (index-time BM25 expansion storer).
 *
 * One structured call per unique session over USER turns only. Results are
 * cached under --cache keyed by session_id so re-runs / ablations are free.
 *
 * Usage:
 *   pnpm --dir src/agents/current exec node --import tsx \
 *     src/scripts/sessionAnnotate.ts \
 *     --run runs/architecture-0005.4.4-canary1-breadth \
 *     --slice hard12 \
 *     --cache runs/local-archive/backbone/session-annotations-v1 \
 *     --concurrency 24
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

import { PromptLoader } from "../services/promptLoader.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const DEFAULT_RUN = resolve(PROJECT_ROOT, "runs/architecture-0005.4.4-canary1-breadth");
const DEFAULT_DATASET = resolve(PROJECT_ROOT, "data/raw/longmemeval_s_cleaned.json");
const DEFAULT_ORACLE = resolve(PROJECT_ROOT, "data/raw/longmemeval_oracle.json");
const MODEL = "gpt-5.4-nano-2026-03-17";
const TOKEN_BUDGET = 200_000;
const WINDOW_SECONDS = 60;
const OUTPUT_CEILING = 800;

const AnnotationSchema = z.object({
  facts: z.array(
    z.object({
      text: z.string(),
      turn_index: z.number().int().nonnegative(),
    }),
  ),
  keyphrases: z.array(z.string()),
  events: z.array(
    z.object({
      text: z.string(),
      date_hint: z.string(),
      turn_index: z.number().int().nonnegative(),
    }),
  ),
});
type Annotation = z.infer<typeof AnnotationSchema>;

type RawTurn = { role: "user" | "assistant"; content: string; has_answer?: boolean };
type RawCase = {
  question_id: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: RawTurn[][];
};

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
    if (!next || next.startsWith("--")) {
      out[key] = "true";
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function estimateInputTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

class TokenBudgetGate {
  readonly #budget: number;
  readonly #windowMs: number;
  #reservations: Array<{ at: number; tokens: number }> = [];
  #active = 0;
  readonly #maxConcurrency: number;
  readonly #queue: Array<() => void> = [];

  constructor(budget: number, windowSeconds: number, maxConcurrency: number) {
    this.#budget = budget;
    this.#windowMs = windowSeconds * 1000;
    this.#maxConcurrency = maxConcurrency;
  }

  async acquire(tokens: number): Promise<() => void> {
    for (;;) {
      this.#prune();
      const reserved = this.#reservations.reduce((sum, item) => sum + item.tokens, 0);
      if (this.#active < this.#maxConcurrency && reserved + tokens <= this.#budget) {
        this.#reservations.push({ at: Date.now(), tokens });
        this.#active += 1;
        return () => {
          this.#active -= 1;
          this.#pump();
        };
      }
      await new Promise<void>((resolveWait) => {
        this.#queue.push(resolveWait);
        setTimeout(resolveWait, 250);
      });
    }
  }

  #prune(): void {
    const cutoff = Date.now() - this.#windowMs;
    this.#reservations = this.#reservations.filter((item) => item.at >= cutoff);
  }

  #pump(): void {
    const waiter = this.#queue.shift();
    if (waiter) waiter();
  }
}

function artifactSessionOrder(
  runDir: string,
  qid: string,
): Record<string, number> | null {
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

function resolveSlice(
  name: string,
  runDir: string,
  qids: string[],
  oracle: Record<string, { answer_session_ids: string[] }>,
): string[] {
  const answerable = qids.filter((q) => !q.endsWith("_abs"));
  if (name === "answerable") return answerable;
  if (name === "all") return qids;

  const hard: Array<{ q: string; worst: number }> = [];
  const good: string[] = [];
  for (const q of answerable) {
    const order = artifactSessionOrder(runDir, q);
    const gold = oracle[q]?.answer_session_ids;
    if (!order || !gold) continue;
    const ranks = gold.map((g) => order[g] ?? 999);
    const worst = Math.max(...ranks);
    if (ranks.length < gold.length || worst > 5) hard.push({ q, worst });
    else good.push(q);
  }
  hard.sort((a, b) => b.worst - a.worst);
  if (name === "hard") return hard.map((item) => item.q);
  if (name === "hard12") return hard.slice(0, 12).map((item) => item.q);
  if (name === "hard50") {
    return [...hard.map((item) => item.q), ...good.slice(0, 17)];
  }
  throw new Error(`unknown slice: ${name}`);
}

function formatUserTurns(turns: RawTurn[]): string {
  const lines: string[] = [];
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (!turn || turn.role !== "user") continue;
    lines.push(`[turn ${String(index)}] ${turn.content}`);
  }
  return lines.length > 0 ? lines.join("\n\n") : "(no user turns)";
}

function cachePath(cacheDir: string, sessionId: string): string {
  // session ids may contain path-unsafe chars
  const safe = sessionId.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  return resolve(cacheDir, `${safe}.json`);
}

function loadCached(cacheDir: string, sessionId: string): Annotation | null {
  const path = cachePath(cacheDir, sessionId);
  if (!existsSync(path)) return null;
  try {
    return AnnotationSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function writeCached(cacheDir: string, sessionId: string, value: Annotation): void {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    cachePath(cacheDir, sessionId),
    JSON.stringify({ session_id: sessionId, prompt: "session-annotate-v1", ...value }, null, 2),
  );
}

async function main(): Promise<void> {
  loadDotEnv(resolve(PROJECT_ROOT, ".env"));
  const args = parseArgs(process.argv.slice(2));
  const runDir = resolve(PROJECT_ROOT, args.run ?? DEFAULT_RUN);
  const datasetPath = resolve(PROJECT_ROOT, args.dataset ?? DEFAULT_DATASET);
  const oraclePath = resolve(PROJECT_ROOT, args.oracle ?? DEFAULT_ORACLE);
  const cacheDir = resolve(
    PROJECT_ROOT,
    args.cache ?? "runs/local-archive/backbone/session-annotations-v1",
  );
  const slice = args.slice ?? "hard12";
  const concurrency = Number(args.concurrency ?? "24");
  const promptName = args.prompt ?? "session-annotate-v1";
  const limit = args.limit ? Number(args.limit) : undefined;

  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");

  const manifest = JSON.parse(readFileSync(resolve(runDir, "manifest.json"), "utf8")) as {
    selected_question_ids: string[];
  };
  const dataset = JSON.parse(readFileSync(datasetPath, "utf8")) as RawCase[];
  const oracleList = JSON.parse(readFileSync(oraclePath, "utf8")) as Array<{
    question_id: string;
    answer_session_ids: string[];
  }>;
  const byId = new Map(dataset.map((item) => [item.question_id, item]));
  const oracle = Object.fromEntries(
    oracleList.map((item) => [item.question_id, item]),
  );

  const qids = resolveSlice(slice, runDir, manifest.selected_question_ids, oracle);
  const sessions = new Map<string, { date: string; turns: RawTurn[] }>();
  for (const q of qids) {
    const raw = byId.get(q);
    if (!raw) continue;
    for (let i = 0; i < raw.haystack_session_ids.length; i += 1) {
      const sid = raw.haystack_session_ids[i];
      const date = raw.haystack_dates[i];
      const turns = raw.haystack_sessions[i];
      if (!sid || !date || !turns || sessions.has(sid)) continue;
      sessions.set(sid, { date, turns });
    }
  }

  let sessionIds = [...sessions.keys()].sort();
  if (limit !== undefined) sessionIds = sessionIds.slice(0, limit);

  const pending: string[] = [];
  let cached = 0;
  for (const sid of sessionIds) {
    if (loadCached(cacheDir, sid)) cached += 1;
    else pending.push(sid);
  }

  console.log(
    `slice=${slice} questions=${String(qids.length)} sessions=${String(sessionIds.length)} `
      + `cached=${String(cached)} to_annotate=${String(pending.length)} `
      + `concurrency=${String(concurrency)} model=${MODEL}`,
  );

  if (pending.length === 0) {
    writeIndex(cacheDir, sessionIds);
    console.log("nothing to do");
    return;
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
  const prompts = new PromptLoader();
  const gate = new TokenBudgetGate(TOKEN_BUDGET, WINDOW_SECONDS, concurrency);
  let done = 0;
  let failed = 0;
  const started = Date.now();

  async function annotateOne(sessionId: string): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) return;
    const userTurns = formatUserTurns(session.turns);
    const prompt = await prompts.render(promptName, {
      session_id: sessionId,
      session_date: session.date,
      user_turns: userTurns,
    });
    const inputText = prompt.messages.map((m) => m.content).join("\n");
    const release = await gate.acquire(estimateInputTokens(inputText) + OUTPUT_CEILING);
    try {
      const response = await openai.responses.parse({
        model: MODEL,
        input: prompt.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        text: { format: zodTextFormat(AnnotationSchema, "session_annotate_v1") },
        temperature: 0,
      });
      const value = response.output_parsed;
      if (!value) throw new Error("empty structured output");
      writeCached(cacheDir, sessionId, value);
      done += 1;
      if (done % 25 === 0 || done === pending.length) {
        const elapsed = ((Date.now() - started) / 1000).toFixed(0);
        console.log(
          `progress ${String(done)}/${String(pending.length)} failed=${String(failed)} ${elapsed}s`,
        );
      }
    } catch (error) {
      failed += 1;
      console.error(`fail ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      release();
    }
  }

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < pending.length) {
      const index = cursor;
      cursor += 1;
      const sid = pending[index];
      if (sid) await annotateOne(sid);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()),
  );

  writeIndex(cacheDir, sessionIds);
  console.log(
    `done annotated=${String(done)} failed=${String(failed)} `
      + `cache=${cacheDir} elapsed_s=${((Date.now() - started) / 1000).toFixed(1)}`,
  );
}

function writeIndex(cacheDir: string, sessionIds: string[]): void {
  mkdirSync(cacheDir, { recursive: true });
  const sessions: Record<string, Annotation> = {};
  for (const sid of sessionIds) {
    const value = loadCached(cacheDir, sid);
    if (value) sessions[sid] = value;
  }
  writeFileSync(
    resolve(cacheDir, "_index.json"),
    JSON.stringify(
      {
        prompt: "session-annotate-v1",
        model: MODEL,
        session_count: Object.keys(sessions).length,
        sessions,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
