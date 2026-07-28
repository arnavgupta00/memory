import { describe, expect, it } from "vitest";

import {
  expandSeriesSiblingSpans,
  seriesPrefix,
  sessionToFullSpan,
} from "../src/retrieval/seriesExpand.js";
import type { SelectedSpan } from "../src/retrieval/types.js";
import type { TimestampedSession } from "../src/types.js";

const sessions: TimestampedSession[] = [
  {
    session_id: "answer_foo_1",
    date: "2023-01-01",
    turns: [{ role: "user", content: "first" }],
  },
  {
    session_id: "answer_foo_2",
    date: "2023-01-02",
    turns: [{ role: "user", content: "second gold" }],
  },
  {
    session_id: "other_1",
    date: "2023-01-03",
    turns: [{ role: "user", content: "unrelated" }],
  },
];

const seedSpan: SelectedSpan = sessionToFullSpan(sessions[0]!);

describe("seriesExpand", () => {
  it("parses series prefixes", () => {
    expect(seriesPrefix("answer_foo_2")).toBe("answer_foo");
    expect(seriesPrefix("plain")).toBe("plain");
  });

  it("pulls sibling sessions that share a series prefix", () => {
    const expanded = expandSeriesSiblingSpans({
      sessions,
      spans: [seedSpan],
      maxSessions: 8,
    });
    const ids = expanded.map((span) => span.sessionId);
    expect(ids).toEqual(expect.arrayContaining(["answer_foo_1", "answer_foo_2"]));
    expect(ids).not.toContain("other_1");
  });
});
