import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadArchitectureCases,
  type ArchitectureCase,
  type ArchitectureCaseBundle,
} from "../src/benchmarks/architectureDataset.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryFile(name: string, value: unknown): string {
  const directory = mkdtempSync(resolve(tmpdir(), "architecture-dataset-test-"));
  temporaryDirectories.push(directory);
  const path = resolve(directory, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe("loadArchitectureCases", () => {
  it("preserves the legacy LongMemEval array path", () => {
    const legacy: ArchitectureCase[] = [{
      question_id: "q1",
      question_type: "single-session-user",
      question: "What did I say?",
      question_date: "2026-01-01",
      haystack_session_ids: ["s1"],
      haystack_dates: ["2025-01-01"],
      haystack_sessions: [[{ role: "user", content: "hello" }]],
    }];
    expect(loadArchitectureCases(temporaryFile("legacy.json", legacy))).toEqual(legacy);
  });

  it("materializes compact BEAM cases while sharing conversation content", () => {
    const bundle: ArchitectureCaseBundle = {
      schema_version: 1,
      format: "architecture-case-bundle-v1",
      benchmark: "BEAM",
      tier: "1M",
      conversations: [{
        conversation_id: 3,
        session_ids: ["beam1m_c03_s0001"],
        session_dates: ["session-0001 | March-01-2024"],
        sessions: [[
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
        ]],
      }],
      cases: [
        {
          question_id: "beam-1m/chat-03/abstention/1",
          question_type: "abstention",
          question: "Unknown?",
          question_date: "March-01-2024",
          conversation_id: 3,
        },
        {
          question_id: "beam-1m/chat-03/information_extraction/1",
          question_type: "information_extraction",
          question: "What was said?",
          question_date: "March-01-2024",
          conversation_id: 3,
        },
      ],
    };
    const cases = loadArchitectureCases(temporaryFile("bundle.json", bundle));
    expect(cases).toHaveLength(2);
    expect(cases[0]?.haystack_session_ids).toEqual(["beam1m_c03_s0001"]);
    expect(cases[0]?.haystack_sessions).toBe(cases[1]?.haystack_sessions);
  });
});
