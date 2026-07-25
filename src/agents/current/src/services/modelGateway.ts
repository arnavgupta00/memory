import { performance } from "node:perf_hooks";

import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

import type {
  ProviderModelLimitConfig,
  RoleConfigs,
  RoleName,
} from "../config.js";
import {
  ModelCallRecordSchema,
  type JsonObject,
  type JsonValue,
  type ModelCallRecord,
  type PromptEnvelope,
  type ProviderRoleConfig,
  type TokenUsage,
} from "../types.js";
import { sha256 } from "./artifacts.js";
import type { ArtifactStore } from "./artifacts.js";
import { errorMessage } from "./redaction.js";
import {
  ProviderModelRateLimiter,
  RateScheduleRecorder,
  providerModelKey,
  type ProviderModelLimit,
  type RateLimitDispatch,
  type RateLimitLease,
} from "./providerModelRateLimiter.js";
import { isRetryableProviderError } from "./retryPolicy.js";
import { RoleSemaphore } from "./roleSemaphore.js";

export type NormalizedGeneration = {
  text: string;
  model: string;
  provider: "openai" | "gemini";
  usage: TokenUsage;
  latency_ms: number;
  request_id: string | null;
  retry_count: number;
};

export type StructuredGeneration<T> = {
  value: T;
  rawText: string;
  generation: NormalizedGeneration;
  call: ModelCallRecord;
  reused: boolean;
};

type ProviderResult<T> = {
  value: T;
  rawText: string;
  usage: TokenUsage;
  requestId: string | null;
};

class EmptyStructuredOutputError extends Error {
  override readonly name = "EmptyStructuredOutputError";
}

export type ProviderExecutorRequest = {
  role: RoleName;
  config: ProviderRoleConfig;
  prompt: PromptEnvelope;
  schemaName: string;
};

export type ProviderExecutorResult = {
  value: unknown;
  rawText: string;
  usage: TokenUsage;
  requestId: string | null;
};

export type ProviderExecutor = (request: ProviderExecutorRequest) => Promise<ProviderExecutorResult>;
export type ProviderExecutors = Partial<Record<"openai" | "gemini", ProviderExecutor>>;

type ModelGatewayOptions = {
  providerModelLimits?: ProviderModelLimitConfig[];
  scheduleRecorder?: RateScheduleRecorder;
  hydratedDispatches?: RateLimitDispatch[];
};

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function promptText(prompt: PromptEnvelope): string {
  return prompt.messages.map((message) => `<${message.role}>\n${message.content}`).join("\n\n");
}

function safeCallKey(value: string): string {
  if (!/^[a-z][a-z0-9:-]*$/.test(value)) throw new Error(`unsafe model call key: ${value}`);
  return value.replaceAll(":", "-");
}

function jsonParameters(config: ProviderRoleConfig): JsonObject {
  return {
    temperature: config.temperature,
    max_output_tokens: config.max_output_tokens,
    reasoning_effort: config.reasoning_effort ?? null,
  };
}

function retryable(error: unknown): boolean {
  if (error instanceof EmptyStructuredOutputError) return true;
  return isRetryableProviderError(error);
}

export class ModelGateway {
  readonly #roles: RoleConfigs;
  readonly #captureModelIo: boolean;
  readonly #executors: ProviderExecutors;
  readonly #semaphores: Record<RoleName, RoleSemaphore>;
  readonly #sharedLimiters = new Map<string, ProviderModelRateLimiter>();
  readonly #lastRequestAt: Partial<Record<RoleName, number>> = {};
  #openai: OpenAI | null = null;
  #gemini: GoogleGenAI | null = null;

  constructor(
    roles: RoleConfigs,
    captureModelIo: boolean,
    executors: ProviderExecutors = {},
    options: ModelGatewayOptions = {},
  ) {
    this.#roles = roles;
    this.#captureModelIo = captureModelIo;
    this.#executors = executors;
    this.#semaphores = {
      answer: new RoleSemaphore(roles.answer.concurrency),
    };
    for (const configured of options.providerModelLimits ?? []) {
      const limit: ProviderModelLimit = {
        provider: configured.provider,
        model: configured.model,
        maxConcurrency: configured.max_concurrency,
        tokenBudget: configured.token_budget,
        windowSeconds: configured.window_seconds,
      };
      const recorder = options.scheduleRecorder;
      this.#sharedLimiters.set(
        providerModelKey(configured.provider, configured.model),
        new ProviderModelRateLimiter(limit, {
          ...(options.hydratedDispatches
            ? { hydratedDispatches: options.hydratedDispatches }
            : {}),
          ...(recorder ? { sink: (event) => recorder.record(event) } : {}),
        }),
      );
    }
  }

  static async create(args: {
    roles: RoleConfigs;
    captureModelIo: boolean;
    providerModelLimits: ProviderModelLimitConfig[];
    scheduleStore: ArtifactStore;
    executors?: ProviderExecutors;
  }): Promise<ModelGateway> {
    await args.scheduleStore.initialize();
    const recorder = new RateScheduleRecorder(args.scheduleStore);
    const hydratedDispatches = (await recorder.events()).filter(
      (event): event is RateLimitDispatch => event.event_type === "model_attempt_dispatched",
    );
    return new ModelGateway(args.roles, args.captureModelIo, args.executors, {
      providerModelLimits: args.providerModelLimits,
      scheduleRecorder: recorder,
      hydratedDispatches,
    });
  }

  async generateStructured<T>(args: {
    role: RoleName;
    callKey: string;
    prompt: PromptEnvelope;
    schemaName: string;
    schema: z.ZodType<T>;
    artifacts: ArtifactStore;
  }): Promise<StructuredGeneration<T>> {
    const config = this.#roles[args.role];
    const artifactName = `model-calls/${safeCallKey(args.callKey)}.json`;
    const cached = await args.artifacts.readJson<{
      schemaVersion: number;
      callKey: string;
      promptId: string;
      responseSchemaName: string;
      responseSchema: JsonValue;
      validatedResponse: JsonValue;
      rawText: string;
      generation: NormalizedGeneration;
      call: ModelCallRecord;
    }>(artifactName);
    if (cached) {
      const cachedCall = ModelCallRecordSchema.parse(cached.call);
      const expectedInputSha = sha256(promptText(args.prompt));
      const expectedParameters = jsonParameters(config);
      const expectedSchema = z.toJSONSchema(args.schema) as JsonValue;
      const staleReasons = [
        cached.schemaVersion === 1 ? null : "artifact_schema",
        cached.callKey === args.callKey ? null : "call_key",
        cached.promptId === args.prompt.promptId ? null : "prompt_id",
        cached.responseSchemaName === args.schemaName ? null : "response_schema_name",
        sha256(cached.responseSchema) === sha256(expectedSchema) ? null : "response_schema",
        cachedCall.role === args.role ? null : "role",
        cachedCall.provider === config.provider ? null : "provider",
        cachedCall.model === config.model ? null : "model",
        cachedCall.input_sha256 === expectedInputSha ? null : "prompt_input",
        sha256(cachedCall.parameters) === sha256(expectedParameters) ? null : "parameters",
      ].filter((reason): reason is string => reason !== null);
      if (staleReasons.length > 0) {
        throw new Error(
          `cached model call does not match current request (${staleReasons.join(",")}); start a fresh run`,
        );
      }
      const ledger = (await args.artifacts.readJsonl("model-calls/calls")).map((item) =>
        ModelCallRecordSchema.parse(item),
      );
      const committedCall = ledger.find((item) => item.sequence === cachedCall.sequence);
      if (committedCall && JSON.stringify(committedCall) !== JSON.stringify(cachedCall)) {
        throw new Error(`model-call ledger sequence collision: ${String(cachedCall.sequence)}`);
      }
      if (!committedCall) {
        await args.artifacts.append("model-calls/calls", cachedCall as unknown as JsonObject);
      }
      return {
        value: args.schema.parse(cached.validatedResponse),
        rawText: cached.rawText,
        generation: cached.generation,
        call: cachedCall,
        reused: true,
      };
    }

    const execute = async (): Promise<StructuredGeneration<T>> => {
      const started = performance.now();
      let retryCount = 0;
      let result: ProviderResult<T> | null = null;
      let lastError: unknown = null;
      for (let attempt = 0; attempt <= config.max_retries; attempt += 1) {
        let lease: RateLimitLease | null = null;
        try {
          await this.#pace(args.role, config);
          const limiter = this.#sharedLimiters.get(providerModelKey(config.provider, config.model));
          if (limiter) {
            const requestBytes =
              Buffer.byteLength(promptText(args.prompt), "utf8")
              + Buffer.byteLength(JSON.stringify(z.toJSONSchema(args.schema)), "utf8");
            lease = await limiter.acquire({
              artifactScope: args.artifacts.root,
              role: args.role,
              callKey: args.callKey,
              attempt: attempt + 1,
              estimatedInputTokens: Math.ceil(requestBytes / 3) + 256,
              outputTokenCeiling: config.max_output_tokens,
            });
          }
          try {
            const executor = this.#executors[config.provider];
            if (executor) {
              const raw = await executor({
                role: args.role,
                config,
                prompt: args.prompt,
                schemaName: args.schemaName,
              });
              if (raw.value === null || raw.value === undefined) {
                throw new EmptyStructuredOutputError("provider returned no parsed structured output");
              }
              result = { ...raw, value: args.schema.parse(raw.value) };
            } else {
              result =
                config.provider === "openai"
                  ? await this.#openaiGenerate(config, args.prompt, args.schemaName, args.schema)
                  : await this.#geminiGenerate(config, args.prompt, args.schema);
            }
          } catch (error) {
            if (lease && limiter) {
              await limiter.complete(
                lease,
                retryable(error) ? "retryable_error" : "terminal_error",
                null,
              );
              lease = null;
            }
            throw error;
          }
          if (lease && limiter) {
            await limiter.complete(lease, "success", result.usage);
            lease = null;
          }
          retryCount = attempt;
          break;
        } catch (error) {
          lastError = error;
          retryCount = attempt;
          if (attempt >= config.max_retries || !retryable(error)) break;
          await sleep(Math.min(10_000, 500 * 2 ** attempt + Math.random() * 250));
        }
      }
      if (!result) {
        await args.artifacts.append("model-calls/failures", {
          role: args.role,
          call_key: args.callKey,
          provider: config.provider,
          model: config.model,
          error: errorMessage(lastError),
          retryable: retryable(lastError),
          retry_count: retryCount,
        });
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
      }

      const latency = performance.now() - started;
      const ledger = await args.artifacts.readJsonl("model-calls/calls");
      const call = ModelCallRecordSchema.parse({
        sequence: ledger.length + 1,
        role: args.role,
        kind: "generation",
        provider: config.provider,
        model: config.model,
        input_sha256: sha256(promptText(args.prompt)),
        item_count: 1,
        parameters: jsonParameters(config),
        usage: result.usage,
        latency_ms: latency,
        request_id: result.requestId,
        retry_count: retryCount,
      });
      const generation: NormalizedGeneration = {
        text: result.rawText,
        model: config.model,
        provider: config.provider,
        usage: result.usage,
        latency_ms: latency,
        request_id: result.requestId,
        retry_count: retryCount,
      };
      const artifact: JsonObject = {
        schemaVersion: 1,
        callKey: args.callKey,
        promptId: args.prompt.promptId,
        responseSchemaName: args.schemaName,
        responseSchema: z.toJSONSchema(args.schema) as JsonValue,
        validatedResponse: result.value as JsonValue,
        rawText: result.rawText,
        generation: generation as unknown as JsonObject,
        call: call as unknown as JsonObject,
      };
      if (this.#captureModelIo) artifact.prompt = args.prompt as unknown as JsonValue;
      await args.artifacts.writeAtomic(artifactName, artifact);
      await args.artifacts.append("model-calls/calls", call as unknown as JsonObject);
      this.#lastRequestAt[args.role] = performance.now();
      return { value: result.value, rawText: result.rawText, generation, call, reused: false };
    };
    return this.#semaphores[args.role].use(execute);
  }

  async #pace(role: RoleName, config: ProviderRoleConfig): Promise<void> {
    const previous = this.#lastRequestAt[role];
    if (previous === undefined || config.min_request_interval_seconds <= 0) return;
    const remaining = config.min_request_interval_seconds * 1000 - (performance.now() - previous);
    if (remaining > 0) await sleep(remaining);
  }

  async #openaiGenerate<T>(
    config: ProviderRoleConfig,
    prompt: PromptEnvelope,
    schemaName: string,
    schema: z.ZodType<T>,
  ): Promise<ProviderResult<T>> {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required for an OpenAI role");
    this.#openai ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
    const request: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
      model: config.model,
      input: prompt.messages,
      max_output_tokens: config.max_output_tokens,
      text: { format: zodTextFormat(schema, schemaName) },
    };
    if (config.temperature !== 1) request.temperature = config.temperature;
    if (config.reasoning_effort) {
      request.reasoning = { effort: config.reasoning_effort };
    }
    const response = await this.#openai.responses.parse(request, {
      timeout: config.timeout_seconds * 1000,
    });
    const parsedOutput: unknown = response.output_parsed;
    if (parsedOutput === null || parsedOutput === undefined) {
      throw new EmptyStructuredOutputError("OpenAI returned no parsed structured output");
    }
    const value = schema.parse(parsedOutput);
    return {
      value,
      rawText: response.output_text,
      usage: {
        input_tokens: response.usage?.input_tokens ?? null,
        output_tokens: response.usage?.output_tokens ?? null,
        total_tokens: response.usage?.total_tokens ?? null,
      },
      requestId: response._request_id ?? null,
    };
  }

  async #geminiGenerate<T>(
    config: ProviderRoleConfig,
    prompt: PromptEnvelope,
    schema: z.ZodType<T>,
  ): Promise<ProviderResult<T>> {
    if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is required for a Gemini role");
    this.#gemini ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), config.timeout_seconds * 1000);
    try {
      const response = await this.#gemini.models.generateContent({
        model: config.model,
        contents: promptText(prompt),
        config: {
          temperature: config.temperature,
          maxOutputTokens: config.max_output_tokens,
          responseMimeType: "application/json",
          responseJsonSchema: z.toJSONSchema(schema) as Record<string, unknown>,
          abortSignal: abort.signal,
        },
      });
      const rawText = response.text ?? "";
      const usage = response.usageMetadata;
      return {
        value: schema.parse(JSON.parse(rawText)),
        rawText,
        usage: {
          input_tokens: usage?.promptTokenCount ?? null,
          output_tokens: usage?.candidatesTokenCount ?? null,
          total_tokens: usage?.totalTokenCount ?? null,
        },
        requestId: response.responseId ?? null,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
