import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";
import { z } from "zod";

import { ModelGateway } from "../src/services/modelGateway.js";
import {
  ArtifactStore,
  EventRecorder,
  sha256,
} from "../src/services/artifacts.js";
import { MasterContextGraphSchema, type JsonValue } from "../src/types.js";

const role = {
  kind: "generation" as const,
  provider: "openai" as const,
  model: "fixture",
  temperature: 1,
  max_output_tokens: 100,
  timeout_seconds: 1,
  concurrency: 1,
  max_retries: 0,
  min_request_interval_seconds: 0,
};

describe("durable artifacts and cached calls", () => {
  test("redacts secrets and hash-chains events", async () => {
    const root = await mkdtemp(join(tmpdir(), "memorybench-artifacts-"));
    const store = new ArtifactStore(root);
    await store.initialize();
    vi.stubEnv("OPENAI_API_KEY", "sk-test-secret-value-1234567890");
    await store.append("model-calls/calls", { authorization: "Bearer private-token-123456", prompt: "sk-test-secret-value-1234567890" });
    const recorder = new EventRecorder(store);
    const first = await recorder.record("session_ingested", { session_id: "s1" }, "graph-1");
    const second = await recorder.record("graph_mutation_applied", { batch_id: "b0001" }, "graph-2");
    const body = await readFile(join(root, "model-calls/calls.jsonl"), "utf8");
    expect(body).not.toContain("private-token");
    expect(body).not.toContain("sk-test");
    expect(second.previous_event_hash).toBe(first.event_hash);
    expect((await recorder.replay()).map((event) => event.sequence)).toEqual([1, 2]);
    const eventPath = join(root, "events.jsonl");
    await writeFile(eventPath, (await readFile(eventPath, "utf8")).replace("s1", "tampered"));
    await expect(recorder.replay()).rejects.toThrow("hash mismatch");
    vi.unstubAllEnvs();
  });

  test("preserves JSON Pointer provenance keys containing benign secret words", async () => {
    const root = await mkdtemp(join(tmpdir(), "memorybench-provenance-"));
    const store = new ArtifactStore(root);
    await store.initialize();
    const graph = MasterContextGraphSchema.parse({
      schemaVersion: 1,
      revision: 1,
      context: {
        recipes: {
          grandfathers_secret_dry_rub: "paprika and brown sugar",
        },
      },
      provenanceByPointer: {
        "/context/recipes/grandfathers_secret_dry_rub": [{
          sessionId: "session-1",
          turnIndex: 0,
          sessionDate: "2026-07-24",
          batchId: "b0001",
          excerpt: "Grandfather's dry rub uses paprika and brown sugar.",
        }],
      },
    });

    await store.writeAtomic("final-graph.json", graph);
    const persisted = MasterContextGraphSchema.parse(
      await store.readJson<unknown>("final-graph.json"),
    );

    expect(persisted).toEqual(graph);
    expect(sha256(persisted)).toBe(sha256(graph));
    expect(
      persisted.provenanceByPointer[
        "/context/recipes/grandfathers_secret_dry_rub"
      ],
    ).toHaveLength(1);
  });

  test("still redacts credential fields and recognizable or configured values", async () => {
    const root = await mkdtemp(join(tmpdir(), "memorybench-redaction-"));
    const store = new ArtifactStore(root);
    await store.initialize();
    vi.stubEnv("OPENAI_API_KEY", "configured-value-without-key-shape");

    await store.writeAtomic("credentials.json", {
      authorization: "weak auth value",
      clientSecret: "weak client value",
      service_api_key: "weak api value",
      nested: {
        accessToken: "weak access value",
        prompt: "configured-value-without-key-shape",
        response: "Bearer recognizable-token-12345",
      },
    });
    const persisted = await store.readJson<Record<string, JsonValue>>(
      "credentials.json",
    );

    expect(persisted).toEqual({
      authorization: "[REDACTED]",
      clientSecret: "[REDACTED]",
      service_api_key: "[REDACTED]",
      nested: {
        accessToken: "[REDACTED]",
        prompt: "[REDACTED]",
        response: "[REDACTED]",
      },
    });
    vi.unstubAllEnvs();
  });

  test("reuses a validated persisted response without an API key or provider call", async () => {
    const root = await mkdtemp(join(tmpdir(), "memorybench-cache-"));
    const store = new ArtifactStore(root);
    await store.initialize();
    const responseSchema = z.object({ answer: z.string() });
    const cached = {
      schemaVersion: 1,
      callKey: "answer:final",
      promptId: "fixture",
      responseSchemaName: "fixture_v1",
      responseSchema: z.toJSONSchema(responseSchema) as unknown as JsonValue,
      validatedResponse: { answer: "Pune" },
      rawText: "{\"answer\":\"Pune\"}",
      generation: { text: "{\"answer\":\"Pune\"}", model: "fixture", provider: "openai", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, latency_ms: 1, request_id: "cached", retry_count: 0 },
      call: { sequence: 1, role: "answer", kind: "generation", provider: "openai", model: "fixture", input_sha256: sha256("<user>\n?"), item_count: 1, parameters: { temperature: 1, max_output_tokens: 100, reasoning_effort: null }, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, latency_ms: 1, request_id: "cached", retry_count: 0 },
    };
    await store.writeAtomic("model-calls/answer-final.json", cached);
    vi.stubEnv("OPENAI_API_KEY", "");
    const gateway = new ModelGateway({ contexto: role, shino: role, reader: role, answer: role }, false);
    const response = await gateway.generateStructured({
      role: "answer",
      callKey: "answer:final",
      prompt: { promptId: "fixture", messages: [{ role: "user", content: "?" }] },
      schemaName: "fixture_v1",
      schema: responseSchema,
      artifacts: store,
    });
    expect(response.value.answer).toBe("Pune");
    expect(response.reused).toBe(true);
    expect(await store.readJsonl("model-calls/calls")).toHaveLength(1);
    vi.unstubAllEnvs();
  });

  test("refuses a cached response when the prompt changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "memorybench-stale-cache-"));
    const store = new ArtifactStore(root);
    await store.initialize();
    const responseSchema = z.object({ answer: z.string() });
    await store.writeAtomic("model-calls/answer-final.json", {
      schemaVersion: 1,
      callKey: "answer:final",
      promptId: "fixture",
      responseSchemaName: "fixture_v1",
      responseSchema: z.toJSONSchema(responseSchema) as unknown as JsonValue,
      validatedResponse: { answer: "stale" },
      rawText: "{\"answer\":\"stale\"}",
      generation: { text: "{\"answer\":\"stale\"}", model: "fixture", provider: "openai", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, latency_ms: 1, request_id: "cached", retry_count: 0 },
      call: { sequence: 1, role: "answer", kind: "generation", provider: "openai", model: "fixture", input_sha256: sha256("<user>\nold"), item_count: 1, parameters: { temperature: 1, max_output_tokens: 100, reasoning_effort: null }, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, latency_ms: 1, request_id: "cached", retry_count: 0 },
    });
    const gateway = new ModelGateway(
      { contexto: role, shino: role, reader: role, answer: role },
      false,
    );
    await expect(gateway.generateStructured({
      role: "answer",
      callKey: "answer:final",
      prompt: {
        promptId: "fixture",
        messages: [{ role: "user", content: "new" }],
      },
      schemaName: "fixture_v1",
      schema: responseSchema,
      artifacts: store,
    })).rejects.toThrow("cached model call does not match current request");
  });
});
