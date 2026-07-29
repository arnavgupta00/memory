/**
 * Answer-only replay: reuse frozen 0005.4 context packages, re-run Call-2 with
 * answer-v8-preference. Skips select/retrieval (~5–6× faster under the 200k/min
 * token budget).
 *
 * Usage:
 *   pnpm --dir src/agents/current exec node --import tsx \
 *     src/scripts/answerOnlyReplay.ts \
 *     --source runs/20260727T121620.057854Z-architecture-0005.4-canary1-full-session \
 *     --out-run architecture-0005.4.3-answer-replay-canary1 \
 *     --prompt answer-v8-preference \
 *     --concurrency 24
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { finished } from "node:stream/promises";

import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";

import { formatContextPackage } from "../answer/formatContextPackage.js";
import { PromptLoader } from "../services/promptLoader.js";
import {
  AnswerOutputSchema,
  type ContextPackage,
  type ContextPackageItem,
} from "../types.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");

type Session = {
  session_id: string;
  date: string;
  turns: Array<{ role: "user" | "assistant"; content: string }>;
};

type ArtifactPackageItem = {
  session_id: string;
  turn_index: number;
  date: string;
  role: "user" | "assistant";
  why: string;
  tier: "selected" | "supporting";
};

type ArtifactAnswer = {
  hypothesis: string;
  evidence: Array<{ session_id: string; turn_index: number | null }>;
  trace: {
    support_status?: string;
    context_package: {
      query_shape: ContextPackage["queryShape"];
      set_boundary: string;
      candidate_status: ContextPackage["candidateStatus"];
      missing_risk: string;
      items: ArtifactPackageItem[];
    };
  };
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
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      out[key] = "true";
    } else {
      out[key] = value;
      i += 1;
    }
  }
  return out;
}

function loadSessions(caseDir: string): Map<string, Session> {
  const map = new Map<string, Session>();
  for (const line of readFileSync(resolve(caseDir, "sessions.jsonl"), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const session = JSON.parse(line) as Session;
    map.set(session.session_id, session);
  }
  return map;
}

function rebuildPackage(answer: ArtifactAnswer, sessions: Map<string, Session>): ContextPackage {
  const raw = answer.trace.context_package;
  const items: ContextPackageItem[] = [];
  let characterCount = 0;
  for (const item of raw.items ?? []) {
    const session = sessions.get(item.session_id);
    const turn = session?.turns[item.turn_index];
    const text = turn?.content ?? "";
    characterCount += text.length;
    items.push({
      sessionId: item.session_id,
      turnIndex: item.turn_index,
      date: item.date || session?.date || "",
      role: item.role,
      text,
      why: item.why ?? "",
      tier: item.tier,
    });
  }
  return {
    queryShape: raw.query_shape,
    setBoundary: raw.set_boundary,
    candidateStatus: raw.candidate_status,
    missingRisk: raw.missing_risk,
    items,
    characterCount,
    estimatedTokens: Math.ceil(characterCount / 4),
  };
}

class TokenWindowLimiter {
  readonly #budget: number;
  readonly #windowMs: number;
  #events: Array<{ at: number; tokens: number }> = [];
  #chain: Promise<void> = Promise.resolve();

  constructor(budget: number, windowSeconds: number) {
    this.#budget = budget;
    this.#windowMs = windowSeconds * 1000;
  }

  async acquire(tokens: number): Promise<void> {
    const run = async (): Promise<void> => {
      for (;;) {
        const now = Date.now();
        this.#events = this.#events.filter((event) => now - event.at < this.#windowMs);
        const used = this.#events.reduce((sum, event) => sum + event.tokens, 0);
        if (used + tokens <= this.#budget) {
          this.#events.push({ at: now, tokens });
          return;
        }
        const oldest = this.#events[0];
        const waitMs = oldest ? Math.max(25, this.#windowMs - (now - oldest.at) + 5) : 25;
        await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
      }
    };
    const next = this.#chain.then(run, run);
    this.#chain = next.catch(() => undefined);
    await next;
  }
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function run(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return results;
}

async function main(): Promise<void> {
  loadDotEnv(resolve(PROJECT_ROOT, ".env"));
  const args = parseArgs(process.argv.slice(2));
  const sourceRel = args.source;
  const outRunId = args["out-run"];
  const promptName = args.prompt ?? "answer-v8-preference";
  const concurrency = Number(args.concurrency ?? "24");
  const tokenBudget = Number(args["token-budget"] ?? "200000");
  const model = args.model ?? "gpt-5.4-nano-2026-03-17";
  if (!sourceRel || !outRunId) {
    throw new Error(
      "usage: answerOnlyReplay.ts --source <run-dir> --out-run <run-id> [--prompt answer-v8-preference] [--concurrency 24]",
    );
  }
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");

  const sourceRoot = resolve(PROJECT_ROOT, sourceRel);
  const outRoot = resolve(PROJECT_ROOT, "runs", outRunId);
  const casesRoot = resolve(sourceRoot, "agent-artifacts/cases");
  const sourceManifest = JSON.parse(readFileSync(resolve(sourceRoot, "manifest.json"), "utf8")) as {
    selected_question_ids: string[];
  };
  const questionIds = sourceManifest.selected_question_ids;
  const dataset = JSON.parse(
    readFileSync(resolve(PROJECT_ROOT, "data/raw/longmemeval_s_cleaned.json"), "utf8"),
  ) as Array<{ question_id: string; question: string; question_date: string; question_type: string }>;
  const byId = new Map(dataset.map((row) => [row.question_id, row]));

  mkdirSync(outRoot, { recursive: true });
  writeFileSync(
    resolve(outRoot, "config.yaml"),
    [
      `name: ${outRunId}`,
      "mode: answer-only-replay",
      `source_run: ${sourceRel}`,
      `answer_prompt: ${promptName}`,
      `model: ${model}`,
      `concurrency: ${String(concurrency)}`,
      `token_budget_per_minute: ${String(tokenBudget)}`,
      "",
    ].join("\n"),
  );

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
  const prompts = new PromptLoader();
  const limiter = new TokenWindowLimiter(tokenBudget, 60);
  const predictionsPath = resolve(outRoot, "predictions.jsonl");
  const errorsPath = resolve(outRoot, "errors.jsonl");
  const predStream = createWriteStream(predictionsPath, { flags: "w" });
  const errStream = createWriteStream(errorsPath, { flags: "w" });
  let writeChain: Promise<void> = Promise.resolve();
  const writePred = (row: unknown): void => {
    writeChain = writeChain.then(
      () =>
        new Promise<void>((resolveWrite, rejectWrite) => {
          predStream.write(`${JSON.stringify(row)}\n`, (error) => {
            if (error) rejectWrite(error);
            else resolveWrite();
          });
        }),
    );
  };
  const writeErr = (row: unknown): void => {
    writeChain = writeChain.then(
      () =>
        new Promise<void>((resolveWrite, rejectWrite) => {
          errStream.write(`${JSON.stringify(row)}\n`, (error) => {
            if (error) rejectWrite(error);
            else resolveWrite();
          });
        }),
    );
  };

  let done = 0;
  let failed = 0;
  const started = Date.now();
  console.log(
    JSON.stringify({
      event: "start",
      cases: questionIds.length,
      concurrency,
      tokenBudget,
      promptName,
      sourceRel,
      outRunId,
    }),
  );

  await mapPool(questionIds, concurrency, async (questionId) => {
    const caseDir = resolve(casesRoot, questionId);
    const meta = byId.get(questionId);
    if (!meta) throw new Error(`missing dataset row ${questionId}`);
    try {
      const answer = JSON.parse(
        readFileSync(resolve(caseDir, "answer.json"), "utf8"),
      ) as ArtifactAnswer;
      const sessions = loadSessions(caseDir);
      const pkg = rebuildPackage(answer, sessions);
      const prompt = await prompts.render(promptName, {
        question: meta.question,
        question_date: meta.question_date,
        context_package: formatContextPackage(pkg),
      });
      const estTokens = Math.max(512, pkg.estimatedTokens + 800);
      await limiter.acquire(estTokens);

      let lastError: unknown;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          const response = await openai.responses.parse(
            {
              model,
              input: prompt.messages,
              max_output_tokens: 16_000,
              temperature: 1,
              reasoning: { effort: "medium" },
              text: { format: zodTextFormat(AnswerOutputSchema, "answer_v1") },
            },
            { timeout: 300_000 },
          );
          const parsed = AnswerOutputSchema.parse(response.output_parsed);
          const hypothesis =
            parsed.supportStatus === "insufficient" && !parsed.hypothesis.trim()
              ? "The available memory does not contain this information."
              : parsed.hypothesis;
          writePred({
            question_id: questionId,
            question_type: meta.question_type,
            hypothesis,
            evidence: parsed.evidence.map((item) => ({
              session_id: item.sessionId,
              turn_index: item.turnIndex,
            })),
            trace: {
              architecture_id: "0005.4.3-answer-replay",
              support_status: parsed.supportStatus,
              evidence_table: parsed.evidenceTable,
              source_package_item_count: pkg.items.length,
              replay: true,
              prompt: promptName,
            },
            generation: {
              model,
              provider: "openai",
              latency_ms: null,
              request_id: response._request_id ?? null,
              retry_count: attempt,
              text: response.output_text,
            },
            model_calls: {
              answer: {
                input_tokens: response.usage?.input_tokens ?? null,
                output_tokens: response.usage?.output_tokens ?? null,
                total_tokens: response.usage?.total_tokens ?? null,
              },
            },
          });
          done += 1;
          if (done % 10 === 0 || done === questionIds.length) {
            const elapsed = (Date.now() - started) / 1000;
            console.log(
              JSON.stringify({
                event: "progress",
                done,
                failed,
                total: questionIds.length,
                elapsed_s: Math.round(elapsed),
                rate_per_min: Number(((done / elapsed) * 60).toFixed(1)),
              }),
            );
          }
          return;
        } catch (error) {
          lastError = error;
          const message = error instanceof Error ? error.message : String(error);
          const retryable = /rate|429|timeout|5\d\d|ECONNRESET|ETIMEDOUT/i.test(message);
          if (!retryable || attempt === 5) break;
          const retryMatch = message.match(/try again in ([0-9.]+)\s*(ms|s)/i);
          let waitMs = 1000 * 2 ** attempt;
          if (retryMatch) {
            const amount = Number(retryMatch[1]);
            waitMs = retryMatch[2]?.toLowerCase() === "ms" ? amount : amount * 1000;
            waitMs = Math.max(waitMs + 250, 500);
          }
          // TPM windows need headroom after a hard 429.
          if (/429|rate limit/i.test(message)) waitMs = Math.max(waitMs, 2000);
          await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
        }
      }
      failed += 1;
      writeErr({
        question_id: questionId,
        error_type: "AnswerReplayError",
        message: lastError instanceof Error ? lastError.message : String(lastError),
      });
      console.error(JSON.stringify({ event: "case_failed", questionId, error: String(lastError) }));
    } catch (error) {
      failed += 1;
      writeErr({
        question_id: questionId,
        error_type: "AnswerReplaySetupError",
        message: error instanceof Error ? error.message : String(error),
      });
      console.error(JSON.stringify({ event: "case_failed", questionId, error: String(error) }));
    }
  });

  await writeChain;
  predStream.end();
  errStream.end();
  await finished(predStream);
  await finished(errStream);

  const completed = failed === 0;
  writeFileSync(
    resolve(outRoot, "manifest.json"),
    JSON.stringify(
      {
        run_id: outRunId,
        mode: "answer-only-replay",
        source_run: sourceRel,
        answer_prompt: promptName,
        model,
        selected_question_ids: questionIds,
        selected_count: questionIds.length,
        completed_count: done,
        failure_count: failed,
        status: completed ? "completed" : "partial",
        completed_at: completed ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      event: "done",
      done,
      failed,
      outRoot,
      elapsed_s: Math.round((Date.now() - started) / 1000),
    }),
  );
  if (!completed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
