import { describe, expect, it } from "vitest";

import {
  materializeRawTurn,
  resolveSourceAnchor,
} from "../src/ingestion/structuredEventMaterializerV1.js";
import {
  asciiIdSort,
  canonicalJson,
  contentAddress,
  type JsonValue,
} from "../src/ingestion/structuredEventSchemaV1.js";
import {
  assertAppendCompatible,
  opaqueSessionHandle,
} from "../src/ingestion/structuredEventWorkflowV1.js";

function turn(content: string, hostTurnId: string) {
  return materializeRawTurn({
    archiveId: "a", hostConversationId: "c", hostSessionId: "s", hostTurnId,
    role: "user", rawTimestamp: "2026-08-10", sessionOrdinal: 0, turnOrdinal: Number(hostTurnId.slice(1)),
    content, transportArtifactSha256: "a".repeat(64),
  });
}

describe("structured-event stable identity and append semantics", () => {
  it("canonicalizes object keys and ASCII-sorts identifier arrays", () => {
    expect(canonicalJson({ z: 1, a: "é" })).toBe(canonicalJson({ a: "é", z: 1 }));
    expect(asciiIdSort(["record_b", "record_A", "record_a"])).toEqual(["record_A", "record_a", "record_b"]);
    expect(contentAddress("fixture.v1", { a: 1 })).toBe(contentAddress("fixture.v1", { a: 1 }));
  });

  it("keeps earlier turn and selector IDs byte-identical after append", () => {
    const first = turn("Alpha paid 10", "t0");
    const firstSelector = resolveSourceAnchor({
      rawTurnId: first.rawTurnId, exactUtf8: "paid 10", prefixUtf8: "", suffixUtf8: "",
    }, new Map([[first.rawTurnId, first]])).selector;
    const appended = turn("Beta paid 20", "t1");
    assertAppendCompatible([first], [first, appended]);
    const again = resolveSourceAnchor({
      rawTurnId: first.rawTurnId, exactUtf8: "paid 10", prefixUtf8: "", suffixUtf8: "",
    }, new Map([[first.rawTurnId, first], [appended.rawTurnId, appended]])).selector;
    expect(again).toEqual(firstSelector);
  });

  it("rejects a reused immutable host-turn key with different bytes", () => {
    expect(() => assertAppendCompatible([turn("first", "t0")], [turn("changed", "t0")]))
      .toThrow(/version conflict/);
  });

  it("uses stable keyed opaque handles independent of collection order", () => {
    const key = Buffer.alloc(32, 7);
    const a = opaqueSessionHandle("host-session-a", key);
    const b = opaqueSessionHandle("host-session-b", key);
    expect(opaqueSessionHandle("host-session-a", key)).toBe(a);
    expect(a).not.toBe(b);
    expect([b, a].reverse()).toEqual([a, b]);
  });

  it("preserves exact Unicode in identity payloads", () => {
    const left: JsonValue = { value: "e\u0301" };
    const right: JsonValue = { value: "é" };
    expect(contentAddress("unicode.v1", left)).not.toBe(contentAddress("unicode.v1", right));
  });
});
