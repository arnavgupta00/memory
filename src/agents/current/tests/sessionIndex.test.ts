import { describe, expect, it } from "vitest";

import {
  buildSessionIndex,
  formatSessionIndex,
} from "../src/retrieval/sessionIndex.js";
import type { TimestampedSession } from "../src/types.js";

const sessions: TimestampedSession[] = [
  {
    session_id: "s1",
    date: "2023-01-01",
    turns: [
      { role: "user", content: "I bought three honeycrisp apples at the market." },
      { role: "assistant", content: "Nice." },
      { role: "user", content: "Also some pears." },
    ],
  },
  {
    session_id: "s2",
    date: "2023-02-01",
    turns: [
      { role: "user", content: "Skiing in Aspen was fantastic this weekend." },
    ],
  },
];

describe("sessionIndex", () => {
  it("builds date, opener, and distinctive terms per session", () => {
    const index = buildSessionIndex(sessions, { openerChars: 40, topTerms: 4 });
    expect(index).toHaveLength(2);
    expect(index[0]?.sessionId).toBe("s1");
    expect(index[0]?.date).toBe("2023-01-01");
    expect(index[0]?.opener).toContain("honeycrisp");
    expect(index[0]?.opener.length).toBeLessThanOrEqual(41);
    expect(index[0]?.terms.some((term) => ["honeycrisp", "apples", "market", "pears"].includes(term))).toBe(
      true,
    );
    expect(index[1]?.terms).toEqual(expect.arrayContaining(["skiing", "aspen"]));
  });

  it("formats a compact router block", () => {
    const text = formatSessionIndex(buildSessionIndex(sessions, { topTerms: 3 }));
    expect(text).toContain("sessionId=s1");
    expect(text).toContain("opener:");
    expect(text).toContain("terms:");
    expect(text).toContain("sessionId=s2");
  });
});
