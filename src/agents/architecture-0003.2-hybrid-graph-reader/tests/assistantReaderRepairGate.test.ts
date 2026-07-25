import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { ModelGateway } from "../src/services/modelGateway.js";
import { runAssistantReaderRepairGate } from "../src/services/assistantReaderRepairGate.js";
import { ArtifactStore } from "../src/services/artifacts.js";
import type { JsonObject, ReaderPlan } from "../src/types.js";

const role = {
  kind: "generation" as const,
  provider: "openai" as const,
  model: "gpt-fixture",
  temperature: 1,
  reasoning_effort: "high" as const,
  max_output_tokens: 12000,
  timeout_seconds: 300,
  concurrency: 3,
  max_retries: 0,
  min_request_interval_seconds: 0,
  input_price_per_million: 0.05,
  output_price_per_million: 0.4,
};

const candidates = (question: string, sessionId: string) => ({
  schemaVersion: 1,
  question,
  questionDate: "2026/01/01",
  sessions: [{
    documentId: `session:${sessionId}`,
    score: 2,
    bm25Score: 2,
    temporalBoost: 0,
    matchedTerms: ["recommend"],
    rank: 1,
    session: {
      session_id: sessionId,
      date: "2025/01/01",
      turns: [
        { role: "user", content: "which color would suit the room?" },
        { role: "assistant", content: "blue would suit the room." },
      ],
    },
  }],
  graphCells: [],
  summaries: [],
  coverageFallbackSessions: [],
  tailSessions: [],
});

async function writeJson(store: ArtifactStore, name: string, value: JsonObject): Promise<void> {
  await store.writeAtomic(name, value);
}

async function fixture(caseCount = 3): Promise<{
  root: string;
  sourceRun: string;
  dataset: string;
  output: string;
  caseIds: string[];
}> {
  const root = await mkdtemp(resolve(tmpdir(), "assistant-reader-gate-"));
  const sourceRun = resolve(root, "source-run");
  const source = new ArtifactStore(sourceRun);
  await source.initialize();
  const caseIds = Array.from(
    { length: caseCount },
    (_, index) => `case-${String(index + 1)}`,
  );
  const providerModelLimits = [{
    provider: "openai" as const,
    model: role.model,
    max_concurrency: 18,
    token_budget: 10_000_000,
    window_seconds: 60,
  }];
  await writeJson(source, "manifest.json", {
    run_id: "source-run",
    status: "completed",
    selected_question_ids: caseIds,
    config: {
      agent: {
        models: { contexto: role, shino: role, reader: role },
        provider_model_limits: providerModelLimits,
        options: {
          graph_batch_size: 3,
          summary_batch_size: 9,
          latest_raw_sessions: 9,
          allow_graph_replacement: true,
        },
      },
      answer: role,
      execution: { capture_model_io: true },
    },
  });
  await source.writeAtomic("config.yaml", "fixture: true\n");
  const datasetRecords: JsonObject[] = [];
  for (const [index, caseId] of caseIds.entries()) {
    const sessionId = `support-${String(index + 1)}`;
    const question = "what color did the assistant recommend?";
    datasetRecords.push({
      question_id: caseId,
      question_type: "single-session-assistant",
      question,
      question_date: "2026/01/01",
      answer_session_ids: [sessionId],
    });
    const caseStore = new ArtifactStore(
      resolve(sourceRun, "agent-artifacts", "cases", caseId),
    );
    await caseStore.initialize();
    const retrieval = candidates(question, sessionId);
    await caseStore.append("sessions", retrieval.sessions[0]?.session as unknown as JsonObject);
    await writeJson(
      caseStore,
      "retrieval/candidates.json",
      retrieval as unknown as JsonObject,
    );
    await writeJson(caseStore, "final-graph.json", {
      schemaVersion: 1,
      revision: 0,
      context: {},
      provenanceByPointer: {},
    });
  }
  const dataset = resolve(root, "dataset.json");
  const datasetStore = new ArtifactStore(root);
  await datasetStore.writeAtomic("dataset.json", datasetRecords);
  return {
    root,
    sourceRun,
    dataset,
    output: resolve(root, "gate-output"),
    caseIds,
  };
}

describe("assistant Reader repair gate", () => {
  test("reruns exactly one production Reader call per case and evaluates after completion", async () => {
    const input = await fixture(18);
    const sourceManifestBefore = await readFile(
      resolve(input.sourceRun, "manifest.json"),
    );
    let calls = 0;
    const result = await runAssistantReaderRepairGate(
      input,
      {
        now: () => new Date("2026-07-24T00:00:00.000Z"),
        gatewayFactory: (args) =>
          Promise.resolve(new ModelGateway(
            args.roles,
            true,
            {
              openai: (request) => {
                calls += 1;
                const text = request.prompt.messages.map((message) => message.content).join("\n");
                const sessionId = /support-\d+/u.exec(text)?.[0];
                if (!sessionId) throw new Error("fixture prompt lost support session");
                const plan: ReaderPlan = {
                  supportStatus: "sufficient",
                  answerMode: "assistant_answer",
                  selectedSessions: [{
                    sessionId,
                    turnIndexes: [1],
                    purpose: "direct_answer",
                  }],
                  selectedGraphPointers: [],
                  evidenceFacts: [{
                    statement: "the assistant recommended blue.",
                    sessionIds: [sessionId],
                    graphPointers: [],
                  }],
                  conflicts: [],
                };
                return Promise.resolve({
                  value: plan,
                  rawText: JSON.stringify(plan),
                  usage: {
                    input_tokens: 100,
                    output_tokens: 25,
                    total_tokens: 125,
                  },
                  requestId: `request-${sessionId}`,
                });
              },
            },
            { providerModelLimits: args.providerModelLimits },
          )),
      },
    );

    expect(result.verdict).toBe("passed");
    expect(calls).toBe(18);
    expect(result.report.metrics).toMatchObject({
      completed_case_count: 18,
      support_session_hits: 18,
      sufficient_nonempty_plan_count: 18,
      unknown_reference_count: 0,
      reader_call_count: 18,
    });
    expect(await readFile(resolve(input.sourceRun, "manifest.json"))).toEqual(
      sourceManifestBefore,
    );
    await expect(runAssistantReaderRepairGate(input)).rejects.toThrow(
      "output already exists",
    );
  });

  test("rejects duplicate or empty selections before paid work", async () => {
    const input = await fixture();
    await expect(
      runAssistantReaderRepairGate({
        ...input,
        output: resolve(input.root, "invalid-output"),
        caseIds: ["case-1", "case-1", "case-2"],
      }),
    ).rejects.toThrow("must be unique");
    await expect(
      runAssistantReaderRepairGate({
        ...input,
        output: resolve(input.root, "empty-output"),
        caseIds: [],
      }),
    ).rejects.toThrow("at least one");
  });

  test("requires evidence for answerable cases and empty insufficiency for abstentions", async () => {
    const input = await fixture();
    let calls = 0;
    const result = await runAssistantReaderRepairGate(
      {
        ...input,
        abstentionCaseIds: ["case-3"],
      },
      {
        gatewayFactory: (args) =>
          Promise.resolve(new ModelGateway(
            args.roles,
            true,
            {
              openai: (request) => {
                calls += 1;
                const text = request.prompt.messages
                  .map((message) => message.content)
                  .join("\n");
                const sessionId = /support-\d+/u.exec(text)?.[0];
                if (!sessionId) throw new Error("fixture prompt lost support session");
                const abstain = sessionId === "support-3";
                const plan: ReaderPlan = abstain
                  ? {
                      supportStatus: "insufficient",
                      answerMode: "abstain",
                      selectedSessions: [],
                      selectedGraphPointers: [],
                      evidenceFacts: [],
                      conflicts: [],
                    }
                  : {
                      supportStatus: "sufficient",
                      answerMode: "assistant_answer",
                      selectedSessions: [{
                        sessionId,
                        turnIndexes: [1],
                        purpose: "direct_answer",
                      }],
                      selectedGraphPointers: [],
                      evidenceFacts: [{
                        statement: "the assistant recommended blue.",
                        sessionIds: [sessionId],
                        graphPointers: [],
                      }],
                      conflicts: [],
                    };
                return Promise.resolve({
                  value: plan,
                  rawText: JSON.stringify(plan),
                  usage: {
                    input_tokens: 100,
                    output_tokens: 25,
                    total_tokens: 125,
                  },
                  requestId: `request-${sessionId}`,
                });
              },
            },
            { providerModelLimits: args.providerModelLimits },
          )),
      },
    );

    expect(result.verdict).toBe("passed");
    expect(calls).toBe(3);
    expect(result.report.metrics).toMatchObject({
      support_session_hits: 2,
      sufficient_nonempty_plan_count: 2,
      correct_abstention_count: 1,
      reader_call_count: 3,
    });
  });
});
