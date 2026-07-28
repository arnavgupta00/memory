import { describe, expect, it } from "vitest";

import { formatContextDigest } from "../src/answer/formatContextDigest.js";
import { renderAnswerPrompt } from "../src/answer/renderAnswerPrompt.js";
import { ArchitectureOptionsSchema, HostInitializationSchema } from "../src/config.js";
import type { ContextDigest, ContextPackage } from "../src/types.js";
import type { RetrievalResult } from "../src/retrieval/types.js";
import { createMemoryWorkflow } from "../src/workflow.js";
import type { WorkflowRuntime } from "../src/runtime.js";

const digest: ContextDigest = {
  facts: [
    {
      id: "f1",
      date: "2023-01-01",
      sessionId: "s1",
      turnIndex: 0,
      statement: "User bought three apples.",
    },
    {
      id: "f2",
      date: "2023-02-01",
      sessionId: "s1",
      turnIndex: 2,
      statement: "User bought two more apples.",
    },
  ],
  conflicts: [],
  setMembers: [
    { member: "three apples (Jan)", factId: "f1", date: "2023-01-01" },
    { member: "two more apples (Feb)", factId: "f2", date: "2023-02-01" },
  ],
  omittedNote: "",
};

const pkg: ContextPackage = {
  queryShape: "aggregate",
  setBoundary: "apple counts",
  candidateStatus: "found",
  missingRisk: "n/a",
  items: [
    {
      sessionId: "s1",
      turnIndex: 0,
      date: "2023-01-01",
      role: "user",
      text: "I bought three apples.",
      why: "count",
      tier: "selected",
    },
  ],
  characterCount: 22,
  estimatedTokens: 6,
};

const emptyRetrieval: RetrievalResult = {
  windows: [],
  ranked: [],
  spans: [],
  characterCount: 0,
  estimatedTokens: 0,
  options: {
    windowTurns: 2,
    windowStride: 1,
    topK: 48,
    charBudget: 80_000,
    maxTurnChars: 4_000,
    temporalBoost: 0.15,
  },
};

const nanoRole = {
  kind: "generation" as const,
  provider: "openai" as const,
  model: "gpt-5.4-nano-2026-03-17",
  temperature: 1,
  reasoning_effort: "low" as const,
  max_output_tokens: 8000,
  timeout_seconds: 300,
  concurrency: 4,
  max_retries: 2,
};

describe("formatContextDigest", () => {
  it("renders facts, conflicts, and set members", () => {
    const text = formatContextDigest(digest);
    expect(text).toContain("## FACTS");
    expect(text).toContain("### f1");
    expect(text).toContain("User bought three apples.");
    expect(text).toContain("## SET MEMBERS");
    expect(text).toContain("three apples (Jan)");
    expect(text).toContain("(none flagged)");
  });

  it("renders omitted note when present", () => {
    const text = formatContextDigest({
      ...digest,
      omittedNote: "No cost stated for workshop X.",
    });
    expect(text).toContain("## OMITTED / UNCERTAIN");
    expect(text).toContain("No cost stated for workshop X.");
  });
});

describe("renderAnswerPrompt digest modes", () => {
  it("fills answer-v7-digest from digest only", async () => {
    const rendered = await renderAnswerPrompt({
      question: "How many apples?",
      questionDate: "2023-03-01",
      retrieval: emptyRetrieval,
      contextDigest: digest,
      promptName: "answer-v7-digest",
    });
    expect(rendered.promptId).toContain("digest");
    const user = rendered.messages.find((message) => message.role === "user")?.content ?? "";
    expect(user).toContain("How many apples?");
    expect(user).toContain("User bought three apples.");
    expect(user).not.toContain("{{context_digest}}");
    expect(user).not.toContain("## SELECTED");
  });

  it("fills answer-v7-hybrid from digest and package", async () => {
    const rendered = await renderAnswerPrompt({
      question: "How many apples?",
      questionDate: "2023-03-01",
      retrieval: emptyRetrieval,
      contextDigest: digest,
      contextPackage: pkg,
      promptName: "answer-v7-hybrid",
    });
    expect(rendered.promptId).toContain("hybrid");
    const user = rendered.messages.find((message) => message.role === "user")?.content ?? "";
    expect(user).toContain("Fact digest");
    expect(user).toContain("## SELECTED");
    expect(user).toContain("I bought three apples.");
  });
});

describe("format options and host schema", () => {
  it("defaults format_enabled to false", () => {
    const options = ArchitectureOptionsSchema.parse({});
    expect(options.format_enabled).toBe(false);
    expect(options.format_mode).toBe("additive");
    expect(options.format_prompt).toBe("format-v1");
  });

  it("requires format role when format_enabled", () => {
    expect(() =>
      HostInitializationSchema.parse({
        runId: "t",
        runRoot: "/tmp/t",
        roles: { answer: nanoRole, select: nanoRole },
        providerModelLimits: [
          {
            provider: "openai",
            model: "gpt-5.4-nano-2026-03-17",
            max_concurrency: 4,
            token_budget: 100000,
            window_seconds: 60,
          },
        ],
        options: {
          select_enabled: true,
          format_enabled: true,
          answer_prompt: "answer-v7-digest",
        },
        captureModelIo: false,
        autoExportFinalSvg: false,
      }),
    ).toThrow(/format_enabled requires a format role/);
  });

  it("accepts format role when format_enabled", () => {
    const parsed = HostInitializationSchema.parse({
      runId: "t",
      runRoot: "/tmp/t",
      roles: { answer: nanoRole, select: nanoRole, format: nanoRole },
      providerModelLimits: [
        {
          provider: "openai",
          model: "gpt-5.4-nano-2026-03-17",
          max_concurrency: 4,
          token_budget: 100000,
          window_seconds: 60,
        },
      ],
      options: {
        select_enabled: true,
        format_enabled: true,
        format_mode: "replacement",
        answer_prompt: "answer-v7-digest",
      },
      captureModelIo: false,
      autoExportFinalSvg: false,
    });
    expect(parsed.roles.format?.model).toBe("gpt-5.4-nano-2026-03-17");
    expect(parsed.options.format_mode).toBe("replacement");
  });
});

describe("workflow format edge", () => {
  function runtime(formatEnabled: boolean): WorkflowRuntime {
    return {
      options: ArchitectureOptionsSchema.parse({
        select_enabled: true,
        format_enabled: formatEnabled,
        format_mode: formatEnabled ? "additive" : "additive",
        answer_prompt: formatEnabled ? "answer-v7-hybrid" : "answer-v5-package",
      }),
      artifacts: {} as WorkflowRuntime["artifacts"],
      events: {} as WorkflowRuntime["events"],
      models: {} as WorkflowRuntime["models"],
      prompts: {} as WorkflowRuntime["prompts"],
    };
  }

  it("compiles with format_enabled true", () => {
    const graph = createMemoryWorkflow(runtime(true));
    expect(graph).toBeTruthy();
    expect(runtime(true).options.format_enabled).toBe(true);
  });

  it("compiles with format_enabled false", () => {
    const graph = createMemoryWorkflow(runtime(false));
    expect(graph).toBeTruthy();
    expect(runtime(false).options.format_enabled).toBe(false);
  });
});
