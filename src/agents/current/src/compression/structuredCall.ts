import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import type OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { getEncoding } from "js-tiktoken";
import type { z } from "zod";

import { assertNoRawSessionIdLeak } from "../retrieval/opaqueSessionIds.js";
import type { PromptEnvelope } from "../services/promptLoader.js";

export type ReasoningEffort = "low" | "medium" | "high";

export type TokenUsage = {
  input_tokens: number | null;
  cached_input_tokens: number | null;
  cache_write_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  reasoning_tokens: number | null;
};

export type StructuredCallResult<T> = {
  value: T;
  outputText: string;
  usage: TokenUsage;
  latencyMs: number;
  requestId: string | null;
  retryCount: number;
  inputSha256: string;
  promptCacheKey: string | null;
  estimatedCostUsd: number;
  promptMessages: PromptEnvelope["messages"];
  responseStatus: string;
  incompleteReason: string | null;
};

export type StructuredCallAttemptTrace = {
  attemptNumber: number;
  status: string | null;
  incompleteReason: string | null;
  outputText: string;
  usage: TokenUsage | null;
  latencyMs: number;
  requestId: string | null;
  estimatedCostUsd: number;
  error: string | null;
};

export function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals <= 0) continue;
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function promptText(prompt: PromptEnvelope): string {
  return prompt.messages.map((message) => `<${message.role}>\n${message.content}`).join("\n\n");
}

const O200K = getEncoding("o200k_base");

export function estimateInputTokens(prompt: PromptEnvelope): number {
  // Responses usage also includes message and structured-schema framing that
  // is absent from promptText. The 2% margin plus fixed reserve keeps cost and
  // TPM gates conservative without the large distortion of byte heuristics.
  return Math.ceil(O200K.encode(promptText(prompt)).length * 1.02) + 2_048;
}

const UNSUPPORTED_OPENAI_SCHEMA_KEYWORDS = new Set([
  "propertyNames",
  "patternProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
]);

/** Zero-cost guard for JSON-Schema constructs rejected by Structured Outputs. */
export function assertOpenAiStructuredOutputSchemaCompatible<T>(
  schema: z.ZodType<T>,
  schemaName: string,
): void {
  const format = zodTextFormat(schema, schemaName) as unknown as Record<string, unknown>;
  const violations: string[] = [];
  const visit = (value: unknown, path: string[]): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, [...path, String(index)]));
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = [...path, key];
      if (UNSUPPORTED_OPENAI_SCHEMA_KEYWORDS.has(key)) violations.push(childPath.join("/"));
      visit(child, childPath);
    }
  };
  visit(format, []);
  if (violations.length > 0) {
    throw new Error(`structured-output schema ${schemaName} uses unsupported keywords at ${violations.join(", ")}`);
  }
}

type ModelPricing = {
  input: number;
  cachedInput: number;
  output: number;
  longContext?: {
    threshold: number;
    inputMultiplier: number;
    outputMultiplier: number;
  };
};

const AUDITED_PRICE_TABLE = {
  version: "2026-08-10-luna-80pct-cut",
  models: {
    "gpt-5.6-luna": {
      input: 0.2,
      cachedInput: 0.02,
      output: 1.2,
      longContext: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
    },
    "gpt-5.4-nano": { input: 0.2, cachedInput: 0.02, output: 1.25 },
  },
} as const;

export function priceTableSha256(): string {
  return createHash("sha256").update(JSON.stringify(AUDITED_PRICE_TABLE)).digest("hex");
}

export function pricingForModel(model: string): ModelPricing {
  if (model.startsWith("gpt-5.6-luna")) {
    return AUDITED_PRICE_TABLE.models["gpt-5.6-luna"];
  }
  if (model.startsWith("gpt-5.4-nano")) {
    return AUDITED_PRICE_TABLE.models["gpt-5.4-nano"];
  }
  throw new Error(`no audited pricing configured for ${model}`);
}

export function usageCost(model: string, usage: TokenUsage): number {
  const pricing = pricingForModel(model);
  const inputTokens = usage.input_tokens ?? 0;
  const cachedInputTokens = Math.min(usage.cached_input_tokens ?? 0, inputTokens);
  const cacheWriteTokens = Math.min(
    usage.cache_write_tokens ?? 0,
    inputTokens - cachedInputTokens,
  );
  const uncachedInputTokens = inputTokens - cachedInputTokens - cacheWriteTokens;
  const longContext = pricing.longContext && inputTokens > pricing.longContext.threshold
    ? pricing.longContext
    : null;
  const inputMultiplier = longContext?.inputMultiplier ?? 1;
  const outputMultiplier = longContext?.outputMultiplier ?? 1;
  return (
    (
      uncachedInputTokens * pricing.input
      + cachedInputTokens * pricing.cachedInput
      + cacheWriteTokens * pricing.input * 1.25
    ) * inputMultiplier
    + (usage.output_tokens ?? 0) * pricing.output * outputMultiplier
  ) / 1_000_000;
}

function estimatedUsageCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  promptCache: boolean,
): number {
  return usageCost(model, {
    input_tokens: inputTokens,
    cached_input_tokens: 0,
    cache_write_tokens: promptCache && model.startsWith("gpt-5.6") ? inputTokens : 0,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    reasoning_tokens: 0,
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function retryDelay(error: unknown, attempt: number): number | null {
  const message = error instanceof Error ? error.message : String(error);
  if (/no credits remaining|billing|insufficient_quota/i.test(message)) return null;
  if (!/rate|429|timeout|connection error|5\d\d|ECONNRESET|ETIMEDOUT/i.test(message)) return null;
  const retryMatch = message.match(/try again in ([0-9.]+)\s*(ms|s)/i);
  let waitMs = 1000 * 2 ** attempt;
  if (retryMatch) {
    const amount = Number(retryMatch[1]);
    waitMs = retryMatch[2]?.toLowerCase() === "ms" ? amount : amount * 1000;
    waitMs = Math.max(500, waitMs + 250);
  }
  if (/429|rate limit/i.test(message)) waitMs = Math.max(waitMs, 2_000);
  return Math.min(waitMs, 60_000);
}

export class DispatchGate {
  readonly #tokenBudget: number;
  readonly #windowMs: number;
  readonly #maxConcurrency: number;
  #reservations: Array<{ at: number; tokens: number }> = [];
  #active = 0;

  constructor(tokenBudget: number, windowSeconds: number, maxConcurrency: number) {
    this.#tokenBudget = tokenBudget;
    this.#windowMs = windowSeconds * 1000;
    this.#maxConcurrency = maxConcurrency;
  }

  async acquire(tokens: number): Promise<() => void> {
    if (tokens > this.#tokenBudget) {
      throw new Error(`single request reservation ${String(tokens)} exceeds token budget`);
    }
    for (;;) {
      const now = Date.now();
      this.#reservations = this.#reservations.filter(
        (reservation) => now - reservation.at < this.#windowMs,
      );
      const reserved = this.#reservations.reduce((sum, reservation) => sum + reservation.tokens, 0);
      if (this.#active < this.#maxConcurrency && reserved + tokens <= this.#tokenBudget) {
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

export class CostBudget {
  readonly #ceiling: number;
  #spent: number;
  #reserved = 0;

  constructor(ceilingUsd: number, initialSpentUsd = 0) {
    if (!(ceilingUsd > 0)) throw new Error("cost ceiling must be positive");
    if (initialSpentUsd < 0 || initialSpentUsd > ceilingUsd) throw new Error("initial spend is outside the ceiling");
    this.#ceiling = ceilingUsd;
    this.#spent = initialSpentUsd;
  }

  reserve(estimatedUsd: number): (actualUsd: number | null) => void {
    if (this.#spent + this.#reserved + estimatedUsd > this.#ceiling + 1e-9) {
      throw new Error(
        `cost ceiling would be exceeded: spent=$${this.#spent.toFixed(4)} reserved=$${this.#reserved.toFixed(4)} next=$${estimatedUsd.toFixed(4)} ceiling=$${this.#ceiling.toFixed(2)}`,
      );
    }
    this.#reserved += estimatedUsd;
    let settled = false;
    return (actualUsd: number | null): void => {
      if (settled) return;
      settled = true;
      this.#reserved -= estimatedUsd;
      this.#spent += actualUsd ?? estimatedUsd;
    };
  }

  snapshot(): { ceiling_usd: number; spent_usd: number; reserved_usd: number; remaining_usd: number } {
    const reserved = Math.abs(this.#reserved) < 1e-12 ? 0 : this.#reserved;
    return {
      ceiling_usd: this.#ceiling,
      spent_usd: this.#spent,
      reserved_usd: reserved,
      remaining_usd: Math.max(0, this.#ceiling - this.#spent - reserved),
    };
  }
}

export async function callStructured<T>(args: {
  openai: OpenAI;
  dispatch: DispatchGate;
  costBudget: CostBudget;
  model: string;
  reasoning: ReasoningEffort;
  prompt: PromptEnvelope;
  schema: z.ZodType<T>;
  schemaName: string;
  maxOutputTokens: number;
  /** TPM reservation only; the API output ceiling remains maxOutputTokens. */
  dispatchOutputTokens?: number;
  rawSessionIdsForLeakCheck?: string[];
  promptCache?: boolean;
  onAttempt?: (trace: StructuredCallAttemptTrace) => void | Promise<void>;
}): Promise<StructuredCallResult<T>> {
  assertOpenAiStructuredOutputSchemaCompatible(args.schema, args.schemaName);
  const serialized = promptText(args.prompt);
  const inputSha256 = createHash("sha256").update(serialized).digest("hex");
  const promptCache = args.promptCache ?? true;
  const promptCacheKey = promptCache && args.model.startsWith("gpt-5.6")
    ? `beam-compression:${inputSha256.slice(0, 47)}`
    : null;
  assertNoRawSessionIdLeak(serialized, args.rawSessionIdsForLeakCheck ?? []);
  const inputEstimate = estimateInputTokens(args.prompt);
  const estimatedCost = estimatedUsageCost(
    args.model,
    inputEstimate,
    args.maxOutputTokens,
    promptCache,
  );
  const dispatchOutputTokens = args.dispatchOutputTokens ?? args.maxOutputTokens;
  if (!(dispatchOutputTokens > 0) || dispatchOutputTokens > args.maxOutputTokens) {
    throw new Error("dispatchOutputTokens must be positive and no greater than maxOutputTokens");
  }
  let lastError: unknown;
  for (let attempt = 0; attempt <= 6; attempt += 1) {
    const releaseDispatch = await args.dispatch.acquire(inputEstimate + dispatchOutputTokens);
    let settleCost: (actualUsd: number | null) => void;
    try {
      settleCost = args.costBudget.reserve(estimatedCost);
    } catch (error) {
      releaseDispatch();
      throw error;
    }
    const started = performance.now();
    let settled = false;
    let traceEmitted = false;
    try {
      const response = await args.openai.responses.parse({
          model: args.model,
          input: args.prompt.messages,
          max_output_tokens: args.maxOutputTokens,
          reasoning: { effort: args.reasoning },
          text: { format: zodTextFormat(args.schema, args.schemaName) },
          ...(promptCacheKey ? {
            prompt_cache_key: promptCacheKey,
            prompt_cache_options: { ttl: "30m" as const },
          } : {}),
      }, { timeout: 600_000 });
      const incompleteReason = response.incomplete_details?.reason ?? null;
      const usage: TokenUsage = {
        input_tokens: response.usage?.input_tokens ?? null,
        cached_input_tokens: response.usage?.input_tokens_details.cached_tokens ?? null,
        cache_write_tokens: (
            response.usage?.input_tokens_details as { cache_write_tokens?: number } | undefined
        )?.cache_write_tokens ?? null,
        output_tokens: response.usage?.output_tokens ?? null,
        total_tokens: response.usage?.total_tokens ?? null,
        reasoning_tokens: response.usage?.output_tokens_details.reasoning_tokens ?? null,
      };
      const actualCost = usageCost(args.model, usage);
      settleCost(actualCost);
      settled = true;
      await args.onAttempt?.({
        attemptNumber: attempt,
        status: response.status,
        incompleteReason,
        outputText: response.output_text,
        usage,
        latencyMs: performance.now() - started,
        requestId: response._request_id ?? null,
        estimatedCostUsd: actualCost,
        error: null,
      });
      traceEmitted = true;
      if (response.status !== "completed" || incompleteReason !== null) {
        throw new Error(
          `structured response incomplete: status=${response.status} reason=${incompleteReason ?? "unknown"}`,
        );
      }
      if (response.output_parsed === null || response.output_parsed === undefined) {
        throw new Error("empty structured output");
      }
      const value = args.schema.parse(response.output_parsed);
      return {
        value,
        outputText: response.output_text,
        usage,
        latencyMs: performance.now() - started,
        requestId: response._request_id ?? null,
        retryCount: attempt,
        inputSha256,
        promptCacheKey,
        estimatedCostUsd: actualCost,
        promptMessages: args.prompt.messages,
        responseStatus: response.status,
        incompleteReason,
      };
    } catch (error) {
      lastError = error;
      if (!settled) {
        settleCost(null);
        settled = true;
      }
      if (!traceEmitted) {
        await args.onAttempt?.({
          attemptNumber: attempt,
          status: null,
          incompleteReason: null,
          outputText: "",
          usage: null,
          latencyMs: performance.now() - started,
          requestId: null,
          estimatedCostUsd: estimatedCost,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const waitMs = retryDelay(error, attempt);
      if (waitMs === null || attempt === 6) break;
      await sleep(waitMs);
    } finally {
      releaseDispatch();
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  async function run(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) throw new Error("task pool contains a sparse item");
      output[index] = await worker(item, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return output;
}
