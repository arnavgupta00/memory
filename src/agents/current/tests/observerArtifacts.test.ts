import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  readObserverArtifacts,
} from "../inspector/server/observerArtifacts.js";
import type { JsonObject } from "../src/types.js";

async function json(path: string, value: JsonObject): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

describe("inspector observer artifacts", () => {
  test("normalizes Architecture 0003.2 pipeline artifacts and role metrics", async () => {
    const root = await mkdtemp(join(tmpdir(), "memorybench-observer-"));
    await json(join(root, "contexto-coverage", "b0001.json"), {
      schemaVersion: 1,
      batchId: "b0001",
      highPrioritySignalCount: 4,
      counts: {
        graphCovered: 2,
        duplicate: 1,
        sessionIndexFallback: 1,
      },
      signals: [],
    });
    await json(join(root, "retrieval", "index-manifest.json"), {
      schemaVersion: 1,
      algorithm: "bm25",
      parameters: { k1: 1.2, b: 0.75 },
      documentCounts: {
        session: 48,
        graph_cell: 12,
        summary: 5,
        coverage_fallback: 2,
        tail: 2,
      },
    });
    await json(join(root, "retrieval", "candidates.json"), {
      schemaVersion: 1,
      question: "What changed?",
      questionDate: "2025/01/02",
      sessions: [{ rank: 1, session: { session_id: "s1" } }],
      graphCells: [{ rank: 1, pointer: "/context/work/current" }],
      summaries: [],
      coverageFallbackSessions: [{ rank: 1, sessionId: "s2" }],
      tailSessions: [],
    });
    await json(join(root, "reader-plan.json"), {
      supportStatus: "sufficient",
      answerMode: "knowledge_update",
      selectedSessions: [{ sessionId: "s1" }],
      selectedGraphPointers: ["/context/work/current"],
      evidenceFacts: [{ statement: "The current value changed." }],
      conflicts: [],
    });
    await json(join(root, "final-context.json"), {
      question: "What changed?",
      readerPlan: {},
      evidencePackage: { sessions: [] },
    });
    const modelCalls: JsonObject[] = [
      {
        call: {
          role: "contexto",
          model: "model-a",
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            total_tokens: 120,
          },
          latency_ms: 1000,
          retry_count: 1,
        },
      },
      {
        call: {
          role: "contexto",
          model: "model-a",
          usage: {
            input_tokens: 80,
            output_tokens: 10,
            total_tokens: 90,
          },
          latency_ms: 500,
          retry_count: 0,
        },
      },
      {
        call: {
          role: "reader",
          model: "model-b",
          usage: {
            input_tokens: 50,
            output_tokens: 10,
            total_tokens: 60,
          },
          latency_ms: 300,
          retry_count: 0,
        },
      },
    ];

    const artifacts = await readObserverArtifacts({
      casePath: root,
      modelCalls,
    });

    expect(artifacts).toMatchObject({
      legacy: false,
      coverage: {
        available: true,
        totals: {
          graphCovered: 2,
          duplicate: 1,
          sessionIndexFallback: 1,
          highPrioritySignals: 4,
        },
      },
      retrieval: {
        available: true,
        question: "What changed?",
        algorithm: "bm25",
        indexed: {
          session: 48,
          graphCell: 12,
          summary: 5,
          coverageFallback: 2,
          tail: 2,
        },
        candidates: {
          session: 1,
          graphCell: 1,
          summary: 0,
          coverageFallback: 1,
          tail: 0,
        },
      },
      finalContext: {
        available: true,
        kind: "compact_reader_context",
      },
      roleMetrics: [
        {
          role: "contexto",
          calls: 2,
          inputTokens: 180,
          outputTokens: 30,
          totalTokens: 210,
          totalLatencyMs: 1500,
          averageLatencyMs: 750,
          retries: 1,
          models: ["model-a"],
        },
        {
          role: "reader",
          calls: 1,
          totalTokens: 60,
          averageLatencyMs: 300,
          models: ["model-b"],
        },
      ],
    });
  });

  test("keeps legacy runs readable when observer artifacts are absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "memorybench-legacy-observer-"));
    const artifacts = await readObserverArtifacts({
      casePath: root,
      modelCalls: [],
    });

    expect(artifacts).toMatchObject({
      legacy: true,
      coverage: { available: false, records: [] },
      retrieval: { available: false },
      readerPlan: null,
      finalContext: { available: false, kind: "unavailable", value: null },
      roleMetrics: [],
    });
  });

  test("limits coverage replay without hiding question-time artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "memorybench-replay-observer-"));
    for (const batchId of ["b0001", "b0002"]) {
      await json(join(root, "contexto-coverage", `${batchId}.json`), {
        batchId,
        highPrioritySignalCount: 1,
        counts: {
          graphCovered: 1,
          duplicate: 0,
          sessionIndexFallback: 0,
        },
      });
    }
    await json(join(root, "reader-plan.json"), {
      supportStatus: "insufficient",
    });

    const artifacts = await readObserverArtifacts({
      casePath: root,
      modelCalls: [],
      batchLimit: 1,
    });

    expect(artifacts.coverage.records).toHaveLength(1);
    expect(artifacts.coverage.totals.graphCovered).toBe(1);
    expect(artifacts.readerPlan).toMatchObject({
      supportStatus: "insufficient",
    });
  });
});
