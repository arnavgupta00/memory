import { describe, expect, it } from "vitest";

import {
  collapseSparseViews,
  familyBalancedRrf,
} from "../src/retrieval/hybridRankFusion.js";

describe("collapseSparseViews", () => {
  it("creates one stable sparse ranking from multiple views", () => {
    expect(collapseSparseViews([
      ["session_b", "session_a", "session_c"],
      ["session_a", "session_b", "session_d"],
      ["session_a", "session_d"],
    ])).toEqual(["session_a", "session_b", "session_d", "session_c"]);
  });
});

describe("familyBalancedRrf", () => {
  it("gives equal weight to sparse and dense families", () => {
    const result = familyBalancedRrf({
      queryCount: 1,
      rankings: [
        { family: "sparse", queryIndex: 0, sessionIds: ["sparse_only"] },
        { family: "dense", queryIndex: 0, sessionIds: ["dense_only"] },
      ],
    });
    expect(result).toHaveLength(2);
    expect(result[0]?.score).toBeCloseTo(result[1]?.score ?? 0);
    expect(result.find((item) => item.sessionId === "sparse_only")?.sparseScore).toBeGreaterThan(0);
    expect(result.find((item) => item.sessionId === "dense_only")?.denseScore).toBeGreaterThan(0);
  });

  it("deduplicates a session inside a ranking", () => {
    const [result] = familyBalancedRrf({
      queryCount: 1,
      rankings: [
        { family: "dense", queryIndex: 0, sessionIds: ["session_a", "session_a"] },
      ],
    });
    expect(result?.denseRanks).toEqual([{ queryIndex: 0, rank: 1 }]);
  });
});
