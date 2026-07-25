import { describe, expect, test } from "vitest";

import { classifyContextoCoverage } from "../src/services/contextoCoverage.js";
import { applyContextoMutation, graphHash, replayMutationRecords } from "../src/services/graphMutations.js";
import type {
  GraphMutationRecord,
  MasterContextGraph,
  SemanticMemoryUpdate,
  TimestampedSession,
} from "../src/types.js";

const emptyGraph = (): MasterContextGraph => ({
  schemaVersion: 1,
  revision: 0,
  context: {},
  provenanceByPointer: {},
});

function session(id: string, text: string): TimestampedSession {
  return {
    session_id: id,
    date: "2025/01/02",
    turns: [{ role: "user", content: text }],
  };
}

function update(
  sessionId: string,
  batchId: string,
  value = 3,
): SemanticMemoryUpdate {
  return {
    domain: "routines",
    path: ["user", "exercise", "weekly_frequency"],
    memoryType: "fact",
    updateMode: "set",
    value,
    effectiveAt: "2025-01-02",
    unit: "times_per_week",
    sources: [{
      sessionId,
      turnIndex: 0,
      sessionDate: "2025/01/02",
      batchId,
      excerpt: "I now exercise three times per week.",
    }],
    reason: "The user now exercises three times per week.",
  };
}

describe("deterministic Contexto high-priority coverage", () => {
  test("classifies accepted, duplicate, and rejected signals without changing replay hashes", () => {
    const firstSession = session("s1", "I now exercise three times per week.");
    const firstMutation = {
      mode: "semantic_updates" as const,
      batchSummary: "updated weekly routine",
      ignoredSessions: [],
      updates: [update("s1", "b0001")],
    };
    const first = applyContextoMutation({
      graph: emptyGraph(),
      mutation: firstMutation,
      batchId: "b0001",
      sessions: [firstSession],
      allowReplacement: false,
    });
    const covered = classifyContextoCoverage({
      batchId: "b0001",
      sessions: [firstSession],
      beforeGraph: emptyGraph(),
      afterGraph: first.graph,
      mutation: firstMutation,
      rejectedUpdateIndices: [],
    });
    expect(covered.counts).toEqual({
      graphCovered: 1,
      duplicate: 0,
      sessionIndexFallback: 0,
    });
    expect(covered.signals[0]?.matchedPointers).toEqual([
      "/context/routines/user/exercise/weekly_frequency",
    ]);

    const duplicateSession = session("s2", "I now exercise three times per week.");
    const duplicateUpdate = update("s2", "b0002");
    const duplicateMutation = {
      mode: "semantic_updates" as const,
      batchSummary: "same weekly routine",
      ignoredSessions: [],
      updates: [duplicateUpdate],
    };
    const duplicateApplied = applyContextoMutation({
      graph: first.graph,
      mutation: duplicateMutation,
      batchId: "b0002",
      sessions: [duplicateSession],
      allowReplacement: false,
    });
    const duplicate = classifyContextoCoverage({
      batchId: "b0002",
      sessions: [duplicateSession],
      beforeGraph: first.graph,
      afterGraph: duplicateApplied.graph,
      mutation: duplicateMutation,
      rejectedUpdateIndices: [],
    });
    expect(duplicate.signals[0]?.status).toBe("duplicate");

    const fallback = classifyContextoCoverage({
      batchId: "b0002",
      sessions: [duplicateSession],
      beforeGraph: first.graph,
      afterGraph: first.graph,
      mutation: duplicateMutation,
      rejectedUpdateIndices: [0],
    });
    expect(fallback.signals[0]?.status).toBe("session_index_fallback");

    const record: GraphMutationRecord = {
      batchId: "b0001",
      sessionIds: ["s1"],
      mode: "semantic_updates",
      explanation: firstMutation.batchSummary,
      accepted: true,
      diffs: first.diffs,
      graphRevisionBefore: 0,
      graphRevisionAfter: 1,
      graphHash: graphHash(first.graph),
      acceptedUpdateCount: 1,
      rejectedUpdates: [],
      coverage: covered,
      mutation: firstMutation,
    };
    expect(graphHash(replayMutationRecords([record]))).toBe(record.graphHash);
  });
});
