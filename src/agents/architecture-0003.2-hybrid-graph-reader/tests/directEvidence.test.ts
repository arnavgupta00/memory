import { describe, expect, test } from "vitest";

import { collectDirectEvidence } from "../src/services/directEvidence.js";
import type { MasterContextGraph, SourceReference } from "../src/types.js";

function source(sessionId: string, excerpt: string): SourceReference {
  return { sessionId, turnIndex: 0, sessionDate: "2023/12/10", batchId: "b0001", excerpt };
}

describe("direct evidence ledger", () => {
  test("is question-independent and front-loads exact temporal qualifiers", () => {
    const graph: MasterContextGraph = {
      schemaVersion: 1,
      revision: 1,
      context: {},
      provenanceByPointer: {
        "/context/preferences/user/food": [source("food", "I like spicy noodles.")],
        "/context/events/user/market/attendance": [
          source("market", "I attended the annual market a week before the sale day."),
        ],
        "/context/possessions/user/phone/purchase": [
          source("phone", "I bought my Phone Pro on the sale day."),
        ],
      },
    };

    const evidence = collectDirectEvidence(graph);

    expect(evidence.map((item) => item.sessionId)).toEqual(["market", "phone", "food"]);
    expect(evidence[0]?.excerpt).toContain("a week before");
    expect(evidence[0]?.containsTemporalCue).toBe(true);
  });

  test("deduplicates one source referenced by multiple graph pointers", () => {
    const shared = source("s1", "My follower count increased to 350 last week.");
    const graph: MasterContextGraph = {
      schemaVersion: 1,
      revision: 1,
      context: {},
      provenanceByPointer: {
        "/context/measurements/user/followers": [shared],
        "/context/measurements/user/followers/current/value": [shared],
      },
    };

    const evidence = collectDirectEvidence(graph);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.pointers).toHaveLength(2);
  });
});
