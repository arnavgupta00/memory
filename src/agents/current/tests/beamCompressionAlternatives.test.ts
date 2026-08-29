import { describe, expect, it } from "vitest";

import type {
  DiscoverySession,
  DiscoveryUnion,
  RecertifiedOracleEntry,
} from "../src/compression/beamCompression.js";
import {
  applyConservativeRouter,
  evaluateRawEvidenceCoverage,
  materializeSourcePointers,
  shardDiscoverySessions,
} from "../src/compression/beamCompressionAlternatives.js";
import { PromptLoader } from "../src/services/promptLoader.js";

function session(id: number, real: string, contents: string[]): DiscoverySession {
  return {
    realSessionId: real,
    opaqueSessionId: `memory_${String(id).padStart(3, "0")}`,
    date: `day-${String(id)}`,
    turns: contents.map((content) => ({ role: "user", content })),
    hitCount: 1,
    bestRank: id,
    retrievalFamilies: ["sparse"],
    retrievalStages: ["initial"],
  };
}

function fixture(): { discovery: DiscoveryUnion; oracle: RecertifiedOracleEntry } {
  const sessions = [
    session(1, "raw_a", ["Setup", "The launch moved to Friday.", "Reason"]),
    session(2, "raw_b", ["The prior launch date was Monday."]),
    session(3, "raw_c", ["Unrelated lunch discussion."]),
  ];
  return {
    discovery: {
      questionId: "beam-1m/test/temporal/1",
      sessions,
      rawSessionIds: sessions.map((item) => item.realSessionId),
    },
    oracle: {
      question_id: "beam-1m/test/temporal/1",
      status: "certified",
      evidence_atoms: [
        {
          atom_id: "new_date",
          description: "New date",
          sources: [{
            message_id: 1,
            session_id: "raw_a",
            turn_index: 1,
            role: "user",
            quote: "The launch moved to Friday.",
          }],
        },
        {
          atom_id: "old_date",
          description: "Old date",
          sources: [{
            message_id: 2,
            session_id: "raw_b",
            turn_index: 0,
            role: "user",
            quote: "The prior launch date was Monday.",
          }],
        },
      ],
    },
  };
}

describe("BEAM alternative compression primitives", () => {
  it("packs every whole session into exactly one bounded shard", () => {
    const { discovery } = fixture();
    const shards = shardDiscoverySessions(discovery.sessions, 20);
    expect(shards.flatMap((shard) => shard.sessions.map((item) => item.opaqueSessionId)))
      .toEqual(discovery.sessions.map((item) => item.opaqueSessionId));
    expect(new Set(shards.flatMap((shard) => shard.sessions)).size).toBe(3);
  });

  it("drops a whole session only when both routing lenses agree", () => {
    const { discovery } = fixture();
    const pkg = applyConservativeRouter(discovery, [{
      directSafeToDrop: ["memory_001", "memory_003"],
      contextualSafeToDrop: ["memory_002", "memory_003"],
    }]);
    expect(pkg.representedRealSessionIds).toEqual(["raw_a", "raw_b"]);
  });

  it("dereferences raw turns and measures complete-story preservation", () => {
    const { discovery, oracle } = fixture();
    const pkg = materializeSourcePointers({
      discovery,
      haloTurns: 0,
      pointers: [
        { sessionId: "memory_001", turnStart: 1, turnEnd: 1, keepWholeSession: false },
        { sessionId: "memory_002", turnStart: 0, turnEnd: 0, keepWholeSession: false },
      ],
    });
    expect(pkg.segments.flatMap((segment) => segment.turns.map((turn) => turn.content)))
      .toEqual(["The launch moved to Friday.", "The prior launch date was Monday."]);
    expect(evaluateRawEvidenceCoverage(pkg, oracle)).toEqual(expect.objectContaining({
      coveredAtoms: 2,
      totalAtoms: 2,
      fullStory: true,
    }));
  });

  it("fails open to the complete union on an invalid source address", () => {
    const { discovery } = fixture();
    const pkg = materializeSourcePointers({
      discovery,
      pointers: [{
        sessionId: "memory_999",
        turnStart: 0,
        turnEnd: 0,
        keepWholeSession: false,
      }],
    });
    expect(pkg.failOpen).toBe(true);
    expect(pkg.representedRealSessionIds).toEqual(["raw_a", "raw_b", "raw_c"]);
    expect(pkg.invalidPointers).toHaveLength(1);
  });

  it("accepts a whole-session pointer without using its turn endpoints", () => {
    const { discovery } = fixture();
    const pkg = materializeSourcePointers({
      discovery,
      pointers: [{
        sessionId: "memory_002",
        turnStart: 99,
        turnEnd: 100,
        keepWholeSession: true,
      }],
    });
    expect(pkg.failOpen).toBe(false);
    expect(pkg.representedRealSessionIds).toEqual(["raw_b"]);
  });

  it("renders every alternative prompt without unresolved variables", async () => {
    const loader = new PromptLoader();
    const prompts = await Promise.all([
      loader.render("beam-compression-session-router-v1", {
        question: "q",
        question_date: "d",
        router_sessions: "[]",
      }),
      loader.render("beam-compression-story-compiler-v1", {
        question: "q",
        question_date: "d",
        discovery_sessions: "[]",
      }),
      loader.render("beam-compression-coverage-ledger-v1", {
        question: "q",
        question_date: "d",
      }),
      loader.render("beam-compression-shard-scout-v1", {
        question: "q",
        question_date: "d",
        coverage_ledger: "{}",
        scout_phase: "initial",
        scout_sessions: "[]",
      }),
      loader.render("beam-compression-coverage-audit-v1", {
        question: "q",
        question_date: "d",
        coverage_ledger: "{}",
        provisional_sources: "[]",
        shard_catalog: "[]",
      }),
    ]);
    expect(prompts.flatMap((prompt) => prompt.messages)
      .every((message) => !message.content.includes("{{"))).toBe(true);
  });
});
