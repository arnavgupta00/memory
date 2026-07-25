import { describe, expect, test } from "vitest";

import {
  applyContextoMutation,
  graphHash,
  replayMutationRecords,
} from "../src/services/graphMutations.js";
import {
  boundMutationSourceExcerpts,
  boundSourceExcerpt,
} from "../src/services/sourceExcerpts.js";
import { decodeContextoMutation } from "../src/services/contextoWire.js";
import { personalSignalIndex } from "../src/services/personalSignals.js";
import {
  ContextoMutationSchema,
  ContextoSemanticWireResponseSchema,
  GraphMutationRecordSchema,
  SOURCE_EXCERPT_MAX_LENGTH,
  type ContextoMutation,
} from "../src/types.js";

describe("source excerpt bounding", () => {
  test("keeps both useful ends without splitting Unicode graphemes", () => {
    const longExcerpt = `I completed my international project ${"🧠".repeat(400)} successfully yesterday.`;
    const bounded = boundSourceExcerpt(longExcerpt);
    expect(bounded).not.toBeNull();
    expect(bounded?.length).toBeLessThanOrEqual(SOURCE_EXCERPT_MAX_LENGTH);
    expect(bounded).toContain("I completed my international project");
    expect(bounded).toContain("successfully yesterday.");
    expect(bounded).toContain("\n…\n");
    expect(bounded).not.toMatch(/[\uD800-\uDBFF]$/u);
    expect(bounded).not.toMatch(/^[\uDC00-\uDFFF]/u);
  });

  test("bounds all canonical mutation source families without mutating the input", () => {
    const excerpt = `start ${"資料".repeat(400)} end`;
    const source = {
      sessionId: "s1",
      turnIndex: 0,
      sessionDate: "2025/01/01",
      batchId: "b0001",
      excerpt,
    };
    const mutations: ContextoMutation[] = [
      {
        mode: "semantic_updates",
        batchSummary: "semantic",
        ignoredSessions: [],
        updates: [{
          domain: "projects",
          path: ["user", "project", "status"],
          memoryType: "fact",
          updateMode: "set",
          value: "complete",
          effectiveAt: null,
          unit: null,
          sources: [source],
          reason: "direct",
        }],
      },
      {
        mode: "patch",
        explanation: "patch",
        operations: [{
          op: "add",
          path: "/context/projects/user/project",
          value: "complete",
          sources: [source],
          reason: "direct",
        }],
      },
      {
        mode: "replace_graph",
        graph: { projects: { user: { project: "complete" } } },
        provenance: [{
          pointer: "/context/projects/user/project",
          sources: [source],
        }],
        migration: [{
          from: "/context/projects/user/old_project",
          outcome: "removed",
          to: null,
          reason: "obsolete",
          sources: [source],
        }],
        explanation: "replace",
      },
    ];

    for (const mutation of mutations) {
      const original = structuredClone(mutation);
      const bounded = boundMutationSourceExcerpts(mutation);
      expect(mutation).toEqual(original);
      expect(() => ContextoMutationSchema.parse(bounded)).not.toThrow();
    }
  });

  test("bounds deterministic signal provenance before state validation and replays to the same hash", () => {
    const content = `I completed my accessibility project ${"👩🏽‍💻".repeat(150)} successfully yesterday.`;
    const sessions = [{
      session_id: "long-unicode",
      date: "2025/02/10 (Mon) 10:00",
      turns: [{ role: "user" as const, content }],
    }];
    const signalId = personalSignalIndex(sessions).requiredHighPrioritySignals[0]?.signalId;
    if (!signalId) throw new Error("fixture must produce a required signal");
    const wire = ContextoSemanticWireResponseSchema.parse({
      mutation: {
        mode: "semantic_updates",
        batchSummary: "completed project",
        requiredSignalResolutions: [{
          signalId,
          disposition: "materialized",
          updates: [{
            domain: "projects",
            path: ["user", "accessibility_project", "status"],
            memoryType: "fact",
            updateMode: "set",
            value: { kind: "string", value: "complete" },
            effectiveAt: null,
            unit: null,
            sources: [{
              sessionSlot: "session_1",
              turnSlot: "turn_1",
              evidenceQuote: "I completed my accessibility project",
            }],
            reason: "direct completed project",
          }],
          existingPath: null,
          rationale: "direct autobiographical event",
        }],
        additionalUpdates: [],
        sessionAudits: [{
          sessionSlot: "session_1",
          disposition: "extract_personal_memory",
          rationale: "direct durable fact",
        }],
      },
    });
    const providerOutputBeforeDecode = structuredClone(wire);
    const mutation = decodeContextoMutation(
      wire.mutation,
      { batchId: "b0001", sessions },
    );
    expect(wire).toEqual(providerOutputBeforeDecode);
    expect(() => ContextoMutationSchema.parse(mutation)).not.toThrow();
    if (mutation.mode !== "semantic_updates") throw new Error("expected semantic updates");
    const longSources = mutation.updates
      .flatMap((update) => update.sources)
      .filter((item) => item.excerpt?.includes("…"));
    expect(longSources.length).toBeGreaterThan(0);
    expect(longSources.every((item) =>
      item.excerpt !== null && item.excerpt.length <= SOURCE_EXCERPT_MAX_LENGTH
    )).toBe(true);
    expect(longSources[0]).toMatchObject({
      sessionId: "long-unicode",
      turnIndex: 0,
      sessionDate: "2025/02/10 (Mon) 10:00",
      batchId: "b0001",
    });

    const applied = applyContextoMutation({
      graph: { schemaVersion: 1, revision: 0, context: {}, provenanceByPointer: {} },
      mutation,
      batchId: "b0001",
      sessions,
      allowReplacement: false,
    });
    const record = GraphMutationRecordSchema.parse({
      batchId: "b0001",
      sessionIds: ["long-unicode"],
      mode: mutation.mode,
      explanation: mutation.batchSummary,
      accepted: true,
      diffs: applied.diffs,
      graphRevisionBefore: 0,
      graphRevisionAfter: applied.graph.revision,
      graphHash: graphHash(applied.graph),
      acceptedUpdateCount: applied.acceptedUpdateCount,
      rejectedUpdates: applied.rejectedUpdates,
      auditWarnings: applied.auditWarnings,
      mutation,
    });
    expect(graphHash(replayMutationRecords([record]))).toBe(record.graphHash);
  });
});
