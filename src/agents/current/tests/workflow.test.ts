import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";
import type { z } from "zod";

import type { StructuredModelGateway } from "../src/runtime.js";
import { ArtifactStore, EventRecorder } from "../src/services/artifacts.js";
import { PromptLoader } from "../src/services/promptLoader.js";
import { emptyState } from "../src/state.js";
import type { JsonObject, ModelCallRecord, PromptEnvelope, TokenUsage } from "../src/types.js";
import { createMemoryWorkflow } from "../src/workflow.js";

const usage: TokenUsage = { input_tokens: 10, output_tokens: 4, total_tokens: 14 };

class FixtureGateway implements StructuredModelGateway {
  readonly calls: Array<{ role: string; callKey: string; prompt: PromptEnvelope }> = [];
  readonly #duplicateFirstContextoKey: boolean;

  constructor(duplicateFirstContextoKey = false) {
    this.#duplicateFirstContextoKey = duplicateFirstContextoKey;
  }

  async generateStructured<T>(args: {
    role: "contexto" | "shino" | "reader" | "answer";
    callKey: string;
    prompt: PromptEnvelope;
    schemaName: string;
    schema: z.ZodType<T>;
    artifacts: ArtifactStore;
  }) {
    await Promise.resolve();
    this.calls.push({ role: args.role, callKey: args.callKey, prompt: args.prompt });
    const number = this.calls.filter((call) => call.role === "contexto").length;
    let payload: JsonObject = args.role === "contexto"
      ? { mutation: {
            mode: "semantic_updates",
            batchSummary: `batch ${number}`,
            requiredSignalResolutions: [],
            additionalUpdates: [{
              domain: "other",
              path: this.#duplicateFirstContextoKey && number === 1
                ? ["session", "raw_memory"]
                : ["fixture", `memory_${number}`],
              memoryType: "fact",
              updateMode: "set",
              value: { kind: "string", value: `memory ${number}` },
              effectiveAt: null,
              unit: null,
              sources: [{ sessionSlot: "session_1", turnSlot: "turn_1", evidenceQuote: `memory ${(number - 1) * 3 + 1}` }],
              reason: "fixture",
            }],
            sessionAudits: [
              { sessionSlot: "session_1", disposition: "extract_personal_memory", rationale: "fixture memory" },
              { sessionSlot: "session_2", disposition: "no_durable_memory", rationale: "fixture has no retained fact" },
              { sessionSlot: "session_3", disposition: "no_durable_memory", rationale: "fixture has no retained fact" },
            ],
          } }
      : args.role === "shino"
        ? { summary: "sessions one through nine" }
        : args.role === "reader"
          ? {
              supportStatus: "sufficient",
              answerMode: "direct",
              selectedSessions: [{
                sessionId: "s10",
                turnIndexes: [0],
                purpose: "direct_answer",
              }],
              selectedGraphPointers: [],
              evidenceFacts: [{
                statement: "The remembered value is memory 3.",
                sessionIds: ["s10"],
                graphPointers: [],
              }],
              conflicts: [],
            }
        : { hypothesis: "memory 3", evidence: [{ sessionId: "s10", turnIndex: 0 }], supportStatus: "supported" };
    if (args.role === "reader" && !args.schema.safeParse(payload).success) {
      payload = {
        supportStatus: "insufficient",
        answerMode: "abstain",
        selectedSessions: [],
        selectedGraphPointers: [],
        evidenceFacts: [],
        conflicts: [],
      };
    }
    if (args.role === "answer" && !args.schema.safeParse(payload).success) {
      payload = {
        hypothesis: "",
        evidence: [],
        supportStatus: "insufficient",
      };
    }
    const value = args.schema.parse(payload);
    const call: ModelCallRecord = {
      sequence: this.calls.length, role: args.role, kind: "generation", provider: "openai",
      model: "fixture", input_sha256: args.callKey, item_count: 1, parameters: {}, usage,
      latency_ms: 1, request_id: `request-${this.calls.length}`, retry_count: 0,
    };
    return {
      value,
      rawText: JSON.stringify(payload),
      generation: { text: JSON.stringify(payload), model: "fixture", provider: "openai" as const, usage, latency_ms: 1, request_id: call.request_id, retry_count: 0 },
      call,
      reused: false,
    };
  }
}

describe("Contexto/Shino LangGraph", () => {
  test("preserves duplicate source session IDs as distinct ordered occurrences", async () => {
    const root = await mkdtemp(join(tmpdir(), "memorybench-duplicate-sessions-"));
    const artifacts = new ArtifactStore(root);
    await artifacts.initialize();
    const workflow = createMemoryWorkflow({
      options: { graph_batch_size: 3, summary_batch_size: 9, latest_raw_sessions: 9, allow_graph_replacement: true },
      artifacts,
      events: new EventRecorder(artifacts),
      models: new FixtureGateway(),
      prompts: new PromptLoader(),
    });
    let state = emptyState("q-duplicates");
    for (const session of [
      { session_id: "shared", date: "2025/01/01", turns: [{ role: "user" as const, content: "first occurrence" }] },
      { session_id: "shared", date: "2025/01/02", turns: [{ role: "user" as const, content: "second occurrence" }] },
    ]) {
      state = await workflow.invoke({ ...state, action: "ingest", incomingSession: session });
    }

    expect(state.sessions).toHaveLength(2);
    expect(state.sessions.map((session) => session.date)).toEqual(["2025/01/01", "2025/01/02"]);
    expect(await artifacts.readJsonl("sessions")).toHaveLength(2);
    const replayed = await new EventRecorder(artifacts).replay();
    expect(replayed.filter((event) => event.event_type === "session_ingested")).toHaveLength(2);
  });

  test("runs B3/C9 cadence and preserves the tenth session as an unflushed raw tail", async () => {
    const root = await mkdtemp(join(tmpdir(), "memorybench-workflow-"));
    const artifacts = new ArtifactStore(root);
    await artifacts.initialize();
    const gateway = new FixtureGateway();
    const workflow = createMemoryWorkflow({
      options: { graph_batch_size: 3, summary_batch_size: 9, latest_raw_sessions: 9, allow_graph_replacement: true },
      artifacts,
      events: new EventRecorder(artifacts),
      models: gateway,
      prompts: new PromptLoader(),
    });
    let state = emptyState("q1");
    for (let index = 1; index <= 10; index += 1) {
      state = await workflow.invoke({
        ...state,
        action: "ingest",
        incomingSession: { session_id: `s${index}`, date: `2025/01/${String(index).padStart(2, "0")}`, turns: [{ role: "user", content: `memory ${index}` }] },
      });
    }
    state = await workflow.invoke({ ...state, action: "answer", question: "What is remembered?", questionDate: "2025/02/01", incomingSession: null });

    expect(gateway.calls.map((call) => call.role)).toEqual(["contexto", "contexto", "contexto", "shino", "reader", "answer"]);
    expect(state.graphTrackedCount).toBe(9);
    expect(state.summaryTrackedCount).toBe(9);
    expect(
      state.finalContext?.evidencePackage.payload.sessions.map(
        (session) => session.sessionId,
      ),
    ).toEqual(["s10"]);
    expect(state.finalContext?.evidencePackage.payload.sessions[0]?.turns).toEqual([
      {
        turnIndex: 0,
        role: "user",
        content: "memory 10",
        selection: "reader_selected",
      },
    ]);
    expect(state.answerResult?.hypothesis).toBe("memory 3");
    const shinoPrompt = gateway.calls.find((call) => call.role === "shino")?.prompt.messages.map((message) => message.content).join("\n") ?? "";
    expect(shinoPrompt).not.toContain("memory 9");
    expect(shinoPrompt).not.toContain("graph diff history");
    expect(await artifacts.exists("final-graph.json")).toBe(true);
    expect(await artifacts.exists("retrieval/index-manifest.json")).toBe(true);
    expect(await artifacts.exists("retrieval/candidates.json")).toBe(true);
    expect(await artifacts.exists("reader-plan.json")).toBe(true);
    expect(await artifacts.exists("final-context.json")).toBe(true);
    expect(await artifacts.exists("answer.json")).toBe(true);
    expect(await artifacts.exists("contexto-coverage/b0001.json")).toBe(true);
  });

  test("records a forbidden semantic update as a rejection and continues", async () => {
    const root = await mkdtemp(join(tmpdir(), "memorybench-workflow-rejection-"));
    const artifacts = new ArtifactStore(root);
    await artifacts.initialize();
    const gateway = new FixtureGateway(true);
    const workflow = createMemoryWorkflow({
      options: {
        graph_batch_size: 3,
        summary_batch_size: 9,
        latest_raw_sessions: 9,
        allow_graph_replacement: true,
      },
      artifacts,
      events: new EventRecorder(artifacts),
      models: gateway,
      prompts: new PromptLoader(),
    });
    let state = emptyState("q-rejection");
    for (let index = 1; index <= 3; index += 1) {
      state = await workflow.invoke({
        ...state,
        action: "ingest",
        incomingSession: {
          session_id: `s${index}`,
          date: `2025/01/${String(index).padStart(2, "0")}`,
          turns: [{ role: "user", content: `memory ${index}` }],
        },
      });
    }
    state = await workflow.invoke({
      ...state,
      action: "answer",
      question: "What is remembered?",
      questionDate: "2025/02/01",
      incomingSession: null,
    });

    expect(state.graphTrackedCount).toBe(3);
    expect(state.graph.revision).toBe(0);
    expect(state.mutationRecords).toHaveLength(1);
    expect(state.mutationRecords[0]?.accepted).toBe(false);
    expect(state.mutationRecords[0]?.rejectionReason).toContain("forbidden transcript");
    expect(state.answerResult?.hypothesis).toBe(
      "The available memory does not contain this information.",
    );
    expect(gateway.calls.map((call) => call.role)).toEqual(["contexto", "reader", "answer"]);
  });
});
