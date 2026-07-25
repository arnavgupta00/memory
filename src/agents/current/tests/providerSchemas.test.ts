import { zodTextFormat } from "openai/helpers/zod";
import { describe, expect, test } from "vitest";
import { z } from "zod";

import { decodeContextoMutation, decodeJsonTreeObject } from "../src/services/contextoWire.js";
import { applyContextoMutation, semanticMemoryCatalog } from "../src/services/graphMutations.js";
import { personalSignalIndex } from "../src/services/personalSignals.js";
import {
  ContextoWireResponseSchema,
  ContextoSemanticWireResponseSchema,
  FinalAnswerSchema,
  ReaderPlanSchema,
  ShinoOutputSchema,
  type JsonTreeObject,
  type MasterContextGraph,
} from "../src/types.js";

function requireClosedObjects(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(requireClosedObjects);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.type === "object") expect(record.additionalProperties).toBe(false);
  Object.values(record).forEach(requireClosedObjects);
}

describe("provider JSON Schemas", () => {
  test("all four roles compile for OpenAI strict Structured Outputs and Gemini JSON Schema", () => {
    const schemas = {
      contexto: ContextoSemanticWireResponseSchema,
      shino: ShinoOutputSchema,
      reader: ReaderPlanSchema,
      answer: FinalAnswerSchema,
    };
    for (const [name, schema] of Object.entries(schemas)) {
      const openai = zodTextFormat(schema, name).schema;
      expect(openai.type).toBe("object");
      requireClosedObjects(openai);
      expect(() => z.toJSONSchema(schema)).not.toThrow();
    }
  });

  test("decodes the provider-safe tagged tree into the exact dynamic Contexto mutation", () => {
    const wire = ContextoWireResponseSchema.parse({
      mutation: {
        mode: "patch",
        explanation: "fixture",
        operations: [{
          op: "add",
          path: "/context/jason",
          value: { kind: "object", entries: [{ key: "home", value: { kind: "string", value: "Pune" } }] },
          sources: [{ sessionId: "s1", turnIndex: 0, sessionDate: "2025/01/01", batchId: "b0001", excerpt: null }],
          reason: "direct",
        }],
      },
    });
    expect(decodeContextoMutation(wire.mutation)).toMatchObject({
      operations: [{ value: { home: "Pune" } }],
    });
  });

  test("rejects duplicate dynamic keys during deterministic decoding", () => {
    const duplicate: JsonTreeObject = {
      kind: "object",
      entries: [
        { key: "home", value: { kind: "string", value: "Pune" } },
        { key: "home", value: { kind: "string", value: "Delhi" } },
      ],
    };
    expect(() => decodeJsonTreeObject(duplicate)).toThrow("duplicate key");
  });

  test("resolves an exact evidence quote and corrects a mistaken batch-local session index", () => {
    const sessions = [
      { session_id: "s1", date: "2025/01/01", turns: [{ role: "user" as const, content: "How does solar power work?" }] },
      {
        session_id: "s2",
        date: "2025/01/02",
        turns: [
          { role: "assistant" as const, content: "Great." },
          { role: "user" as const, content: "I completed my data science diploma." },
        ],
      },
    ];
    const signalId = personalSignalIndex(sessions).requiredHighPrioritySignals[0]?.signalId;
    if (!signalId) throw new Error("fixture must produce a required signal");
    const wire = ContextoSemanticWireResponseSchema.parse({
      mutation: {
        mode: "semantic_updates",
        batchSummary: "one durable fact",
        requiredSignalResolutions: [{
          signalId,
          disposition: "materialized",
          updates: [{
            domain: "people",
            path: ["user", "education", "diploma"],
            memoryType: "fact",
            updateMode: "set",
            value: { kind: "string", value: "data science" },
            effectiveAt: null,
            unit: null,
            sources: [{ sessionSlot: "session_1", turnSlot: "turn_1", evidenceQuote: "\"completed my data science diploma\"" }],
            reason: "direct user statement",
          }],
          existingPath: null,
          rationale: "direct completed education fact",
        }],
        additionalUpdates: [],
        sessionAudits: [
          { sessionSlot: "session_1", disposition: "generic_knowledge", rationale: "generic question" },
          { sessionSlot: "session_2", disposition: "extract_personal_memory", rationale: "direct user fact" },
        ],
      },
    });
    const mutation = decodeContextoMutation(wire.mutation, { batchId: "b0001", sessions });
    expect(mutation.mode).toBe("semantic_updates");
    if (mutation.mode !== "semantic_updates") throw new Error("expected semantic mutation");
    expect(mutation.updates[0]?.sources[0]).toMatchObject({ sessionId: "s2", turnIndex: 1 });
    expect(mutation.updates[0]?.sourceWarnings?.[0]).toContain("location corrected");
  });

  test("normalizes escaped quotes without weakening exact evidence resolution", () => {
    const wire = ContextoSemanticWireResponseSchema.parse({
      mutation: {
        mode: "semantic_updates",
        batchSummary: "podcast preference",
        requiredSignalResolutions: [],
        additionalUpdates: [{
          domain: "preferences",
          path: ["user", "podcasts", "interests"],
          memoryType: "preference",
          updateMode: "append",
          value: { kind: "string", value: "The Tim Ferriss Show" },
          effectiveAt: null,
          unit: null,
          sources: [{
            sessionSlot: "session_1",
            turnSlot: "turn_1",
            evidenceQuote: "I'm interested in \\\"The Tim Ferriss Show\\\" and listen every week.",
          }],
          reason: "direct user statement",
        }],
        sessionAudits: [{ sessionSlot: "session_1", disposition: "extract_personal_memory", rationale: "direct preference" }],
      },
    });
    const mutation = decodeContextoMutation(wire.mutation, {
      batchId: "b0001",
      sessions: [{
        session_id: "s1",
        date: "2025/01/01",
        turns: [{ role: "user", content: "I'm interested in \"The Tim Ferriss Show\" and listen every week." }],
      }],
    });
    if (mutation.mode !== "semantic_updates") throw new Error("expected semantic mutation");
    expect(mutation.updates[0]?.sources[0]).toMatchObject({ sessionId: "s1", turnIndex: 0 });
    expect(mutation.updates[0]?.sourceWarnings).toBeUndefined();
  });

  test("uses a high-confidence same-session fuzzy match and rejects ambiguous paraphrases", () => {
    const makeWire = (evidenceQuote: string) => ContextoSemanticWireResponseSchema.parse({
      mutation: {
        mode: "semantic_updates",
        batchSummary: "one durable fact",
        requiredSignalResolutions: [],
        additionalUpdates: [{
          domain: "plans",
          path: ["user", "business", "next_step"],
          memoryType: "plan",
          updateMode: "set",
          value: { kind: "string", value: "schedule a meeting with the bank" },
          effectiveAt: null,
          unit: null,
          sources: [{ sessionSlot: "session_1", turnSlot: "turn_1", evidenceQuote }],
          reason: "direct user plan",
        }],
        sessionAudits: [{ sessionSlot: "session_1", disposition: "extract_personal_memory", rationale: "direct plan" }],
      },
    });
    const sessions = [{
      session_id: "s1",
      date: "2025/01/01",
      turns: [
        { role: "user" as const, content: "I think I'll schedule a meeting with the bank sometime early next week." },
        { role: "assistant" as const, content: "You could also schedule a meeting with your business partner next week." },
      ],
    }];
    const fuzzy = decodeContextoMutation(
      makeWire("I think I will schedule a meeting with the bank sometime early next week").mutation,
      { batchId: "b0001", sessions },
    );
    if (fuzzy.mode !== "semantic_updates") throw new Error("expected semantic mutation");
    expect(fuzzy.updates[0]?.sources[0]).toMatchObject({ sessionId: "s1", turnIndex: 0 });
    expect(fuzzy.updates[0]?.sourceWarnings?.[0]).toContain("token coverage");

    const unresolved = decodeContextoMutation(
      makeWire("The user may possibly contact somebody later").mutation,
      { batchId: "b0001", sessions },
    );
    if (unresolved.mode !== "semantic_updates") throw new Error("expected semantic mutation");
    expect(unresolved.updates[0]?.sources[0]).toMatchObject({ sessionId: "s1", turnIndex: 0, excerpt: null });
    expect(unresolved.updates[0]?.sourceWarnings?.[0]).toContain("retained for audit");
  });

  test("keeps required-signal updates structurally attached and validates their ordered IDs", () => {
    const sessions = [{
      session_id: "routine",
      date: "2025/01/02",
      turns: [{ role: "user" as const, content: "I now exercise three times per week." }],
    }];
    const signalId = personalSignalIndex(sessions).requiredHighPrioritySignals[0]?.signalId;
    if (!signalId) throw new Error("fixture must produce a required signal");
    const response = ContextoSemanticWireResponseSchema.parse({
      mutation: {
        mode: "semantic_updates",
        batchSummary: "updated exercise routine",
        requiredSignalResolutions: [{
          signalId,
          disposition: "materialized",
          updates: [{
            domain: "routines",
            path: ["user", "exercise", "weekly_frequency"],
            memoryType: "fact",
            updateMode: "set",
            value: { kind: "number", value: 3 },
            effectiveAt: null,
            unit: "times_per_week",
            sources: [{
              sessionSlot: "session_1",
              turnSlot: "turn_1",
              evidenceQuote: "I now exercise three times per week.",
            }],
            reason: "direct routine update",
          }],
          existingPath: null,
          rationale: "direct autobiographical frequency",
        }],
        additionalUpdates: [],
        sessionAudits: [{
          sessionSlot: "session_1",
          disposition: "extract_personal_memory",
          rationale: "direct routine",
        }],
      },
    });
    const decoded = decodeContextoMutation(response.mutation, { batchId: "b0001", sessions });
    if (decoded.mode !== "semantic_updates") throw new Error("expected semantic mutation");
    expect(decoded.updates.find((update) => update.domain === "routines")?.value).toBe(3);
    expect(decoded.updates.find((update) =>
      update.path.includes("frequency_1")
    )).toMatchObject({ value: 3, unit: "times_per_week" });

    const wrongId = structuredClone(response.mutation);
    const firstResolution = wrongId.requiredSignalResolutions[0];
    if (!firstResolution) throw new Error("fixture must contain a signal resolution");
    firstResolution.signalId = "signal_wrong";
    const ignored = decodeContextoMutation(wrongId, { batchId: "b0001", sessions });
    if (ignored.mode !== "semantic_updates") throw new Error("expected semantic mutation");
    expect(ignored.updates.filter((update) => update.domain === "routines")).toEqual([]);
    expect(ignored.updates).toHaveLength(1);
  });

  test("preserves a dated event deterministically after Contexto materializes its signal", () => {
    const sessions = [{
      session_id: "dated-event",
      date: "2025/02/10 (Mon) 10:00",
      turns: [{ role: "user" as const, content: "I took a pottery workshop yesterday." }],
    }];
    const signalId = personalSignalIndex(sessions).requiredHighPrioritySignals[0]?.signalId;
    if (!signalId) throw new Error("fixture must produce a required event signal");
    const response = ContextoSemanticWireResponseSchema.parse({
      mutation: {
        mode: "semantic_updates",
        batchSummary: "materialized a personal interest from a completed event",
        requiredSignalResolutions: [{
          signalId,
          disposition: "materialized",
          updates: [{
            domain: "preferences",
            path: ["user", "crafts", "pottery_interest"],
            memoryType: "preference",
            updateMode: "set",
            value: { kind: "boolean", value: true },
            effectiveAt: null,
            unit: null,
            sources: [{
              sessionSlot: "session_1",
              turnSlot: "turn_1",
              evidenceQuote: "I took a pottery workshop yesterday.",
            }],
            reason: "direct personal statement",
          }],
          existingPath: null,
          rationale: "genuine autobiographical completed event",
        }],
        additionalUpdates: [],
        sessionAudits: [{
          sessionSlot: "session_1",
          disposition: "extract_personal_memory",
          rationale: "direct event",
        }],
      },
    });
    const decoded = decodeContextoMutation(response.mutation, { batchId: "b0001", sessions });
    if (decoded.mode !== "semantic_updates") throw new Error("expected semantic mutation");
    const event = decoded.updates.find((update) => update.memoryType === "event");
    expect(event).toMatchObject({
      domain: "events",
      path: ["user", "autobiographical_events", signalId],
      effectiveAt: "2025-02-09",
      sources: [{ sessionId: "dated-event", turnIndex: 0 }],
    });

    const semanticEventResponse = structuredClone(response.mutation);
    const resolution = semanticEventResponse.requiredSignalResolutions[0];
    const update = resolution?.disposition === "materialized" ? resolution.updates[0] : undefined;
    if (!update) throw new Error("fixture must contain a materialized update");
    update.domain = "events";
    update.path = ["user", "workshops", "pottery"];
    update.memoryType = "event";
    const withSemanticEvent = decodeContextoMutation(
      semanticEventResponse,
      { batchId: "b0001", sessions },
    );
    if (withSemanticEvent.mode !== "semantic_updates") {
      throw new Error("expected semantic mutation");
    }
    expect(withSemanticEvent.updates.filter((item) => item.memoryType === "event")).toHaveLength(2);
    expect(withSemanticEvent.updates.find((item) =>
      item.path.includes("pottery")
    )?.effectiveAt).toBe("2025-02-09");
  });

  test("updates one unambiguous existing frequency facet when Contexto omits the signal", () => {
    const graph: MasterContextGraph = {
      schemaVersion: 1,
      revision: 1,
      context: {
        routines: {
          user: {
            yoga_frequency: {
              memory_type: "fact",
              current: {
                value: "twice per week",
                observed_at: "2025/01/01",
                effective_at: null,
                unit: "times_per_week",
              },
              history: {},
            },
          },
        },
      },
      provenanceByPointer: {},
    };
    const sessions = [{
      session_id: "frequency",
      date: "2025/02/01",
      turns: [{ role: "user" as const, content: "I now attend yoga three times a week." }],
    }];
    const response = ContextoSemanticWireResponseSchema.parse({
      mutation: {
        mode: "semantic_updates",
        batchSummary: "provider omitted the frequency resolution",
        requiredSignalResolutions: [],
        additionalUpdates: [],
        sessionAudits: [{
          sessionSlot: "session_1",
          disposition: "extract_personal_memory",
          rationale: "direct mutable routine",
        }],
      },
    });
    const decoded = decodeContextoMutation(
      response.mutation,
      { batchId: "b0002", sessions, graph },
    );
    if (decoded.mode !== "semantic_updates") throw new Error("expected semantic mutation");
    expect(decoded.updates.find((update) =>
      update.domain === "routines" && update.path.join("/") === "user/yoga_frequency"
    )).toMatchObject({
      domain: "routines",
      path: ["user", "yoga_frequency"],
      value: "three times per week",
      unit: "times_per_week",
    });
    const applied = applyContextoMutation({
      graph,
      mutation: decoded,
      batchId: "b0002",
      sessions,
      allowReplacement: false,
    });
    expect(
      semanticMemoryCatalog(applied.graph).find(
        (item) => item.path === "routines/user/yoga_frequency",
      ),
    ).toMatchObject({
      current: { value: "three times per week" },
      history_count: 1,
    });
  });

  test("retains normalized scalar operands when Contexto omits their resolutions", () => {
    const sessions = [{
      session_id: "duration",
      date: "2025/02/01",
      turns: [{
        role: "user" as const,
        content: "It took me two hours to travel from home last time.",
      }],
    }];
    const response = ContextoSemanticWireResponseSchema.parse({
      mutation: {
        mode: "semantic_updates",
        batchSummary: "provider omitted a duration signal",
        requiredSignalResolutions: [],
        additionalUpdates: [],
        sessionAudits: [{
          sessionSlot: "session_1",
          disposition: "extract_personal_memory",
          rationale: "direct duration",
        }],
      },
    });
    const decoded = decodeContextoMutation(
      response.mutation,
      { batchId: "b0001", sessions },
    );
    if (decoded.mode !== "semantic_updates") throw new Error("expected semantic mutation");
    expect(decoded.updates).toMatchObject([{
      domain: "measurements",
      path: [
        "user",
        "signal_operands",
        personalSignalIndex(sessions).requiredHighPrioritySignals[0]?.signalId,
        "duration_1",
      ],
      value: 2,
      unit: "hour",
      sources: [{ sessionId: "duration", turnIndex: 0 }],
    }]);
  });
});
