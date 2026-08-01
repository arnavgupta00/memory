import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BEAM_ABILITIES,
  BEAM_SOURCE_COMMIT,
  beamQuestionKey,
  prepareBeamDataset,
} from "../src/benchmarks/beam1m.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("prepareBeamDataset", () => {
  it("uses official turn groups as sessions and keeps gold metadata out of inference", () => {
    const root = mkdtempSync(resolve(tmpdir(), "beam-1m-test-"));
    temporaryDirectories.push(root);
    const conversationDir = resolve(root, "3");
    mkdirSync(resolve(conversationDir, "probing_questions"), { recursive: true });
    const topics = `${JSON.stringify([{ id: 3, category: "Coding" }], null, 2)}\n`;
    const chat = `${JSON.stringify([{
      batch_number: 1,
      turns: [
        [
          { role: "user", id: 0, time_anchor: "March-01-2024", content: "first" },
          { role: "assistant", id: 1, content: "reply" },
          { role: "user", id: 2, content: "follow-up" },
          { role: "assistant", id: 3, content: "follow-up reply" },
        ],
        [
          { role: "user", id: 4, time_anchor: "March-02-2024", content: "second" },
          { role: "assistant", id: 5, content: "second reply" },
        ],
      ],
    }], null, 2)}\n`;
    const probes = Object.fromEntries(BEAM_ABILITIES.map((ability) => [ability, [
      {
        question: `${ability} first?`,
        difficulty: "easy",
        source_chat_ids: { statement: [2] },
        rubric: ["private rubric one"],
      },
      {
        question: `${ability} second?`,
        difficulty: "hard",
        source_chat_ids: [4],
        rubric: ["private rubric two"],
      },
    ]]));
    const probeText = `${JSON.stringify(probes, null, 2)}\n`;
    writeFileSync(resolve(root, "topics.json"), topics);
    writeFileSync(resolve(conversationDir, "chat.json"), chat);
    writeFileSync(
      resolve(conversationDir, "probing_questions/probing_questions.json"),
      probeText,
    );
    const questionKeys = BEAM_ABILITIES.flatMap((ability) => [
      beamQuestionKey(3, ability, 1),
      beamQuestionKey(3, ability, 2),
    ]);
    const manifest = {
      schema_version: 1,
      benchmark: "BEAM",
      tier: "1M",
      name: "fixture",
      role: "development",
      source: {
        repository: "https://github.com/mohammadtavakoli78/BEAM",
        commit: BEAM_SOURCE_COMMIT,
        topics_sha256: sha256(topics),
      },
      conversation_ids: [3],
      question_keys: questionKeys,
      source_records: [{
        conversation_id: 3,
        chat_sha256: sha256(chat),
        probing_questions_sha256: sha256(probeText),
      }],
    };
    const manifestPath = resolve(root, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const prepared = prepareBeamDataset({ beamRoot: root, manifestPath });
    expect(prepared.dataset.conversations[0]?.sessions).toHaveLength(2);
    expect(prepared.dataset.conversations[0]?.sessions[0]).toHaveLength(4);
    expect(prepared.dataset.conversations[0]?.session_dates).toEqual([
      "session-0001 | March-01-2024",
      "session-0002 | March-02-2024",
    ]);
    expect(prepared.oracle[0]?.answer_session_ids).toEqual(["beam1m_c03_s0001"]);
    expect(prepared.oracle[1]?.answer_session_ids).toEqual(["beam1m_c03_s0002"]);
    expect(prepared.dataset.cases[0]?.question_date).toBe("March-02-2024");
    const inferenceJson = JSON.stringify(prepared.dataset);
    expect(inferenceJson).not.toContain("private rubric");
    expect(inferenceJson).not.toContain("source_chat_ids");
  });
});
