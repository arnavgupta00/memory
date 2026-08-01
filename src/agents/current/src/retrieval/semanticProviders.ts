import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";

import type {
  SemanticDocumentEmbeddingInput,
  SemanticDocumentEmbeddingResult,
  SemanticEmbeddingProvider,
  SemanticEmbeddingUsage,
  SemanticProviderConfig,
  SemanticQueryEmbeddingResult,
} from "./semanticTypes.js";

type VoyageEmbeddingItem = { embedding?: unknown; index?: unknown };
type VoyageGroup = { data?: VoyageEmbeddingItem[]; index?: unknown };
type VoyageResponse = {
  data?: VoyageGroup[];
  usage?: { total_tokens?: unknown };
};

class Semaphore {
  readonly #limit: number;
  #active = 0;
  readonly #waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.#limit = Math.max(1, Math.floor(limit));
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#limit) {
      await new Promise<void>((resolveWait) => this.#waiters.push(resolveWait));
    }
    this.#active += 1;
    try {
      return await operation();
    } finally {
      this.#active -= 1;
      this.#waiters.shift()?.();
    }
  }
}

class SlidingTokenGate {
  readonly #budget: number;
  readonly #windowMs: number;
  readonly #history: Array<{ at: number; tokens: number }> = [];

  constructor(budget: number, windowMs = 60_000) {
    this.#budget = budget;
    this.#windowMs = windowMs;
  }

  async acquire(tokens: number): Promise<void> {
    const reserved = Math.min(Math.max(1, tokens), this.#budget);
    for (;;) {
      const now = Date.now();
      while (this.#history[0] && now - this.#history[0].at >= this.#windowMs) {
        this.#history.shift();
      }
      const used = this.#history.reduce((sum, item) => sum + item.tokens, 0);
      if (used + reserved <= this.#budget) {
        this.#history.push({ at: now, tokens: reserved });
        return;
      }
      const oldest = this.#history[0];
      const waitMs = oldest ? Math.max(25, oldest.at + this.#windowMs - now + 25) : 25;
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, Math.min(waitMs, 60_000)));
    }
  }
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function approximateTokens(texts: string[]): number {
  return Math.max(1, Math.ceil(texts.reduce((sum, text) => sum + text.length, 0) / 4));
}

function validateVector(value: unknown, dimension: number, label: string): number[] {
  if (!Array.isArray(value) || value.length !== dimension) {
    throw new Error(`${label} returned dimension ${String(Array.isArray(value) ? value.length : 0)}; expected ${String(dimension)}`);
  }
  const vector = value.map((item) => Number(item));
  if (vector.some((item) => !Number.isFinite(item))) {
    throw new Error(`${label} returned a non-finite embedding value`);
  }
  return vector;
}

function emptyUsage(exactTokenCount: boolean): SemanticEmbeddingUsage {
  return { inputTokens: 0, requests: 0, exactTokenCount };
}

function addUsage(
  target: SemanticEmbeddingUsage,
  inputTokens: number,
  exactTokenCount: boolean,
): void {
  target.inputTokens += inputTokens;
  target.requests += 1;
  target.exactTokenCount &&= exactTokenCount;
}

function documentBatches(
  documents: SemanticDocumentEmbeddingInput[],
): SemanticDocumentEmbeddingInput[][] {
  // Provider tokenization is materially denser than the generic chars/4
  // estimate on code-heavy BEAM sessions. Keep a wide margin below Voyage's
  // 120K hard request limit; observed BEAM batches can be ~1.36x the estimate.
  const estimatedTokenBudget = 70_000;
  const output: SemanticDocumentEmbeddingInput[][] = [];
  let batch: SemanticDocumentEmbeddingInput[] = [];
  let tokens = 0;
  for (const document of documents) {
    const documentTokens = approximateTokens(document.chunks);
    if (documentTokens > estimatedTokenBudget) {
      throw new Error(`semantic session ${document.sessionId} exceeds the request safety limit`);
    }
    if (
      batch.length > 0
      && (tokens + documentTokens > estimatedTokenBudget || batch.length >= 256)
    ) {
      output.push(batch);
      batch = [];
      tokens = 0;
    }
    batch.push(document);
    tokens += documentTokens;
  }
  if (batch.length > 0) output.push(batch);
  return output;
}

class VoyageContextProvider implements SemanticEmbeddingProvider {
  readonly config: SemanticProviderConfig;
  readonly #apiKey: string;
  readonly #semaphore: Semaphore;
  readonly #tokenGate = new SlidingTokenGate(2_700_000);

  constructor(config: SemanticProviderConfig, apiKey: string) {
    this.config = config;
    this.#apiKey = apiKey;
    this.#semaphore = new Semaphore(config.maxConcurrency);
  }

  async #request(inputs: string[][], inputType: "document" | "query"): Promise<{
    groups: number[][][];
    inputTokens: number;
  }> {
    // The generic estimate can undercount Voyage tokens by ~36% on BEAM's
    // code-heavy text. Reserve 1.5x against the account's 3M TPM allowance.
    await this.#tokenGate.acquire(Math.ceil(approximateTokens(inputs.flat()) * 1.5));
    return this.#semaphore.run(async () => {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const response = await fetch("https://api.voyageai.com/v1/contextualizedembeddings", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.#apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            inputs,
            input_type: inputType,
            model: this.config.model,
            output_dimension: this.config.dimension,
          }),
        });
        if (response.ok) {
          const payload = await response.json() as VoyageResponse;
          if (!Array.isArray(payload.data) || payload.data.length !== inputs.length) {
            throw new Error("Voyage embeddings returned an unexpected document count");
          }
          const groups = payload.data.map((group, groupIndex) => {
            const expected = inputs[groupIndex]?.length ?? 0;
            if (!Array.isArray(group.data) || group.data.length !== expected) {
              throw new Error(`Voyage embeddings returned an unexpected chunk count for group ${String(groupIndex)}`);
            }
            return group.data.map((item, itemIndex) => validateVector(
              item.embedding,
              this.config.dimension,
              `Voyage group ${String(groupIndex)} chunk ${String(itemIndex)}`,
            ));
          });
          return {
            groups,
            inputTokens: Number(payload.usage?.total_tokens ?? approximateTokens(inputs.flat())),
          };
        }
        const body = (await response.text()).slice(0, 1_000);
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === 5) {
          throw new Error(`Voyage embeddings failed (${String(response.status)}): ${body}`);
        }
        const retryAfterSeconds = Number(response.headers.get("retry-after") ?? "0");
        const delayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? Math.min(retryAfterSeconds * 1_000, 60_000)
          : Math.min(5_000 * 2 ** attempt, 60_000);
        await wait(delayMs);
      }
      throw new Error("Voyage embeddings exhausted retries");
    });
  }

  async embedDocuments(
    documents: SemanticDocumentEmbeddingInput[],
  ): Promise<SemanticDocumentEmbeddingResult> {
    const usage = emptyUsage(true);
    const vectors: number[][][] = Array.from({ length: documents.length }, () => []);
    let offset = 0;
    for (const batch of documentBatches(documents)) {
      const result = await this.#request(batch.map((item) => item.chunks), "document");
      for (let index = 0; index < result.groups.length; index += 1) {
        const group = result.groups[index];
        if (group) vectors[offset + index] = group;
      }
      offset += batch.length;
      addUsage(usage, result.inputTokens, true);
    }
    return { vectors, usage };
  }

  async embedQueries(queries: string[]): Promise<SemanticQueryEmbeddingResult> {
    if (queries.length === 0) return { vectors: [], usage: emptyUsage(true) };
    const usage = emptyUsage(true);
    const result = await this.#request(queries.map((query) => [query]), "query");
    addUsage(usage, result.inputTokens, true);
    return { vectors: result.groups.map((group) => group[0] ?? []), usage };
  }
}

type FlatEmbedding = { documentIndex: number; chunkIndex: number; text: string };

function flatDocumentInputs(documents: SemanticDocumentEmbeddingInput[]): FlatEmbedding[] {
  return documents.flatMap((document, documentIndex) =>
    document.chunks.map((text, chunkIndex) => ({ documentIndex, chunkIndex, text })));
}

function flatBatches(items: FlatEmbedding[], maxItems = 128): FlatEmbedding[][] {
  const output: FlatEmbedding[][] = [];
  let batch: FlatEmbedding[] = [];
  let tokens = 0;
  for (const item of items) {
    const itemTokens = approximateTokens([item.text]);
    if (batch.length > 0 && (batch.length >= maxItems || tokens + itemTokens > 100_000)) {
      output.push(batch);
      batch = [];
      tokens = 0;
    }
    batch.push(item);
    tokens += itemTokens;
  }
  if (batch.length > 0) output.push(batch);
  return output;
}

class OpenAIEmbeddingProvider implements SemanticEmbeddingProvider {
  readonly config: SemanticProviderConfig;
  readonly #client: OpenAI;
  readonly #semaphore: Semaphore;

  constructor(config: SemanticProviderConfig, apiKey: string) {
    this.config = config;
    this.#client = new OpenAI({ apiKey, maxRetries: 2 });
    this.#semaphore = new Semaphore(config.maxConcurrency);
  }

  async #embed(texts: string[]): Promise<{ vectors: number[][]; inputTokens: number }> {
    return this.#semaphore.run(async () => {
      const response = await this.#client.embeddings.create({
        model: this.config.model,
        input: texts,
        dimensions: this.config.dimension,
        encoding_format: "float",
      });
      const vectors = [...response.data]
        .sort((left, right) => left.index - right.index)
        .map((item, index) => validateVector(
          item.embedding,
          this.config.dimension,
          `OpenAI embedding ${String(index)}`,
        ));
      return { vectors, inputTokens: response.usage.total_tokens };
    });
  }

  async embedDocuments(
    documents: SemanticDocumentEmbeddingInput[],
  ): Promise<SemanticDocumentEmbeddingResult> {
    const usage = emptyUsage(true);
    const vectors = documents.map((item) => Array.from<number[]>({ length: item.chunks.length }));
    for (const batch of flatBatches(flatDocumentInputs(documents))) {
      const result = await this.#embed(batch.map((item) => item.text));
      batch.forEach((item, index) => {
        const vector = result.vectors[index];
        const documentVectors = vectors[item.documentIndex];
        if (vector && documentVectors) documentVectors[item.chunkIndex] = vector;
      });
      addUsage(usage, result.inputTokens, true);
    }
    return { vectors, usage };
  }

  async embedQueries(queries: string[]): Promise<SemanticQueryEmbeddingResult> {
    if (queries.length === 0) return { vectors: [], usage: emptyUsage(true) };
    const usage = emptyUsage(true);
    const result = await this.#embed(queries);
    addUsage(usage, result.inputTokens, true);
    return { vectors: result.vectors, usage };
  }
}

class GeminiEmbeddingProvider implements SemanticEmbeddingProvider {
  readonly config: SemanticProviderConfig;
  readonly #client: GoogleGenAI;
  readonly #semaphore: Semaphore;

  constructor(config: SemanticProviderConfig, apiKey: string) {
    this.config = config;
    this.#client = new GoogleGenAI({ apiKey });
    this.#semaphore = new Semaphore(config.maxConcurrency);
  }

  async #embed(texts: string[]): Promise<number[][]> {
    return this.#semaphore.run(async () => {
      const response = await this.#client.models.embedContent({
        model: this.config.model,
        contents: texts,
        config: { outputDimensionality: this.config.dimension },
      });
      if (!Array.isArray(response.embeddings) || response.embeddings.length !== texts.length) {
        throw new Error("Gemini embeddings returned an unexpected item count");
      }
      return response.embeddings.map((item, index) => validateVector(
        item.values,
        this.config.dimension,
        `Gemini embedding ${String(index)}`,
      ));
    });
  }

  async embedDocuments(
    documents: SemanticDocumentEmbeddingInput[],
  ): Promise<SemanticDocumentEmbeddingResult> {
    const usage = emptyUsage(false);
    const vectors = documents.map((item) => Array.from<number[]>({ length: item.chunks.length }));
    for (const batch of flatBatches(flatDocumentInputs(documents), 64)) {
      const texts = batch.map((item) => `title: session memory | text: ${item.text}`);
      const result = await this.#embed(texts);
      batch.forEach((item, index) => {
        const vector = result[index];
        const documentVectors = vectors[item.documentIndex];
        if (vector && documentVectors) documentVectors[item.chunkIndex] = vector;
      });
      addUsage(usage, approximateTokens(texts), false);
    }
    return { vectors, usage };
  }

  async embedQueries(queries: string[]): Promise<SemanticQueryEmbeddingResult> {
    if (queries.length === 0) return { vectors: [], usage: emptyUsage(false) };
    const texts = queries.map((query) => `task: search result | query: ${query}`);
    const vectors = await this.#embed(texts);
    return {
      vectors,
      usage: {
        inputTokens: approximateTokens(texts),
        requests: 1,
        exactTokenCount: false,
      },
    };
  }
}

function requiredKey(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for semantic retrieval`);
  return value;
}

export function defaultSemanticProviderConfig(
  provider: SemanticProviderConfig["provider"],
  maxConcurrency = 8,
): SemanticProviderConfig {
  if (provider === "voyage") {
    return { provider, model: "voyage-context-4", dimension: 1024, maxConcurrency };
  }
  if (provider === "gemini") {
    return { provider, model: "gemini-embedding-2", dimension: 1536, maxConcurrency };
  }
  return {
    provider,
    model: "text-embedding-3-large",
    dimension: 3072,
    maxConcurrency,
  };
}

export function createSemanticProvider(
  config: SemanticProviderConfig,
): SemanticEmbeddingProvider {
  if (config.provider === "voyage") {
    return new VoyageContextProvider(config, requiredKey("VOYAGE_API_KEY"));
  }
  if (config.provider === "gemini") {
    return new GeminiEmbeddingProvider(config, requiredKey("GEMINI_API_KEY"));
  }
  return new OpenAIEmbeddingProvider(config, requiredKey("OPENAI_API_KEY"));
}
