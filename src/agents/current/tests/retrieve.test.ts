import { describe, expect, test } from "vitest";

import { dedupeSessionsById, retrieveMemory } from "../src/retrieval/retrieve.js";
import type { TimestampedSession } from "../src/types.js";

function session(id: string, date: string): TimestampedSession {
  return {
    session_id: id,
    date,
    turns: [
      { role: "user", content: "I ran a marathon yesterday." },
      { role: "assistant", content: "Nice work on the marathon." },
    ],
  };
}

describe("retrieveMemory", () => {
  test("deduplicates repeated session IDs by keeping the first occurrence", () => {
    const sessions = [
      session("dup", "2023/01/01"),
      session("other", "2023/02/01"),
      session("dup", "2023/03/01"),
    ];
    expect(dedupeSessionsById(sessions).map((item) => item.date)).toEqual([
      "2023/01/01",
      "2023/02/01",
    ]);
    expect(() =>
      retrieveMemory({
        question: "When did I run a marathon?",
        questionDate: "2023/04/01",
        sessions,
      }),
    ).not.toThrow();
  });
});
