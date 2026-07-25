import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";
import { APIConnectionError } from "openai";
import { z } from "zod";

import { ArtifactStore } from "../src/services/artifacts.js";
import { ModelGateway, type ProviderExecutor } from "../src/services/modelGateway.js";

const role = (provider: "openai" | "gemini", maxRetries = 2) => ({
  kind: "generation" as const,
  provider,
  model: `${provider}-fixture`,
  temperature: 1,
  max_output_tokens: 100,
  timeout_seconds: 1,
  concurrency: 1,
  max_retries: maxRetries,
  min_request_interval_seconds: 0,
});

const result = (answer: string) => ({
  value: { answer },
  rawText: JSON.stringify({ answer }),
  usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 },
  requestId: `request-${answer}`,
});

async function store(prefix: string): Promise<ArtifactStore> {
  const artifactStore = new ArtifactStore(await mkdtemp(join(tmpdir(), prefix)));
  await artifactStore.initialize();
  return artifactStore;
}

describe("provider-normalized structured generation", () => {
  test("supports independent OpenAI and Gemini role executors with normalized usage", async () => {
    const openai: ProviderExecutor = () => Promise.resolve(result("openai"));
    const gemini: ProviderExecutor = () => Promise.resolve(result("gemini"));
    const gateway = new ModelGateway(
      { contexto: role("gemini"), shino: role("openai"), reader: role("openai"), answer: role("openai") },
      true,
      { openai, gemini },
    );
    const artifacts = await store("memorybench-providers-");
    const schema = z.object({ answer: z.string() });
    const prompt = { promptId: "fixture", messages: [{ role: "user" as const, content: "?" }] };
    const contexto = await gateway.generateStructured({ role: "contexto", callKey: "contexto:batch:0001", prompt, schemaName: "fixture", schema, artifacts });
    const answer = await gateway.generateStructured({ role: "answer", callKey: "answer:final", prompt, schemaName: "fixture", schema, artifacts });
    expect(contexto.value.answer).toBe("gemini");
    expect(answer.value.answer).toBe("openai");
    expect(answer.call.usage.total_tokens).toBe(14);
    expect((await artifacts.readJsonl("model-calls/calls")).map((call) => call.provider)).toEqual(["gemini", "openai"]);
  });

  test("retries rate limits and abort timeouts but does not retry malformed structured output", async () => {
    let attempts = 0;
    const transient: ProviderExecutor = () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("rate limited"), { status: 429 });
      if (attempts === 2) throw new DOMException("timed out", "AbortError");
      return Promise.resolve(result("recovered"));
    };
    const gateway = new ModelGateway(
      { contexto: role("openai"), shino: role("openai"), reader: role("openai"), answer: role("openai") },
      false,
      { openai: transient },
    );
    const schema = z.object({ answer: z.string() });
    const response = await gateway.generateStructured({
      role: "answer", callKey: "answer:final", prompt: { promptId: "fixture", messages: [{ role: "user", content: "?" }] },
      schemaName: "fixture", schema, artifacts: await store("memorybench-retry-"),
    });
    expect(response.value.answer).toBe("recovered");
    expect(response.call.retry_count).toBe(2);

    let malformedAttempts = 0;
    const malformed: ProviderExecutor = () => {
      malformedAttempts += 1;
      return Promise.resolve({ ...result("ignored"), value: { wrong: true } });
    };
    const malformedGateway = new ModelGateway(
      { contexto: role("openai"), shino: role("openai"), reader: role("openai"), answer: role("openai") },
      false,
      { openai: malformed },
    );
    await expect(malformedGateway.generateStructured({
      role: "answer", callKey: "answer:final", prompt: { promptId: "fixture", messages: [{ role: "user", content: "?" }] },
      schemaName: "fixture", schema, artifacts: await store("memorybench-malformed-"),
    })).rejects.toThrow();
    expect(malformedAttempts).toBe(1);
  });

  test("retries a missing parsed payload without retrying arbitrary schema violations", async () => {
    let attempts = 0;
    const temporarilyEmpty: ProviderExecutor = () => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.resolve({
          ...result("ignored"),
          value: null,
          rawText: "",
        });
      }
      return Promise.resolve(result("recovered"));
    };
    const gateway = new ModelGateway(
      { contexto: role("openai"), shino: role("openai"), reader: role("openai"), answer: role("openai") },
      false,
      { openai: temporarilyEmpty },
    );
    const response = await gateway.generateStructured({
      role: "contexto",
      callKey: "contexto:batch:0001",
      prompt: { promptId: "fixture", messages: [{ role: "user", content: "?" }] },
      schemaName: "fixture",
      schema: z.object({ answer: z.string() }),
      artifacts: await store("memorybench-empty-structured-"),
    });

    expect(response.value.answer).toBe("recovered");
    expect(response.call.retry_count).toBe(1);
    expect(attempts).toBe(2);
  });

  test("retries an OpenAI SDK APIConnectionError", async () => {
    let attempts = 0;
    const transient: ProviderExecutor = () => {
      attempts += 1;
      if (attempts === 1) {
        throw new APIConnectionError({
          message: "Connection error.",
          cause: new TypeError("fetch failed"),
        });
      }
      return Promise.resolve(result("recovered"));
    };
    const gateway = new ModelGateway(
      { contexto: role("openai"), shino: role("openai"), reader: role("openai"), answer: role("openai") },
      false,
      { openai: transient },
    );
    const response = await gateway.generateStructured({
      role: "contexto",
      callKey: "contexto:batch:0013",
      prompt: { promptId: "fixture", messages: [{ role: "user", content: "?" }] },
      schemaName: "fixture",
      schema: z.object({ answer: z.string() }),
      artifacts: await store("memorybench-api-connection-"),
    });

    expect(response.value.answer).toBe("recovered");
    expect(response.call.retry_count).toBe(1);
    expect(attempts).toBe(2);
  });

  test("shares provider/model concurrency across roles for prompts of every size", async () => {
    let active = 0;
    let maximumActive = 0;
    const executor: ProviderExecutor = async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return result("large");
    };
    const concurrentRole = { ...role("openai"), concurrency: 4 };
    const gateway = new ModelGateway(
      { contexto: concurrentRole, shino: concurrentRole, reader: concurrentRole, answer: concurrentRole },
      false,
      { openai: executor },
      {
        providerModelLimits: [{
          provider: "openai",
          model: "openai-fixture",
          max_concurrency: 2,
          token_budget: 160000,
          window_seconds: 60,
        }],
      },
    );
    const schema = z.object({ answer: z.string() });
    const prompt = {
      promptId: "large-fixture",
      messages: [{
        role: "user" as const,
        content: "small prompt",
      }],
    };
    await Promise.all([
      gateway.generateStructured({
        role: "answer",
        callKey: "answer:final",
        prompt,
        schemaName: "fixture",
        schema,
        artifacts: await store("memorybench-large-a-"),
      }),
      gateway.generateStructured({
        role: "shino",
        callKey: "shino:window:0001",
        prompt,
        schemaName: "fixture",
        schema,
        artifacts: await store("memorybench-large-b-"),
      }),
      gateway.generateStructured({
        role: "contexto",
        callKey: "contexto:batch:0001",
        prompt,
        schemaName: "fixture",
        schema,
        artifacts: await store("memorybench-large-c-"),
      }),
    ]);
    expect(maximumActive).toBe(2);
  });
});
