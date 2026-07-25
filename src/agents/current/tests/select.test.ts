import { describe, expect, test } from "vitest";

import { selectSpans } from "../src/retrieval/select.js";
import type { Bm25SearchResult, TurnWindow } from "../src/retrieval/types.js";
import type { TimestampedSession } from "../src/types.js";
import { buildTurnWindows } from "../src/retrieval/windows.js";

function session(id: string, date: string, contents: string[]): TimestampedSession {
  return {
    session_id: id,
    date,
    turns: contents.map((content, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content,
    })),
  };
}

function rank(
  windows: TurnWindow[],
  documentId: string,
  score: number,
  rankValue: number,
): Bm25SearchResult {
  const window = windows.find((item) => item.document.id === documentId);
  if (!window) throw new Error(`missing window ${documentId}`);
  return {
    documentId,
    score,
    bm25Score: score,
    temporalBoost: 0,
    matchedTerms: ["topic"],
    rank: rankValue,
  };
}

describe("span selection", () => {
  test("merges overlapping same-session windows into one contiguous span", () => {
    const sessions = [session("s1", "2023/01/01", ["a", "b", "c", "d", "e", "f"])];
    const windows = buildTurnWindows(sessions, 4, 2);
    const spans = selectSpans({
      sessions,
      windows,
      ranked: [
        rank(windows, "s1#0-3", 5, 1),
        rank(windows, "s1#2-5", 4, 2),
      ],
      charBudget: 40_000,
      maxTurnChars: 4_000,
    });
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      sessionId: "s1",
      startTurn: 0,
      endTurn: 5,
      bestRank: 1,
    });
    expect(spans[0]?.turns).toHaveLength(6);
  });

  test("truncates oversized turns", () => {
    const sessions = [session("s1", "2023/01/01", ["x".repeat(50), "short"])];
    const windows = buildTurnWindows(sessions, 4, 2);
    const spans = selectSpans({
      sessions,
      windows,
      ranked: [rank(windows, "s1#0-1", 1, 1)],
      charBudget: 40_000,
      maxTurnChars: 10,
    });
    expect(spans[0]?.turns[0]?.truncated).toBe(true);
    expect(spans[0]?.turns[0]?.content.endsWith("…")).toBe(true);
    expect(spans[0]?.turns[0]?.content.length).toBe(11);
    expect(spans[0]?.turns[1]?.truncated).toBe(false);
  });

  test("fills the character budget in rank order and never drops the top span", () => {
    const sessions = [
      session("s1", "2023/01/01", ["aaaa", "bbbb"]),
      session("s2", "2023/01/02", ["cccc", "dddd"]),
      session("s3", "2023/01/03", ["eeee", "ffff"]),
    ];
    const windows = buildTurnWindows(sessions, 4, 2);
    const spans = selectSpans({
      sessions,
      windows,
      ranked: [
        rank(windows, "s1#0-1", 9, 1),
        rank(windows, "s2#0-1", 8, 2),
        rank(windows, "s3#0-1", 7, 3),
      ],
      charBudget: 30,
      maxTurnChars: 4_000,
    });
    // Top-ranked span is always kept, even when it alone exceeds the budget.
    expect(spans).toHaveLength(1);
    expect(spans[0]?.sessionId).toBe("s1");
    expect(spans[0]?.characterCount).toBeGreaterThan(30);
  });

  test("orders selected spans chronologically", () => {
    const sessions = [
      session("later", "2023/06/01", ["later-user", "later-assistant"]),
      session("earlier", "2023/01/01", ["earlier-user", "earlier-assistant"]),
    ];
    const windows = buildTurnWindows(sessions, 4, 2);
    const spans = selectSpans({
      sessions,
      windows,
      ranked: [
        rank(windows, "later#0-1", 2, 1),
        rank(windows, "earlier#0-1", 1, 2),
      ],
      charBudget: 40_000,
      maxTurnChars: 4_000,
    });
    expect(spans.map((span) => span.sessionId)).toEqual(["earlier", "later"]);
  });
});
