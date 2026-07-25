import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";
import type { z } from "zod";

import { createAssembleContextNode } from "../src/nodes/assembleContext.js";
import { createFinalAnswerNode } from "../src/nodes/finalAnswer.js";
import { createMapAnswerResultNode } from "../src/nodes/mapAnswerResult.js";
import type {
  StructuredModelGateway,
  WorkflowRuntime,
} from "../src/runtime.js";
import { ArtifactStore, EventRecorder } from "../src/services/artifacts.js";
import { PromptLoader } from "../src/services/promptLoader.js";
import { emptyState } from "../src/state.js";
import type {
  JsonObject,
  ModelCallRecord,
  NormalizedGeneration,
  PromptEnvelope,
  ReaderPlan,
  TokenUsage,
} from "../src/types.js";
import {
  AnswerResultSchema,
  FinalContextSchema,
} from "../src/types.js";

const usage: TokenUsage = {
  input_tokens: 20,
  output_tokens: 5,
  total_tokens: 25,
};

const generation: NormalizedGeneration = {
  text: "{}",
  model: "fixture",
  provider: "openai",
  usage,
  latency_ms: 1,
  request_id: "fixture-request",
  retry_count: 0,
};

class AnswerGateway implements StructuredModelGateway {
  prompt: PromptEnvelope | null = null;
  rejectsUnknownSession = false;
  rejectsUnincludedTurn = false;

  async generateStructured<T>(args: {
    role: "contexto" | "shino" | "reader" | "answer";
    callKey: string;
    prompt: PromptEnvelope;
    schemaName: string;
    schema: z.ZodType<T>;
    artifacts: ArtifactStore;
  }) {
    await Promise.resolve();
    if (args.role !== "answer") {
      throw new Error("Gate 5 fixture accepts only the answer role");
    }
    this.prompt = args.prompt;
    this.rejectsUnknownSession = !args.schema.safeParse({
      hypothesis: "Invented.",
      evidence: [{ sessionId: "unselected", turnIndex: 0 }],
      supportStatus: "supported",
    }).success;
    this.rejectsUnincludedTurn = !args.schema.safeParse({
      hypothesis: "Invented.",
      evidence: [{ sessionId: "selected", turnIndex: 99 }],
      supportStatus: "supported",
    }).success;
    const payload: JsonObject = {
      hypothesis: "The selected value is amber.",
      evidence: [{ sessionId: "selected", turnIndex: 1 }],
      supportStatus: "supported",
    };
    const value = args.schema.parse(payload);
    const call: ModelCallRecord = {
      sequence: 1,
      role: "answer",
      kind: "generation",
      provider: "openai",
      model: "fixture",
      input_sha256: args.callKey,
      item_count: 1,
      parameters: {},
      usage,
      latency_ms: 1,
      request_id: "fixture-request",
      retry_count: 0,
    };
    return {
      value,
      rawText: JSON.stringify(payload),
      generation: {
        ...generation,
        text: JSON.stringify(payload),
      },
      call,
      reused: false,
    };
  }
}

async function runtime(
  prefix: string,
  gateway = new AnswerGateway(),
): Promise<{ runtime: WorkflowRuntime; gateway: AnswerGateway }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const artifacts = new ArtifactStore(root);
  await artifacts.initialize();
  return {
    runtime: {
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
    },
    gateway,
  };
}

function sufficientPlan(): ReaderPlan {
  return {
    supportStatus: "sufficient",
    answerMode: "direct",
    selectedSessions: [{
      sessionId: "selected",
      turnIndexes: [1],
      purpose: "direct_answer",
    }],
    selectedGraphPointers: [],
    evidenceFacts: [{
      statement: "COMPACT_READER_FACT: the selected value is amber.",
      sessionIds: ["selected"],
      graphPointers: [],
    }],
    conflicts: [],
  };
}

describe("Gate 5 active workflow boundary", () => {
  test("prompts only compact Reader evidence and supplies a constrained schema", async () => {
    const fixture = await runtime("memorybench-gate5-prompt-");
    const state = emptyState("gate5-prompt");
    state.action = "answer";
    state.question = "What is the selected value?";
    state.questionDate = "2025/01/03";
    state.sessions = [
      {
        session_id: "selected",
        date: "2025/01/01",
        turns: [
          { role: "user", content: "The previous value was blue." },
          { role: "user", content: "SELECTED_EVIDENCE: the value is amber." },
          { role: "assistant", content: "I will remember amber." },
        ],
      },
      {
        session_id: "unselected",
        date: "2025/01/02",
        turns: [{
          role: "user",
          content: "UNSELECTED_SESSION_SENTINEL",
        }],
      },
    ];
    state.graph = {
      schemaVersion: 1,
      revision: 1,
      context: { private_branch: "COMPLETE_GRAPH_SENTINEL" },
      provenanceByPointer: {},
    };
    state.summaries = [{
      windowId: "window-1",
      sessionIds: ["unselected"],
      graphRevision: 1,
      summary: "SUMMARY_SENTINEL",
    }];
    state.mutationRecords = [{
      batchId: "batch-1",
      sessionIds: ["unselected"],
      mode: "semantic_updates",
      explanation: "GRAPH_DIFF_SENTINEL",
      accepted: true,
      diffs: [],
      graphRevisionBefore: 0,
      graphRevisionAfter: 1,
      graphHash: "fixture-hash",
    }];
    state.readerPlan = sufficientPlan();

    const assembled = await createAssembleContextNode(fixture.runtime)(state);
    state.finalContext = FinalContextSchema.parse(assembled.finalContext);
    const answered = await createFinalAnswerNode(fixture.runtime)(state);
    state.finalAnswerOutput = answered.finalAnswerOutput ?? null;
    state.answerGeneration = answered.answerGeneration ?? null;

    const prompt = fixture.gateway.prompt?.messages
      .map((message) => message.content)
      .join("\n") ?? "";
    expect(prompt).toContain("SELECTED_EVIDENCE");
    expect(prompt).toContain("COMPACT_READER_FACT");
    expect(prompt).not.toContain("UNSELECTED_SESSION_SENTINEL");
    expect(prompt).not.toContain("COMPLETE_GRAPH_SENTINEL");
    expect(prompt).not.toContain("GRAPH_DIFF_SENTINEL");
    expect(prompt).not.toContain("SUMMARY_SENTINEL");
    expect(fixture.gateway.rejectsUnknownSession).toBe(true);
    expect(fixture.gateway.rejectsUnincludedTurn).toBe(true);
  });

  test("maps unsupported, restated, and Reader-insufficient outputs to abstention", async () => {
    const scenarios = [
      {
        name: "unsupported evidence",
        question: "What is the selected value?",
        plan: sufficientPlan(),
        answer: {
          hypothesis: "The value is green.",
          evidence: [{ sessionId: "unselected", turnIndex: 0 }],
          supportStatus: "supported" as const,
        },
        expectedIssue: "supported_answer_without_valid_evidence",
      },
      {
        name: "question restatement",
        question: "What is the selected value?",
        plan: sufficientPlan(),
        answer: {
          hypothesis: "What is the selected value?",
          evidence: [{ sessionId: "selected", turnIndex: 1 }],
          supportStatus: "supported" as const,
        },
        expectedIssue: "question_restatement_hypothesis",
      },
      {
        name: "insufficient Reader",
        question: "What is missing?",
        plan: {
          supportStatus: "insufficient" as const,
          answerMode: "abstain" as const,
          selectedSessions: [],
          selectedGraphPointers: [],
          evidenceFacts: [],
          conflicts: [],
        },
        answer: {
          hypothesis: "An invented answer.",
          evidence: [],
          supportStatus: "supported" as const,
        },
        expectedIssue: "reader_plan_insufficient",
      },
    ];

    for (const scenario of scenarios) {
      const fixture = await runtime(`memorybench-gate5-${scenario.name}-`);
      const state = emptyState("gate5-safety");
      state.action = "answer";
      state.question = scenario.question;
      state.questionDate = "2025/01/03";
      state.sessions = [
        {
          session_id: "selected",
          date: "2025/01/01",
          turns: [
            { role: "user", content: "Which value?" },
            { role: "assistant", content: "The value is amber." },
          ],
        },
        {
          session_id: "unselected",
          date: "2025/01/02",
          turns: [{ role: "user", content: "The value is green." }],
        },
      ];
      state.readerPlan = scenario.plan;
      state.finalAnswerOutput = scenario.answer;
      state.answerGeneration = generation;

      const mapped = await createMapAnswerResultNode(fixture.runtime)(state);
      const answerResult = AnswerResultSchema.parse(mapped.answerResult);
      expect(answerResult.hypothesis, scenario.name).toBe(
        "The available memory does not contain this information.",
      );
      expect(answerResult.evidence, scenario.name).toEqual([]);
      expect(
        answerResult.trace.final_answer_forced_insufficient,
        scenario.name,
      ).toBe(true);
      expect(
        answerResult.trace.final_answer_safety_issues,
        scenario.name,
      ).toContain(scenario.expectedIssue);
    }
  });
});
