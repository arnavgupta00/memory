/**
 * Answer-only replay over frozen Hop + Arm 3 context packages.
 *
 * Reuses context-package.json from a completed Arm 3 run. No retrieval,
 * annotation, or per-session extraction calls are made.
 *
 * Usage:
 *   pnpm --dir src/agents/current exec node --import tsx \
 *     src/scripts/hopArm3AnswerReplay.ts \
 *     --source-run hop-bag-downstream-answerable135-protocol1-3 \
 *     --out-prefix hop-arm3-answerable135-luna \
 *     --model gpt-5.6-luna --reasoning low,medium \
 *     --concurrency 128 --token-budget 2000000
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";

import { formatContextPackage } from "../answer/formatContextPackage.js";
import { PromptLoader } from "../services/promptLoader.js";
import {
  AnswerOutputSchema,
  ContextPackageSchema,
  UNAVAILABLE_MEMORY_HYPOTHESIS,
  type ContextPackage,
} from "../types.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const DEFAULT_SOURCE_RUN = "hop-bag-downstream-answerable135-protocol1-3";
const DEFAULT_MODEL = "gpt-5.6-luna";
const DEFAULT_PROMPT = "answer-v8-preference";

type Reasoning = "low" | "medium" | "high";
type DatasetRow = {
  question_id: string;
  question_type: string;
  question: string;
  question_date: string;
};
type Usage = {
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  reasoning_tokens: number | null;
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
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      out[key] = "true";
    } else {
      out[key] = next;
      index += 1;
    }
  }
  return out;
}

function assertSlug(value: string, label: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`${label} may contain only letters, numbers, dots, underscores, and dashes`);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function promptText(messages: Array<{ role: string; content: string }>): string {
  return messages.map((message) => `<${message.role}>\n${message.content}`).join("\n\n");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function retryDelay(error: unknown, attempt: number): number | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!/rate|429|timeout|5\d\d|ECONNRESET|ETIMEDOUT|empty structured/i.test(message)) {
    return null;
  }
  const retryMatch = message.match(/try again in ([0-9.]+)\s*(ms|s)/i);
  let waitMs = 1000 * 2 ** attempt;
  if (retryMatch) {
    const amount = Number(retryMatch[1]);
    waitMs = retryMatch[2]?.toLowerCase() === "ms" ? amount : amount * 1000;
    waitMs = Math.max(500, waitMs + 250);
  }
  if (/429|rate limit/i.test(message)) waitMs = Math.max(waitMs, 2000);
  return Math.min(waitMs, 60_000);
}

class DispatchGate {
  readonly #budget: number;
  readonly #windowMs: number;
  readonly #maxConcurrency: number;
  #reservations: Array<{ at: number; tokens: number }> = [];
  #active = 0;

  constructor(budget: number, windowSeconds: number, maxConcurrency: number) {
    this.#budget = budget;
    this.#windowMs = windowSeconds * 1000;
    this.#maxConcurrency = maxConcurrency;
  }

  async acquire(tokens: number): Promise<() => void> {
    if (tokens > this.#budget) throw new Error("single request exceeds token budget");
    for (;;) {
      const now = Date.now();
      this.#reservations = this.#reservations.filter(
        (reservation) => now - reservation.at < this.#windowMs,
      );
      const reserved = this.#reservations.reduce((sum, item) => sum + item.tokens, 0);
      if (this.#active < this.#maxConcurrency && reserved + tokens <= this.#budget) {
        this.#active += 1;
        this.#reservations.push({ at: now, tokens });
        return () => {
          this.#active -= 1;
        };
      }
      await sleep(100);
    }
  }
}

async function mapPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  async function run(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) throw new Error("task pool contains a sparse item");
      await worker(item, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
}

function gitState(): { commit: string; dirty: boolean } {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
  }).trim();
  const dirty =
    execFileSync("git", ["status", "--porcelain"], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
    }).trim().length > 0;
  return { commit, dirty };
}

async function main(): Promise<void> {
  loadDotEnv(resolve(PROJECT_ROOT, ".env"));
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");
  const args = parseArgs(process.argv.slice(2));
  const sourceRunId = args["source-run"] ?? DEFAULT_SOURCE_RUN;
  const outPrefix = args["out-prefix"] ?? "hop-arm3-answerable135-luna";
  const model = args.model ?? DEFAULT_MODEL;
  const promptName = args.prompt ?? DEFAULT_PROMPT;
  const concurrency = Number(args.concurrency ?? "128");
  const tokenBudget = Number(args["token-budget"] ?? "2000000");
  const maxOutputTokens = Number(args["max-output-tokens"] ?? "8000");
  const limit = args.limit ? Number(args.limit) : null;
  assertSlug(sourceRunId, "source-run");
  assertSlug(outPrefix, "out-prefix");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 256) {
    throw new Error("--concurrency must be an integer in 1..256");
  }
  const reasoning = (args.reasoning ?? "low,medium")
    .split(",")
    .map((value) => value.trim())
    .filter(
      (value): value is Reasoning =>
        value === "low" || value === "medium" || value === "high",
    );
  if (reasoning.length === 0 || new Set(reasoning).size !== reasoning.length) {
    throw new Error("--reasoning must contain unique values from low,medium,high");
  }

  const sourceRoot = resolve(PROJECT_ROOT, "runs", sourceRunId);
  const sourceManifest = JSON.parse(
    readFileSync(resolve(sourceRoot, "manifest.json"), "utf8"),
  ) as {
    selected_question_ids: string[];
    dataset_hashes?: Record<string, string>;
    experiment?: Record<string, unknown>;
  };
  const questionIds =
    limit === null
      ? sourceManifest.selected_question_ids
      : sourceManifest.selected_question_ids.slice(0, limit);
  const dataset = JSON.parse(
    readFileSync(resolve(PROJECT_ROOT, "data/raw/longmemeval_s_cleaned.json"), "utf8"),
  ) as DatasetRow[];
  const byId = new Map(dataset.map((row) => [row.question_id, row]));
  const packages = new Map<string, ContextPackage>();
  for (const questionId of questionIds) {
    if (!byId.has(questionId)) throw new Error(`dataset is missing ${questionId}`);
    const packagePath = resolve(
      sourceRoot,
      "agent-artifacts/cases",
      questionId,
      "context-package.json",
    );
    packages.set(
      questionId,
      ContextPackageSchema.parse(JSON.parse(readFileSync(packagePath, "utf8"))),
    );
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
  const prompts = new PromptLoader();
  const gate = new DispatchGate(tokenBudget, 60, concurrency);
  const createdAt = new Date().toISOString();
  const repoGit = gitState();
  type State = {
    runId: string;
    root: string;
    manifest: Record<string, unknown>;
    completed: number;
    failed: number;
  };
  const states = new Map<Reasoning, State>();
  for (const effort of reasoning) {
    const runId = `${outPrefix}-${effort}`;
    const root = resolve(PROJECT_ROOT, "runs", runId);
    if (existsSync(root)) throw new Error(`output run already exists: ${runId}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(resolve(root, "predictions.jsonl"), "");
    writeFileSync(resolve(root, "errors.jsonl"), "");
    writeFileSync(
      resolve(root, "config.yaml"),
      [
        `name: ${runId}`,
        "mode: full-context",
        "experiment:",
        "  architecture: hop-arm3-answer-replay",
        `  source_run: ${sourceRunId}`,
        `  answer_prompt: ${promptName}`,
        `  answer_model: ${model}`,
        `  answer_reasoning: ${effort}`,
        `  request_concurrency: ${String(concurrency)}`,
        `  token_budget_per_minute: ${String(tokenBudget)}`,
        "",
      ].join("\n"),
    );
    const config = {
      name: runId,
      mode: "full-context",
      agent: {
        backend: "node",
        entrypoint: "src/agents/current/dist/host.js",
        provider_model_limits: [
          {
            provider: "openai",
            model,
            max_concurrency: concurrency,
            token_budget: tokenBudget,
            window_seconds: 60,
          },
        ],
        models: {},
        options: {
          architecture: "hop-arm3-answer-replay",
          source_run: sourceRunId,
          answer_prompt: promptName,
        },
      },
      answer: {
        provider: "openai",
        model,
        temperature: 1,
        reasoning_effort: effort,
        max_output_tokens: maxOutputTokens,
        timeout_seconds: 300,
        concurrency,
        max_retries: 6,
      },
      judge: {
        provider: "openai",
        model: "gpt-4o-2024-08-06",
        temperature: 0,
      },
      selection: { strategy: "question-ids" },
      execution: {
        case_concurrency: concurrency,
        capture_model_io: false,
        auto_export_final_svg: false,
      },
    };
    const manifest: Record<string, unknown> = {
      schema_version: 2,
      run_id: runId,
      status: "running",
      created_at: createdAt,
      updated_at: createdAt,
      config_source: `runs/${runId}/config.yaml`,
      config,
      config_fingerprint: sha256(JSON.stringify(config)),
      git: repoGit,
      dataset_hashes: sourceManifest.dataset_hashes ?? {},
      dataset_mode: "full-context",
      selected_question_ids: questionIds,
      selected_count: questionIds.length,
      selection: {
        strategy: "question-ids",
        population_count: dataset.length,
        sample_count: questionIds.length,
        is_canary: false,
      },
      completed_count: 0,
      failure_count: 0,
      experiment: {
        architecture: "hop-arm3-answer-replay",
        source_run: sourceRunId,
        source_experiment: sourceManifest.experiment ?? {},
        answer_model: model,
        answer_reasoning: effort,
        answer_prompt: promptName,
      },
    };
    writeFileSync(resolve(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    states.set(effort, { runId, root, manifest, completed: 0, failed: 0 });
  }

  const tasks: Array<{ questionId: string; effort: Reasoning }> = [];
  for (let index = 0; index < questionIds.length; index += 1) {
    const questionId = questionIds[index];
    if (!questionId) continue;
    const ordered =
      index % 2 === 0 ? reasoning : [...reasoning].reverse();
    for (const effort of ordered) tasks.push({ questionId, effort });
  }
  let globalDone = 0;
  const started = Date.now();
  console.log(
    JSON.stringify({
      event: "start",
      source_run: sourceRunId,
      cases: questionIds.length,
      reasoning,
      tasks: tasks.length,
      model,
      concurrency,
      token_budget: tokenBudget,
    }),
  );

  await mapPool(tasks, concurrency, async ({ questionId, effort }) => {
    const state = states.get(effort);
    if (!state) throw new Error(`missing state for reasoning ${effort}`);
    const row = byId.get(questionId);
    if (!row) throw new Error(`dataset is missing ${questionId}`);
    const pkg = packages.get(questionId);
    if (!pkg) throw new Error(`context package is missing ${questionId}`);
    try {
      const prompt = await prompts.render(promptName, {
        question: row.question,
        question_date: row.question_date,
        context_package: formatContextPackage(pkg),
      });
      const inputText = promptText(prompt.messages);
      let lastError: unknown;
      for (let attempt = 0; attempt <= 6; attempt += 1) {
        const reservation =
          Math.ceil(Buffer.byteLength(inputText, "utf8") / 3) + 3000;
        const release = await gate.acquire(reservation);
        const callStarted = performance.now();
        try {
          const response = await openai.responses.parse(
            {
              model,
              input: prompt.messages,
              max_output_tokens: maxOutputTokens,
              reasoning: { effort },
              text: { format: zodTextFormat(AnswerOutputSchema, "answer_v1") },
            },
            { timeout: 300_000 },
          );
          const parsed = response.output_parsed;
          if (!parsed) throw new Error("empty structured output");
          const answer = AnswerOutputSchema.parse(parsed);
          const latency = performance.now() - callStarted;
          const usage: Usage = {
            input_tokens: response.usage?.input_tokens ?? null,
            output_tokens: response.usage?.output_tokens ?? null,
            total_tokens: response.usage?.total_tokens ?? null,
            reasoning_tokens:
              response.usage?.output_tokens_details.reasoning_tokens ?? null,
          };
          const validRefs = new Set(
            pkg.items.map((item) => `${item.sessionId}:${String(item.turnIndex)}`),
          );
          const evidence = answer.evidence
            .filter(
              (item) =>
                item.turnIndex === null
                || validRefs.has(`${item.sessionId}:${String(item.turnIndex)}`),
            )
            .map((item) => ({
              session_id: item.sessionId,
              turn_index: item.turnIndex,
            }));
          const hypothesis =
            answer.supportStatus === "insufficient" && !answer.hypothesis.trim()
              ? UNAVAILABLE_MEMORY_HYPOTHESIS
              : answer.hypothesis;
          const prediction = {
            question_id: questionId,
            question_type: row.question_type,
            hypothesis,
            evidence,
            trace: {
              architecture_id: "hop-arm3-answer-replay",
              source_run: sourceRunId,
              source_package_item_count: pkg.items.length,
              source_package_character_count: pkg.characterCount,
              answer_prompt: promptName,
              answer_model: model,
              answer_reasoning: effort,
              support_status: answer.supportStatus,
              invalid_answer_evidence_count:
                answer.evidence.length - evidence.length,
              answer_call_count: 1,
            },
            generation: {
              text: response.output_text,
              model,
              provider: "openai",
              usage,
              latency_ms: latency,
              request_id: response._request_id ?? null,
              retry_count: attempt,
            },
            model_calls: [
              {
                sequence: 1,
                role: "answer",
                kind: "generation",
                provider: "openai",
                model,
                input_sha256: sha256(inputText),
                item_count: 1,
                parameters: {
                  temperature: 1,
                  reasoning_effort: effort,
                  max_output_tokens: maxOutputTokens,
                },
                usage,
                latency_ms: latency,
                request_id: response._request_id ?? null,
                retry_count: attempt,
              },
            ],
          };
          appendFileSync(
            resolve(state.root, "predictions.jsonl"),
            `${JSON.stringify(prediction)}\n`,
          );
          state.completed += 1;
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          const waitMs = retryDelay(error, attempt);
          if (waitMs === null || attempt === 6) break;
          await sleep(waitMs);
        } finally {
          release();
        }
      }
      if (lastError !== undefined) {
        if (lastError instanceof Error) {
          throw lastError;
        }
        const message =
          typeof lastError === "string"
            ? lastError
            : typeof lastError === "number" || typeof lastError === "boolean"
              ? String(lastError)
              : "unknown answer replay failure";
        throw new Error(message);
      }
    } catch (error) {
      state.failed += 1;
      appendFileSync(
        resolve(state.root, "errors.jsonl"),
        `${JSON.stringify({
          question_id: questionId,
          error_type: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        })}\n`,
      );
      console.error(
        JSON.stringify({
          event: "case_failed",
          effort,
          question_id: questionId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    globalDone += 1;
    state.manifest.updated_at = new Date().toISOString();
    state.manifest.completed_count = state.completed;
    state.manifest.failure_count = state.failed;
    writeFileSync(
      resolve(state.root, "manifest.json"),
      `${JSON.stringify(state.manifest, null, 2)}\n`,
    );
    if (globalDone % 20 === 0 || globalDone === tasks.length) {
      const elapsedSeconds = (Date.now() - started) / 1000;
      console.log(
        JSON.stringify({
          event: "progress",
          done: globalDone,
          total: tasks.length,
          elapsed_s: Math.round(elapsedSeconds),
          rate_per_min: Number(((globalDone / elapsedSeconds) * 60).toFixed(1)),
          by_reasoning: Object.fromEntries(
            [...states.entries()].map(([name, current]) => [
              name,
              { completed: current.completed, failed: current.failed },
            ]),
          ),
        }),
      );
    }
  });

  const completedAt = new Date().toISOString();
  for (const state of states.values()) {
    const complete = state.completed === questionIds.length && state.failed === 0;
    state.manifest.status = complete ? "completed" : "partial";
    state.manifest.updated_at = completedAt;
    state.manifest.completed_at = complete ? completedAt : null;
    writeFileSync(
      resolve(state.root, "manifest.json"),
      `${JSON.stringify(state.manifest, null, 2)}\n`,
    );
  }
  console.log(
    JSON.stringify({
      event: "done",
      elapsed_s: Math.round((Date.now() - started) / 1000),
      runs: Object.fromEntries(
        [...states.entries()].map(([effort, state]) => [
          effort,
          {
            run_id: state.runId,
            completed: state.completed,
            failed: state.failed,
          },
        ]),
      ),
    }),
  );
  if ([...states.values()].some((state) => state.failed > 0)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
