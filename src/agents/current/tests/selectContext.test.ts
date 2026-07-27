import { describe, expect, it } from "vitest";

import { buildContextPackage } from "../src/nodes/selectContext.js";
import type { SelectedSpan } from "../src/retrieval/types.js";
import type { TimestampedSession } from "../src/types.js";

const sessions: TimestampedSession[] = [
  {
    session_id: "s1",
    date: "2023-01-01",
    turns: [
      { role: "user", content: "I bought three apples." },
      { role: "assistant", content: "Nice." },
      { role: "user", content: "Then two more." },
    ],
  },
  {
    session_id: "s2",
    date: "2023-02-01",
    turns: [{ role: "user", content: "I ate one apple." }],
  },
  {
    session_id: "s3",
    date: "2023-03-01",
    turns: [{ role: "user", content: "I went skiing in Aspen." }],
  },
];

const spans: SelectedSpan[] = [
  {
    sessionId: "s1",
    date: "2023-01-01",
    startTurn: 0,
    endTurn: 2,
    turns: [
      { turnIndex: 0, role: "user", content: "I bought three apples.", truncated: false },
      { turnIndex: 1, role: "assistant", content: "Nice.", truncated: false },
      { turnIndex: 2, role: "user", content: "Then two more.", truncated: false },
    ],
    bestRank: 1,
    bestScore: 1,
    matchedTerms: ["apples"],
    characterCount: 40,
  },
  {
    sessionId: "s2",
    date: "2023-02-01",
    startTurn: 0,
    endTurn: 0,
    turns: [{ turnIndex: 0, role: "user", content: "I ate one apple.", truncated: false }],
    bestRank: 2,
    bestScore: 0.5,
    matchedTerms: ["apple"],
    characterCount: 16,
  },
  {
    sessionId: "s3",
    date: "2023-03-01",
    startTurn: 0,
    endTurn: 0,
    turns: [{ turnIndex: 0, role: "user", content: "I went skiing in Aspen.", truncated: false }],
    bestRank: 3,
    bestScore: 0.1,
    matchedTerms: ["skiing"],
    characterCount: 22,
  },
];

describe("buildContextPackage", () => {
  it("resolves selected turns and drops unknown references", () => {
    const built = buildContextPackage({
      selectOutput: {
        queryShape: "lookup",
        setBoundary: "n/a",
        candidateStatus: "found",
        missingRisk: "n/a",
        items: [
          { sessionId: "s1", turnIndex: 0, why: "three apples" },
          { sessionId: "missing", turnIndex: 0, why: "hallucinated" },
          { sessionId: "s1", turnIndex: 0, why: "duplicate" },
          { sessionId: "s2", turnIndex: 0, why: "ate one" },
        ],
      },
      sessions,
      spans,
      packageMaxTurns: 24,
      packageCharBudget: 12_000,
      packageSupportingEnabled: false,
    });
    const keys = built.package.items.map((item) => `${item.sessionId}:${String(item.turnIndex)}`);
    expect(keys).toEqual(["s1:0", "s2:0"]);
    expect(built.package.items.every((item) => item.tier === "selected")).toBe(true);
    expect(built.warnings).toEqual(
      expect.arrayContaining(["dropped_unknown_select:missing:0"]),
    );
  });

  it("none_found produces an empty package with no supporting filler", () => {
    const built = buildContextPackage({
      selectOutput: {
        queryShape: "aggregate",
        setBoundary: "egg tarts",
        candidateStatus: "none_found",
        missingRisk: "no egg-tart mentions",
        items: [],
      },
      sessions,
      spans,
      packageMaxTurns: 40,
      packageCharBudget: 40_000,
      packageSupportingEnabled: true,
    });
    expect(built.package.candidateStatus).toBe("none_found");
    expect(built.package.items).toHaveLength(0);
  });

  it("empty items coerce to none_found even if status says found", () => {
    const built = buildContextPackage({
      selectOutput: {
        queryShape: "aggregate",
        setBoundary: "x",
        candidateStatus: "found",
        missingRisk: "n/a",
        items: [],
      },
      sessions,
      spans,
      packageMaxTurns: 40,
      packageCharBudget: 40_000,
    });
    expect(built.package.candidateStatus).toBe("none_found");
    expect(built.package.items).toHaveLength(0);
  });

  it("lookup supporting expansion stays inside selector-chosen sessions only", () => {
    const built = buildContextPackage({
      selectOutput: {
        queryShape: "lookup",
        setBoundary: "apples",
        candidateStatus: "found",
        missingRisk: "n/a",
        items: [{ sessionId: "s1", turnIndex: 0, why: "three" }],
      },
      sessions,
      spans,
      packageMaxTurns: 24,
      packageCharBudget: 12_000,
      packageSupportingEnabled: true,
      question: "How many apples did I buy?",
      siblingSessionsEnabled: true,
    });
    const keys = built.package.items.map((item) => `${item.sessionId}:${String(item.turnIndex)}`);
    expect(keys).toEqual(expect.arrayContaining(["s1:0", "s1:2"]));
    expect(keys).not.toContain("s2:0");
    expect(keys).not.toContain("s3:0");
  });

  it("aggregate pulls entity-overlapping sibling sessions into supporting", () => {
    const built = buildContextPackage({
      selectOutput: {
        queryShape: "aggregate",
        setBoundary: "apple purchases before March",
        candidateStatus: "found",
        missingRisk: "n/a",
        items: [{ sessionId: "s1", turnIndex: 0, why: "three" }],
      },
      sessions,
      spans,
      packageMaxTurns: 24,
      packageCharBudget: 12_000,
      packageSupportingEnabled: true,
      question: "How many apples did I buy?",
      siblingSessionsEnabled: true,
      siblingSessionMax: 12,
    });
    const keys = built.package.items.map((item) => `${item.sessionId}:${String(item.turnIndex)}`);
    expect(keys).toEqual(expect.arrayContaining(["s1:0", "s1:2", "s2:0"]));
    expect(keys).not.toContain("s3:0");
    expect(built.package.items.find((item) => item.sessionId === "s2")?.tier).toBe("supporting");
    expect(built.package.items.find((item) => item.sessionId === "s2")?.why).toContain("sibling");
  });

  it("aggregate sibling expansion can be disabled", () => {
    const built = buildContextPackage({
      selectOutput: {
        queryShape: "aggregate",
        setBoundary: "apples",
        candidateStatus: "found",
        missingRisk: "n/a",
        items: [{ sessionId: "s1", turnIndex: 0, why: "three" }],
      },
      sessions,
      spans,
      packageMaxTurns: 24,
      packageCharBudget: 12_000,
      packageSupportingEnabled: true,
      question: "How many apples did I buy?",
      siblingSessionsEnabled: false,
    });
    const keys = built.package.items.map((item) => `${item.sessionId}:${String(item.turnIndex)}`);
    expect(keys).not.toContain("s2:0");
  });

  it("respects package_max_turns", () => {
    const built = buildContextPackage({
      selectOutput: {
        queryShape: "lookup",
        setBoundary: "n/a",
        candidateStatus: "found",
        missingRisk: "ok",
        items: [
          { sessionId: "s1", turnIndex: 0, why: "a" },
          { sessionId: "s1", turnIndex: 2, why: "b" },
          { sessionId: "s2", turnIndex: 0, why: "c" },
        ],
      },
      sessions,
      spans,
      packageMaxTurns: 1,
      packageCharBudget: 12_000,
      packageSupportingEnabled: false,
    });
    expect(built.package.items).toHaveLength(1);
    expect(built.warnings).toContain("dropped_package_max_turns");
  });
});
