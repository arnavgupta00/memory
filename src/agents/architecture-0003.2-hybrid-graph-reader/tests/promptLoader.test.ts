import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { PromptLoader } from "../src/services/promptLoader.js";

describe("YAML prompt ownership", () => {
  test("renders all active prompts with only declared variables", async () => {
    const loader = new PromptLoader();
    const contexto = await loader.render("contexto", {
      batch_id: "b0001",
      memory_catalog: "[]",
      personal_signals: "[]",
      sessions: "[]",
    });
    const shino = await loader.render("shino", { master_graph: "{}", session_ids: "[]" });
    const reader = await loader.render("reader", {
      question: "Where?",
      question_date: "2025/01/02",
      session_candidates: "[]",
      graph_candidates: "[]",
      summary_candidates: "[]",
      coverage_fallback_candidates: "[]",
      tail_candidates: "[]",
    });
    const answer = await loader.render("final-answer", {
      question: "Where?",
      question_date: "2025/01/02",
      reader_plan: "{}",
      evidence_package: "{}",
    });
    expect(contexto.promptId).toBe("contexto-semantic-memory-v13");
    expect(shino.messages.map((message) => message.content).join("\n")).not.toContain("secret session body");
    expect(reader.promptId).toBe("hybrid-memory-reader-v1");
    expect(answer.promptId).toBe("final-answer-v5");
    expect(answer.messages.at(-1)?.content).toContain("Where?");
  });

  test("rejects missing, extra, undeclared, and repeated placeholders before a model call", async () => {
    const root = await mkdtemp(join(tmpdir(), "memorybench-prompts-"));
    await writeFile(join(root, "bad.yaml"), `
schema_version: 1
id: bad-v1
description: invalid fixture
output_contract: fixture_v1
required_variables: [question]
messages:
  - role: user
    content: "{question} {question} {undeclared}"
`);
    const loader = new PromptLoader(root);
    await expect(loader.render("bad", { question: "?" })).rejects.toThrow("placeholder mismatch");
    await expect(new PromptLoader().render("shino", { master_graph: "{}", session_ids: "[]", raw_sessions: "forbidden" })).rejects.toThrow("extra=raw_sessions");
  });

  test("keeps the Contexto policy query-blind and free of exposed-case tuning", async () => {
    const rendered = await new PromptLoader().render("contexto", {
      batch_id: "b0001",
      memory_catalog: "[]",
      personal_signals: "[]",
      sessions: "[]",
    });
    const policy = rendered.messages.map((message) => message.content).join("\n").toLowerCase();
    for (const leaked of [
      "945e3d21",
      "73d42213",
      "9a707b81",
      "three times per week",
      "doctor's clinic",
      "baking class",
      "chocolate cake",
    ]) {
      expect(policy).not.toContain(leaked);
    }
  });

  test("keeps the reader policy general rather than case-tuned", async () => {
    const rendered = await new PromptLoader().render("reader", {
      question: "What changed?",
      question_date: "2025/01/02",
      session_candidates: "[]",
      graph_candidates: "[]",
      summary_candidates: "[]",
      coverage_fallback_candidates: "[]",
      tail_candidates: "[]",
    });
    const policy = rendered.messages.map((message) => message.content).join("\n").toLowerCase();
    for (const leaked of [
      "195a1a1b",
      "73d42213",
      "945e3d21",
      "yoga",
      "clinic",
      "baking",
    ]) {
      expect(policy).not.toContain(leaked);
    }
  });
});
