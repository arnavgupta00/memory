import { describe, expect, test } from "vitest";

import type { TimestampedSession } from "../src/types.js";
import {
  buildTurnWindows,
  renderWindowText,
  windowDocumentId,
} from "../src/retrieval/windows.js";

function session(id: string, turnCount: number): TimestampedSession {
  return {
    session_id: id,
    date: "2023/05/01 (Mon) 10:00",
    turns: Array.from({ length: turnCount }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `turn-${String(index)}`,
    })),
  };
}

describe("turn windows", () => {
  test("emits stable document IDs and date-prefixed role-tagged text", () => {
    const windows = buildTurnWindows([session("s1", 2)], 4, 2, {
      indexUserTurnsOnly: false,
    });
    expect(windows).toHaveLength(1);
    expect(windows[0]?.document.id).toBe(windowDocumentId("s1", 0, 1));
    expect(windows[0]?.document.text).toBe(
      renderWindowText(session("s1", 2), 0, 1, { indexUserTurnsOnly: false }),
    );
    expect(windows[0]?.document.text).toContain("[session_date] 2023/05/01 (Mon) 10:00");
    expect(windows[0]?.document.text).toContain("[user] turn-0");
    expect(windows[0]?.document.text).toContain("[assistant] turn-1");
  });

  test("indexes user turns only when requested, keeping assistant turns in the span", () => {
    const windows = buildTurnWindows([session("s1", 2)], 4, 2, {
      indexUserTurnsOnly: true,
    });
    expect(windows[0]?.document.text).toContain("[user] turn-0");
    expect(windows[0]?.document.text).not.toContain("[assistant]");
    expect(windows[0]?.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  });

  test("keeps short sessions as a single window", () => {
    const windows = buildTurnWindows([session("short", 3)], 4, 2);
    expect(windows.map((item) => item.document.id)).toEqual(["short#0-2"]);
  });

  test("uses stride overlap so adjacent user/assistant pairs co-occur", () => {
    const windows = buildTurnWindows([session("s1", 6)], 4, 2);
    expect(windows.map((item) => item.document.id)).toEqual([
      "s1#0-3",
      "s1#2-5",
    ]);
    const second = windows[1];
    expect(second?.turns.map((turn) => turn.content)).toEqual([
      "turn-2",
      "turn-3",
      "turn-4",
      "turn-5",
    ]);
    // turns 2-3 are the adjacent pair at the boundary between the two windows
    expect(windows[0]?.turns.some((turn) => turn.content === "turn-2")).toBe(true);
    expect(windows[0]?.turns.some((turn) => turn.content === "turn-3")).toBe(true);
    expect(windows[1]?.turns.some((turn) => turn.content === "turn-2")).toBe(true);
    expect(windows[1]?.turns.some((turn) => turn.content === "turn-3")).toBe(true);
  });

  test("covers the final partial window without overshooting", () => {
    const windows = buildTurnWindows([session("s1", 5)], 4, 2);
    expect(windows.map((item) => item.document.id)).toEqual([
      "s1#0-3",
      "s1#2-4",
    ]);
  });

  test("rejects invalid window parameters", () => {
    expect(() => buildTurnWindows([session("s1", 2)], 0, 2)).toThrow("windowTurns");
    expect(() => buildTurnWindows([session("s1", 2)], 4, 0)).toThrow("windowStride");
  });
});
