import { describe, expect, test } from "vitest";

import { applyContextoMutation, graphHash, replayMutationRecords } from "../src/services/graphMutations.js";
import type { GraphMutationRecord, MasterContextGraph, SourceReference } from "../src/types.js";

const emptyGraph = (): MasterContextGraph => ({ schemaVersion: 1, revision: 0, context: {}, provenanceByPointer: {} });
const source = (sessionId = "s1", batchId = "b0001"): SourceReference => ({ sessionId, turnIndex: 0, sessionDate: "2025/01/01", batchId, excerpt: null });
const sessions = [{ session_id: "s1", date: "2025/01/01", turns: [{ role: "user", content: "Jason lives in Pune" }] }];

describe("deterministic Contexto write gate", () => {
  test("materializes semantic updates, rejects bad records independently, and preserves observation history", () => {
    const firstMutation = {
      mode: "semantic_updates" as const,
      batchSummary: "profile and follower state",
      ignoredSessions: [],
      updates: [
        {
          domain: "people" as const,
          path: ["user", "education", "degree"],
          memoryType: "fact" as const,
          updateMode: "set" as const,
          value: "Business Administration",
          effectiveAt: null,
          unit: null,
          sources: [source()],
          reason: "direct user statement",
        },
        {
          domain: "other" as const,
          path: ["session", "turns"],
          memoryType: "fact" as const,
          updateMode: "set" as const,
          value: "raw transcript",
          effectiveAt: null,
          unit: null,
          sources: [source()],
          reason: "invalid transcript copy",
        },
        {
          domain: "measurements" as const,
          path: ["user", "social_media", "instagram_followers"],
          memoryType: "measurement" as const,
          updateMode: "record_observation" as const,
          value: 250,
          effectiveAt: "2025/01/01",
          unit: "followers",
          sources: [source()],
          reason: "direct measurement",
        },
      ],
    };
    const first = applyContextoMutation({
      graph: emptyGraph(),
      mutation: firstMutation,
      batchId: "b0001",
      sessions,
      allowReplacement: true,
    });
    expect(first.acceptedUpdateCount).toBe(2);
    expect(first.rejectedUpdates).toHaveLength(1);
    expect(first.rejectedUpdates[0]?.reason).toContain("forbidden transcript");
    expect(first.graph.context.people).toBeDefined();
    expect(first.graph.context.session).toBeUndefined();

    const partiallyAcceptedRecord: GraphMutationRecord = {
      batchId: "b0001",
      sessionIds: ["s1"],
      mode: "semantic_updates",
      explanation: firstMutation.batchSummary,
      accepted: true,
      diffs: first.diffs,
      graphRevisionBefore: 0,
      graphRevisionAfter: 1,
      graphHash: graphHash(first.graph),
      acceptedUpdateCount: first.acceptedUpdateCount,
      rejectedUpdates: first.rejectedUpdates,
      mutation: firstMutation,
    };
    expect(graphHash(replayMutationRecords([partiallyAcceptedRecord]))).toBe(partiallyAcceptedRecord.graphHash);

    const secondSource = source("s4", "b0002");
    secondSource.sessionDate = "2025/01/02";
    const secondMutation = {
      mode: "semantic_updates" as const,
      batchSummary: "updated follower state",
      ignoredSessions: [],
      updates: [{
        domain: "measurements" as const,
        path: ["user", "social_media", "instagram_followers"],
        memoryType: "measurement" as const,
        updateMode: "record_observation" as const,
        value: 350,
        effectiveAt: "2025/01/15",
        unit: "followers",
        sources: [secondSource],
        reason: "later measurement",
      }],
    };
    const second = applyContextoMutation({
      graph: first.graph,
      mutation: secondMutation,
      batchId: "b0002",
      sessions: [{ session_id: "s4", date: "2025/01/02", turns: [{}] }],
      allowReplacement: true,
    });
    const measurements = second.graph.context.measurements as Record<string, unknown>;
    const user = measurements.user as Record<string, unknown>;
    const social = user.social_media as Record<string, unknown>;
    const cell = social.instagram_followers as Record<string, unknown>;
    expect((cell.current as Record<string, unknown>).value).toBe(350);
    expect(Object.keys(cell.history as Record<string, unknown>)).toHaveLength(1);
    expect(second.graph.revision).toBe(2);

    const record: GraphMutationRecord = {
      batchId: "b0002",
      sessionIds: ["s4"],
      mode: "semantic_updates",
      explanation: secondMutation.batchSummary,
      accepted: true,
      diffs: second.diffs,
      graphRevisionBefore: 1,
      graphRevisionAfter: 2,
      graphHash: graphHash(second.graph),
      acceptedUpdateCount: 1,
      rejectedUpdates: [],
      mutation: secondMutation,
    };
    expect(graphHash(replayMutationRecords([record], first.graph))).toBe(record.graphHash);
  });

  test("keeps a later-reported historical observation behind the chronologically current value", () => {
    const currentSource = source("s1", "b0001");
    currentSource.sessionDate = "2025/02/01";
    const current = applyContextoMutation({
      graph: emptyGraph(),
      mutation: {
        mode: "semantic_updates",
        batchSummary: "current measurement",
        ignoredSessions: [],
        updates: [{
          domain: "measurements",
          path: ["user", "audience", "subscriber_count"],
          memoryType: "measurement",
          updateMode: "record_observation",
          value: 350,
          effectiveAt: "2025-02-01",
          unit: "subscribers",
          sources: [currentSource],
          reason: "direct current measurement",
        }],
      },
      batchId: "b0001",
      sessions: [{ session_id: "s1", date: "2025/02/01", turns: [{}] }],
      allowReplacement: false,
    });
    const baselineSource = source("s2", "b0002");
    baselineSource.sessionDate = "2025/02/10";
    const withBaseline = applyContextoMutation({
      graph: current.graph,
      mutation: {
        mode: "semantic_updates",
        batchSummary: "historical baseline",
        ignoredSessions: [],
        updates: [{
          domain: "measurements",
          path: ["user", "audience", "subscriber_count"],
          memoryType: "measurement",
          updateMode: "record_observation",
          value: 250,
          effectiveAt: "2025-01-01",
          unit: "subscribers",
          sources: [baselineSource],
          reason: "later-reported older baseline",
        }],
      },
      batchId: "b0002",
      sessions: [{ session_id: "s2", date: "2025/02/10", turns: [{}] }],
      allowReplacement: false,
    });
    const measurements = withBaseline.graph.context.measurements as Record<string, unknown>;
    const user = measurements.user as Record<string, unknown>;
    const audience = user.audience as Record<string, unknown>;
    const cell = audience.subscriber_count as Record<string, unknown>;
    expect((cell.current as Record<string, unknown>).value).toBe(350);
    expect(Object.values(cell.history as Record<string, Record<string, unknown>>)[0]?.value).toBe(250);
  });

  test("reconciles a historical measurement suffix onto an existing measurement cell", () => {
    const first = applyContextoMutation({
      graph: emptyGraph(),
      mutation: {
        mode: "semantic_updates",
        batchSummary: "current count",
        ignoredSessions: [],
        updates: [{
          domain: "measurements",
          path: ["user", "audience", "follower_count"],
          memoryType: "measurement",
          updateMode: "record_observation",
          value: 350,
          effectiveAt: "2025-02-01",
          unit: "followers",
          sources: [source()],
          reason: "current count",
        }],
      },
      batchId: "b0001",
      sessions,
      allowReplacement: false,
    });
    const historicalSource = source("s2", "b0002");
    historicalSource.sessionDate = "2025/02/10";
    const reconciled = applyContextoMutation({
      graph: first.graph,
      mutation: {
        mode: "semantic_updates",
        batchSummary: "older baseline",
        ignoredSessions: [],
        updates: [{
          domain: "measurements",
          path: ["user", "audience", "follower_count", "start_of_year_count"],
          memoryType: "measurement",
          updateMode: "record_observation",
          value: 250,
          effectiveAt: "2025-01-01",
          unit: "followers",
          sources: [historicalSource],
          reason: "historical baseline",
        }],
      },
      batchId: "b0002",
      sessions: [{ session_id: "s2", date: "2025/02/10", turns: [{}] }],
      allowReplacement: false,
    });
    const measurements = reconciled.graph.context.measurements as Record<string, unknown>;
    const user = measurements.user as Record<string, unknown>;
    const audience = user.audience as Record<string, unknown>;
    const cell = audience.follower_count as Record<string, unknown>;
    expect((cell.current as Record<string, unknown>).value).toBe(350);
    expect(Object.values(cell.history as Record<string, Record<string, unknown>>)[0]?.value).toBe(250);
  });

  test("applies a valid patch with provenance and replays the same graph hash", () => {
    const mutation = {
      mode: "patch" as const,
      explanation: "record the stated home",
      operations: [{ op: "add" as const, path: "/context/jason", value: { lives_in: "Pune" }, sources: [source()], reason: "direct" }],
    };
    const applied = applyContextoMutation({ graph: emptyGraph(), mutation, batchId: "b0001", sessions, allowReplacement: true });
    expect(applied.graph.context).toEqual({ jason: { lives_in: "Pune" } });
    expect(applied.graph.provenanceByPointer["/context/jason/lives_in"]).toHaveLength(1);
    const record: GraphMutationRecord = {
      batchId: "b0001", sessionIds: ["s1"], mode: "patch", explanation: mutation.explanation,
      accepted: true, diffs: applied.diffs, graphRevisionBefore: 0, graphRevisionAfter: 1,
      graphHash: graphHash(applied.graph), mutation,
    };
    expect(graphHash(replayMutationRecords([record]))).toBe(record.graphHash);
  });

  test.each(["__proto__", "constructor", "Not_Snake", "$secret"])("rejects dangerous key %s atomically", (key) => {
    const original = emptyGraph();
    expect(() => applyContextoMutation({
      graph: original,
      mutation: { mode: "patch", explanation: "unsafe", operations: [{ op: "add", path: `/context/${key}`, value: "x", sources: [source()], reason: "test" }] },
      batchId: "b0001", sessions, allowReplacement: true,
    })).toThrow();
    expect(original).toEqual(emptyGraph());
  });

  test("rejects unresolved references and whole replacements without migration coverage", () => {
    expect(() => applyContextoMutation({
      graph: emptyGraph(),
      mutation: { mode: "patch", explanation: "bad ref", operations: [{ op: "add", path: "/context/person", value: { friend: { $ref: "/context/missing" } }, sources: [source()], reason: "test" }] },
      batchId: "b0001", sessions, allowReplacement: true,
    })).toThrow("unresolved");

    const existing: MasterContextGraph = { schemaVersion: 1, revision: 1, context: { person: { name: "Jason" } }, provenanceByPointer: { "/context/person/name": [source("s0", "b0000")] } };
    expect(() => applyContextoMutation({
      graph: existing,
      mutation: { mode: "replace_graph", explanation: "drops history", graph: { user: { name: "Jason" } }, provenance: [{ pointer: "/context/user/name", sources: [source()] }], migration: [] },
      batchId: "b0001", sessions, allowReplacement: true,
    })).toThrow("omits existing leaf");
  });

  test("accepts a mapped replacement only when prior provenance survives", () => {
    const oldSource = source("s0", "b0000");
    const existing: MasterContextGraph = {
      schemaVersion: 1,
      revision: 1,
      context: { person: { name: "Jason" } },
      provenanceByPointer: { "/context/person/name": [oldSource] },
    };
    const replacement = {
      mode: "replace_graph" as const,
      explanation: "move the person into a stable people branch",
      graph: { people: { jason: { name: "Jason" } } },
      migration: [
        {
          from: "/context/person/name",
          outcome: "moved" as const,
          to: "/context/people/jason/name",
          reason: "normalize the taxonomy",
          sources: [source()],
        },
      ],
      provenance: [
        {
          pointer: "/context/people/jason/name",
          sources: [oldSource, source()],
        },
      ],
    };

    const applied = applyContextoMutation({
      graph: existing,
      mutation: replacement,
      batchId: "b0001",
      sessions,
      allowReplacement: true,
    });
    expect(applied.graph.context).toEqual({ people: { jason: { name: "Jason" } } });
    expect(applied.graph.provenanceByPointer["/context/people/jason/name"]).toEqual([
      oldSource,
      source(),
    ]);

    const provenanceDroppingReplacement = {
      ...replacement,
      provenance: [{ pointer: "/context/people/jason/name", sources: [source()] }],
    };
    expect(() =>
      applyContextoMutation({
        graph: existing,
        mutation: provenanceDroppingReplacement,
        batchId: "b0001",
        sessions,
        allowReplacement: true,
      }),
    ).toThrow("loses provenance");
  });
});
