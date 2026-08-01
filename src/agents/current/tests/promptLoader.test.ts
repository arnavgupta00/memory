import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { formatRetrievedMemory } from "../src/answer/formatMemory.js";
import { renderAnswerPrompt } from "../src/answer/renderAnswerPrompt.js";
import { PromptLoader } from "../src/services/promptLoader.js";
import type { RetrievalResult, SelectedSpan } from "../src/retrieval/types.js";
import { DEFAULT_RETRIEVAL_OPTIONS } from "../src/retrieval/types.js";

describe("YAML prompt loader with {{variables}}", () => {
  test("renders answer.yaml fill-ins", async () => {
    const rendered = await new PromptLoader().render("answer", {
      question: "What degree did I graduate with?",
      question_date: "2023/05/30 (Tue) 23:40",
      retrieved_memory: "### session demo | date 2023/01/01 | turns 0-1\n[user turn=0]\nI got a BA.",
    });
    expect(rendered.promptId).toBe("session-retrieval-answer-v1");
    const user = rendered.messages.find((message) => message.role === "user")?.content ?? "";
    expect(user).toContain("What degree did I graduate with?");
    expect(user).toContain("2023/05/30 (Tue) 23:40");
    expect(user).toContain("I got a BA.");
    expect(user).not.toContain("{{");
    expect(user).not.toContain("}}");
  });

  test("allows the same {{variable}} more than once", async () => {
    const root = await mkdtemp(join(tmpdir(), "memorybench-double-brace-"));
    await writeFile(
      join(root, "echo.yaml"),
      `
schema_version: 1
id: echo-v1
description: fixture
output_contract: fixture_v1
required_variables: [name]
messages:
  - role: user
    content: "Hello {{name}}. Again: {{name}}."
`,
    );
    const rendered = await new PromptLoader(root).render("echo", { name: "Ada" });
    expect(rendered.messages[0]?.content).toBe("Hello Ada. Again: Ada.");
  });

  test("rejects missing, extra, and undeclared placeholders", async () => {
    const root = await mkdtemp(join(tmpdir(), "memorybench-bad-prompt-"));
    await writeFile(
      join(root, "bad.yaml"),
      `
schema_version: 1
id: bad-v1
description: invalid fixture
output_contract: fixture_v1
required_variables: [question]
messages:
  - role: user
    content: "{{question}} {{undeclared}}"
`,
    );
    await expect(new PromptLoader(root).render("bad", { question: "?" })).rejects.toThrow(
      "placeholder mismatch",
    );
    await expect(
      new PromptLoader().render("answer", {
        question: "q",
        question_date: "d",
        retrieved_memory: "m",
        extra: "nope",
      }),
    ).rejects.toThrow("extra=extra");
  });

  test("loads both v2 answer prompt variants", async () => {
    const loader = new PromptLoader();
    for (const name of ["answer-v2-simple", "answer-v2-rules", "answer-v2-evidence"] as const) {
      const rendered = await loader.render(name, {
        question: "q",
        question_date: "d",
        retrieved_memory: "m",
      });
      expect(rendered.promptId).toContain("v2");
      const user = rendered.messages.find((message) => message.role === "user")?.content ?? "";
      expect(user).toContain("q");
      expect(user).toContain("m");
      expect(user).not.toContain("If the memory is insufficient, abstain.");
    }
  });

  test("renders answer-shaped retrieval workflow prompts", async () => {
    const loader = new PromptLoader();
    const blueprint = await loader.render("hop-answer-blueprint-v1", {
      question: "How long was it between starting and completing the migration?",
      question_date: "2026-08-02",
      routing_mode: "temporal",
    });
    expect(blueprint.promptId).toBe("hop-answer-blueprint-v1");
    expect(blueprint.messages.some((message) => message.content.includes("blank answer template")))
      .toBe(true);

    const controller = await loader.render("hop-answer-search-controller-v1", {
      question: "How long was it between starting and completing the migration?",
      question_date: "2026-08-02",
      phase: "follow_up",
      evidence_blueprint: '{"slots":[]}',
      candidate_catalog: "candidate 1: memory_001",
    });
    expect(controller.promptId).toBe("hop-answer-search-controller-v1");
    expect(controller.messages.some((message) => message.content.includes("discovered_vocabulary")))
      .toBe(true);
    expect(controller.messages.every((message) => !message.content.includes("{{"))).toBe(true);
  });

  test("loads select-v4/v5 and answer-v6-package prompts", async () => {
    const loader = new PromptLoader();
    const select = await loader.render("select-v4", {
      question: "q",
      question_date: "d",
      retrieved_memory: "m",
      package_max_turns: "24",
    });
    expect(select.promptId).toContain("select");
    expect(select.messages.some((message) => message.content.includes("candidateStatus"))).toBe(
      true,
    );
    expect(
      select.messages.some((message) => message.content.includes("SESSION level")),
    ).toBe(true);
    const selectV5 = await loader.render("select-v5", {
      question: "q",
      question_date: "d",
      retrieved_memory: "m",
      session_index: "idx",
      package_max_turns: "24",
      session_expand_max: "8",
    });
    expect(selectV5.messages.some((message) => message.content.includes("expandSessions"))).toBe(
      true,
    );
    expect(selectV5.messages.some((message) => message.content.includes("idx"))).toBe(true);
    const answer = await loader.render("answer-v6-package", {
      question: "q",
      question_date: "d",
      context_package: "pkg",
    });
    expect(answer.promptId).toContain("package");
    const system = answer.messages.find((message) => message.role === "system")?.content ?? "";
    expect(system).toContain('substitute "0"');
    expect(system).toContain("Aggregate / count");
    expect(system).toContain("explicit date arithmetic");
    expect(system).toContain("Advice / tips / suggestions / recommendations");
  });

  test("renderAnswerPrompt fills retrieved_memory from spans", async () => {
    const spans: SelectedSpan[] = [
      {
        sessionId: "s1",
        date: "2023/01/01",
        startTurn: 0,
        endTurn: 1,
        bestRank: 1,
        bestScore: 1,
        matchedTerms: [],
        characterCount: 20,
        turns: [
          { turnIndex: 0, role: "user", content: "I studied biology.", truncated: false },
          { turnIndex: 1, role: "assistant", content: "Nice.", truncated: false },
        ],
      },
    ];
    const retrieval: RetrievalResult = {
      windows: [],
      ranked: [],
      spans,
      characterCount: 20,
      estimatedTokens: 5,
      options: DEFAULT_RETRIEVAL_OPTIONS,
    };
    const rendered = await renderAnswerPrompt({
      question: "What did I study?",
      questionDate: "2023/02/01",
      retrieval,
    });
    const user = rendered.messages.find((message) => message.role === "user")?.content ?? "";
    expect(user).toContain(formatRetrievedMemory(spans));
    expect(user).toContain("[user sessionId=s1 turnIndex=0]");
    expect(user).toContain("I studied biology.");
  });
});
