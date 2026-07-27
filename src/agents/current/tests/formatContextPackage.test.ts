import { describe, expect, it } from "vitest";

import { formatContextPackage } from "../src/answer/formatContextPackage.js";
import { renderAnswerPrompt } from "../src/answer/renderAnswerPrompt.js";
import type { ContextPackage } from "../src/types.js";
import type { RetrievalResult } from "../src/retrieval/types.js";

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
    {
      sessionId: "s1",
      turnIndex: 2,
      date: "2023-01-01",
      role: "user",
      text: "Then two more.",
      why: "supporting turn from selected session",
      tier: "supporting",
    },
  ],
  characterCount: 40,
  estimatedTokens: 10,
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

describe("formatContextPackage", () => {
  it("renders SELECTED before SUPPORTING", () => {
    const text = formatContextPackage(pkg);
    expect(text).toContain("candidateStatus: found");
    expect(text).toContain("## SELECTED (matched the question)");
    expect(text).toContain("## SUPPORTING (same sessions; use when they bear on the question)");
    expect(text.indexOf("SELECTED")).toBeLessThan(text.indexOf("SUPPORTING"));
    expect(text.indexOf("I bought three apples.")).toBeLessThan(text.indexOf("Then two more."));
  });

  it("renders NO MATCHING TURNS FOUND when none_found", () => {
    const text = formatContextPackage({
      ...pkg,
      candidateStatus: "none_found",
      items: [],
      characterCount: 0,
      estimatedTokens: 0,
    });
    expect(text).toContain("## NO MATCHING TURNS FOUND");
    expect(text).not.toContain("## SUPPORTING");
  });
});

describe("renderAnswerPrompt package mode", () => {
  it("fills answer-v5-package from context package only", async () => {
    const rendered = await renderAnswerPrompt({
      question: "How many apples?",
      questionDate: "2023-03-01",
      retrieval: emptyRetrieval,
      contextPackage: pkg,
      promptName: "answer-v5-package",
    });
    expect(rendered.promptId).toContain("package");
    const user = rendered.messages.find((message) => message.role === "user")?.content ?? "";
    expect(user).toContain("How many apples?");
    expect(user).toContain("I bought three apples.");
    expect(user).toContain("## SELECTED");
    expect(user).not.toContain("{{context_package}}");
  });
});
