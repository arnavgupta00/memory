import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  compactAssistantRoutingText,
  createAttempt,
  buildAssistantRawLexicalPostings,
  materializeMapperPages,
  materializeRawTurn,
  segmentRawTurn,
} from "../src/ingestion/structuredEventMaterializerV1.js";
import { canonicalJson, type JsonValue, type MapperPageOutput } from "../src/ingestion/structuredEventSchemaV1.js";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function materializeFact(
  role: "user" | "assistant",
  content: string,
  adoption: "adopted" | "not_applicable",
  commitment: "asserted" | "suggested" = "asserted",
) {
  const turn = materializeRawTurn({
    archiveId: "fixture", hostConversationId: "c", hostSessionId: "s", hostTurnId: `${role}-fact`,
    role, rawTimestamp: "2026-08-10T00:00:00Z", sessionOrdinal: 0, turnOrdinal: 0, content,
    transportArtifactSha256: "a".repeat(64),
  });
  const segments = segmentRawTurn(turn);
  const anchor = { rawTurnId: turn.rawTurnId, exactUtf8: content, prefixUtf8: "", suffixUtf8: "" };
  const requiredPaths = [
    "/recordKind", "/discourseContext/frame", "/discourseContext/commitment", "/predicate/surface",
    "/stance/sourceSpeakerRole", "/stance/speechAct", "/stance/polarity", "/stance/modalForce",
    "/stance/eventStatus", "/stance/adoption", "/stance/speakerCertainty",
  ];
  const page: MapperPageOutput = {
    targetSessionOpaqueId: "memory_000000000000005",
    pageNumber: 1,
    pageCount: 1,
    expectedSegmentIds: segments.map((value) => value.segmentId),
    mentions: [],
    records: [{
      localRecordKey: "fact",
      recordKind: adoption === "adopted" ? "decision" : "claim",
      discourseContext: { frame: "actual_report", commitment, parentScopeAnchor: null },
      predicate: { surface: content, normalized: null },
      arguments: [],
      stance: {
        sourceSpeakerRole: role, sourceSpeakerSurface: null, reportedSpeakerMentionKey: null,
        speechAct: commitment === "suggested" ? "recommendation" : role === "assistant" ? "report" : "assertion",
        polarity: "positive", modalForce: commitment === "suggested" ? "planned" : "actual",
        eventStatus: commitment === "suggested" ? "proposed" : "completed", adoption, speakerCertainty: "certain",
      },
      validTimes: [],
      claimAnchors: [anchor],
      supportBindings: requiredPaths.map((path) => ({
        targetKind: "field" as const,
        targetPathOrMentionKey: path,
        purpose: "semantic_classification" as const,
        method: "fixture",
        evidenceAnchors: [anchor],
        metadataEvidence: [],
        confidence: "high" as const,
      })),
      extractionConfidence: "high",
    }],
    assistantBlocks: [], resolutionAssertions: [],
    coverageRows: segments.map((segment) => ({
      segmentId: segment.segmentId, routeType: "semantic", localRecordKeys: ["fact"], localBlockKeys: [],
      localObjectKeysExpectedInQuarantine: [], reason: "concrete fact",
    })),
  };
  const rawOutput = JSON.stringify(page);
  const manifest = { page: 1 } satisfies JsonValue;
  const callAttempt = createAttempt({
    runId: "r", targetId: page.targetSessionOpaqueId, pageNumber: 1,
    inputContextManifest: manifest, inputContextManifestSha256: hash(canonicalJson(manifest)),
    parentAttemptIds: [], trigger: "mapper", model: "fixture", promptSha256: "b".repeat(64),
    schemaSha256: "c".repeat(64), rawProviderOutput: rawOutput, rawOutputSha256: hash(rawOutput),
    parsedDrafts: page, diagnostics: [], warnings: [], finishReason: "completed", outputComplete: true,
    extractionConfidence: null,
  });
  return materializeMapperPages({
    rawTurns: [turn], targetRawTurnIds: new Set([turn.rawTurnId]), expectedSegments: segments,
    expectedTargetOpaqueId: page.targetSessionOpaqueId,
    pages: [page], attemptsByPage: new Map([[1, callAttempt]]),
  });
}

describe("source-role routing", () => {
  it("caps conceptual assistant routes while raw lexical postings retain details", () => {
    expect(compactAssistantRoutingText("one two three four five six seven eight nine ten"))
      .toBe("one two three four five six seven eight");
  });

  it("reconstructs omitted coverage links from explicit assistant-block segments", () => {
    const content = "Plan\n- First step\n- Second step\n";
    const turn = materializeRawTurn({
      archiveId: "fixture", hostConversationId: "c", hostSessionId: "s", hostTurnId: "assistant-coverage",
      role: "assistant", rawTimestamp: null, sessionOrdinal: 0, turnOrdinal: 0, content,
      transportArtifactSha256: "a".repeat(64),
    });
    const segments = segmentRawTurn(turn);
    const page: MapperPageOutput = {
      targetSessionOpaqueId: "memory_000000000000013", pageNumber: 1, pageCount: 1,
      expectedSegmentIds: segments.map((segment) => segment.segmentId), mentions: [], records: [],
      resolutionAssertions: [],
      assistantBlocks: [{
        localBlockKey: "p1_plan", blockKind: "procedure",
        discourseContext: { frame: "template", commitment: "suggested", parentScopeAnchor: null },
        sourceAnchor: null, sourceSegmentIds: segments.map((segment) => segment.segmentId), items: [],
        supportBindings: [], routingText: "Plan with a first and second step", routingTerms: ["plan", "steps"],
      }],
      // The model supplied one redundant ledger row with the valid block key
      // in the wrong typed array and omitted the remaining rows. The immutable
      // object type and block-to-segment linkage are sufficient for lossless
      // host assembly of the exhaustive coverage ledger.
      coverageRows: [{
        segmentId: segments[0]?.segmentId ?? "", routeType: "assistant_block",
        localRecordKeys: ["p1_plan"], localBlockKeys: [], localObjectKeysExpectedInQuarantine: [], reason: "plan block",
      }],
    };
    const rawOutput = JSON.stringify(page);
    const manifest = { page: 1 } satisfies JsonValue;
    const callAttempt = createAttempt({
      runId: "r", targetId: page.targetSessionOpaqueId, pageNumber: 1,
      inputContextManifest: manifest, inputContextManifestSha256: hash(canonicalJson(manifest)),
      parentAttemptIds: [], trigger: "mapper", model: "fixture", promptSha256: "b".repeat(64),
      schemaSha256: "c".repeat(64), rawProviderOutput: rawOutput, rawOutputSha256: hash(rawOutput),
      parsedDrafts: page, diagnostics: [], warnings: [], finishReason: "completed", outputComplete: true,
      extractionConfidence: null,
    });
    const result = materializeMapperPages({
      rawTurns: [turn], targetRawTurnIds: new Set([turn.rawTurnId]), expectedSegments: segments,
      expectedTargetOpaqueId: page.targetSessionOpaqueId, pages: [page], attemptsByPage: new Map([[1, callAttempt]]),
    });
    expect(result.complete).toBe(true);
    expect(result.coverageRows).toHaveLength(segments.length);
    expect(result.assistantBlockProjections[0]?.routingTerms).toEqual([]);
    expect(result.coverageRows.every((row) => row.routeType === "assistant_block" && row.blockIds.length === 1))
      .toBe(true);
    expect(result.completionErrors).toEqual([]);
  });

  it("keeps a long assistant list compact while indexing raw vocabulary separately", () => {
    const content = Array.from({ length: 20 }, (_, index) =>
      `${String(index + 1)}. Option ${String(index + 1)}${index === 16 ? " contains zephyrium" : ""}`,
    ).join("\n");
    const turn = materializeRawTurn({
      archiveId: "fixture", hostConversationId: "c", hostSessionId: "s", hostTurnId: "assistant-0",
      role: "assistant", rawTimestamp: null, sessionOrdinal: 0, turnOrdinal: 0, content,
      transportArtifactSha256: "a".repeat(64),
    });
    const segments = segmentRawTurn(turn);
    const fullAnchor = { rawTurnId: turn.rawTurnId, exactUtf8: content, prefixUtf8: "", suffixUtf8: "" };
    const page: MapperPageOutput = {
      targetSessionOpaqueId: "memory_000000000000002",
      pageNumber: 1,
      pageCount: 1,
      expectedSegmentIds: segments.map((value) => value.segmentId),
      mentions: [], records: [], resolutionAssertions: [],
      assistantBlocks: [{
        localBlockKey: "p1_options",
        blockKind: "advice",
        discourseContext: { frame: "actual_report", commitment: "suggested", parentScopeAnchor: null },
        sourceAnchor: fullAnchor,
        sourceSegmentIds: [],
        items: [],
        supportBindings: [],
        routingText: "A numbered list of options",
        routingTerms: ["options"],
      }],
      coverageRows: segments.map((segment) => ({
        segmentId: segment.segmentId,
        routeType: "assistant_block",
        localRecordKeys: [],
        localBlockKeys: ["p1_options"],
        localObjectKeysExpectedInQuarantine: [],
        reason: "compact assistant advice block",
      })),
    };
    const rawOutput = JSON.stringify(page);
    const manifest = { page: 1 } satisfies JsonValue;
    const callAttempt = createAttempt({
      runId: "r", targetId: page.targetSessionOpaqueId, pageNumber: 1,
      inputContextManifest: manifest, inputContextManifestSha256: hash(canonicalJson(manifest)),
      parentAttemptIds: [], trigger: "mapper", model: "fixture", promptSha256: "b".repeat(64),
      schemaSha256: "c".repeat(64), rawProviderOutput: rawOutput, rawOutputSha256: hash(rawOutput),
      parsedDrafts: page, diagnostics: [], warnings: [], finishReason: "completed", outputComplete: true,
      extractionConfidence: null,
    });
    const result = materializeMapperPages({
      rawTurns: [turn], targetRawTurnIds: new Set([turn.rawTurnId]), expectedSegments: segments,
      expectedTargetOpaqueId: page.targetSessionOpaqueId,
      pages: [page], attemptsByPage: new Map([[1, callAttempt]]),
    });
    expect(result.assistantBlocks).toHaveLength(1);
    expect(result.records).toEqual([]);
    expect(result.assistantBlockItems).toHaveLength(20);
    expect(result.supportBindings.filter((binding) => binding.targetObjectType === "block"))
      .toEqual(expect.arrayContaining(Array.from({ length: 3 }, () => expect.objectContaining({
        method: "host-bound-block-source-v1",
      }))));
    expect(Object.values(result.assistantBlockProjections[0]?.itemRoutingTerms ?? {}).flat())
      .not.toContain("zephyrium");
    const rawPostings = buildAssistantRawLexicalPostings({
      blocks: result.assistantBlocks,
      items: result.assistantBlockItems,
      selectors: result.sourceSelectors,
    });
    expect(rawPostings.flatMap((posting) => posting.normalizedTerms)).toContain("zephyrium");
  });

  it("ignores model-recreated item boundaries and deterministically creates one item per list segment", () => {
    const content = "1. Repeat\n2. Repeat\n3. Final";
    const turn = materializeRawTurn({
      archiveId: "fixture", hostConversationId: "c", hostSessionId: "s", hostTurnId: "assistant-items",
      role: "assistant", rawTimestamp: null, sessionOrdinal: 0, turnOrdinal: 0, content,
      transportArtifactSha256: "a".repeat(64),
    });
    const segments = segmentRawTurn(turn);
    const page: MapperPageOutput = {
      targetSessionOpaqueId: "memory_000000000000006", pageNumber: 1, pageCount: 1,
      expectedSegmentIds: segments.map((segment) => segment.segmentId), mentions: [], records: [],
      resolutionAssertions: [],
      assistantBlocks: [{
        localBlockKey: "p1_repeated", blockKind: "advice",
        discourseContext: { frame: "actual_report", commitment: "suggested", parentScopeAnchor: null },
        // The host prefers immutable segment identity when the model
        // redundantly returns both route forms.
        sourceAnchor: { rawTurnId: turn.rawTurnId, exactUtf8: content, prefixUtf8: "", suffixUtf8: "" },
        // Deliberately malformed non-contiguous segment route. The valid exact
        // anchor must keep this lossless block usable.
        sourceSegmentIds: [segments[0]!.segmentId, segments.at(-1)!.segmentId],
        // Deliberately ambiguous and incomplete model-authored item data. Host
        // boundaries must replace it instead of quarantining the whole block.
        items: [{
          localItemKey: "p1_bad_item", ordinal: 99, heading: "Repeat",
          sourceAnchor: { rawTurnId: turn.rawTurnId, exactUtf8: "Repeat", prefixUtf8: "", suffixUtf8: "" },
          sourceSegmentId: null,
        }],
        supportBindings: [], routingText: "Repeated options followed by a final option", routingTerms: ["options"],
      }],
      coverageRows: segments.map((segment) => ({
        // Route labels are redundant and may contradict named objects. Host
        // assembly derives the accepted route from materialized IDs.
        segmentId: segment.segmentId, routeType: "no_semantic_content", localRecordKeys: [],
        localBlockKeys: ["p1_repeated"], localObjectKeysExpectedInQuarantine: [], reason: "one advice list",
      })),
    };
    const rawOutput = JSON.stringify(page);
    const manifest = { page: 1 } satisfies JsonValue;
    const callAttempt = createAttempt({
      runId: "r", targetId: page.targetSessionOpaqueId, pageNumber: 1,
      inputContextManifest: manifest, inputContextManifestSha256: hash(canonicalJson(manifest)),
      parentAttemptIds: [], trigger: "mapper", model: "fixture", promptSha256: "b".repeat(64),
      schemaSha256: "c".repeat(64), rawProviderOutput: rawOutput, rawOutputSha256: hash(rawOutput),
      parsedDrafts: page, diagnostics: [], warnings: [], finishReason: "completed", outputComplete: true,
      extractionConfidence: null,
    });
    const result = materializeMapperPages({
      rawTurns: [turn], targetRawTurnIds: new Set([turn.rawTurnId]), expectedSegments: segments,
      expectedTargetOpaqueId: page.targetSessionOpaqueId, pages: [page], attemptsByPage: new Map([[1, callAttempt]]),
    });
    expect(result.complete).toBe(true);
    expect(result.assistantBlockItems).toHaveLength(3);
    expect(result.quarantines).toEqual([]);
  });

  it("binds a repeated parent scope to the nearest occurrence before its block", () => {
    const content = "Header\n1. First\nHeader\n2. Second\n";
    const turn = materializeRawTurn({
      archiveId: "fixture", hostConversationId: "c", hostSessionId: "s", hostTurnId: "assistant-scope",
      role: "assistant", rawTimestamp: null, sessionOrdinal: 0, turnOrdinal: 0, content,
      transportArtifactSha256: "a".repeat(64),
    });
    const segments = segmentRawTurn(turn);
    const secondHeader = segments[2];
    const secondItem = segments[3];
    if (!secondHeader || !secondItem) throw new Error("fixture lost repeated scope segments");
    const page: MapperPageOutput = {
      targetSessionOpaqueId: "memory_000000000000013", pageNumber: 1, pageCount: 1,
      expectedSegmentIds: segments.map((segment) => segment.segmentId), mentions: [], records: [],
      resolutionAssertions: [],
      assistantBlocks: [{
        localBlockKey: "p1_second", blockKind: "advice",
        discourseContext: {
          frame: "actual_report", commitment: "suggested",
          parentScopeAnchor: { rawTurnId: turn.rawTurnId, exactUtf8: "Header\n", prefixUtf8: "", suffixUtf8: "" },
        },
        sourceAnchor: null, sourceSegmentIds: [secondItem.segmentId], items: [], supportBindings: [],
        routingText: "Second item", routingTerms: ["Second"],
      }],
      coverageRows: segments.map((segment) => ({
        segmentId: segment.segmentId,
        routeType: segment.segmentId === secondItem.segmentId ? "assistant_block" as const : "no_semantic_content" as const,
        localRecordKeys: [], localBlockKeys: segment.segmentId === secondItem.segmentId ? ["p1_second"] : [],
        localObjectKeysExpectedInQuarantine: [], reason: "scope fixture",
      })),
    };
    const rawOutput = JSON.stringify(page);
    const manifest = { page: 1 } satisfies JsonValue;
    const callAttempt = createAttempt({
      runId: "r", targetId: page.targetSessionOpaqueId, pageNumber: 1,
      inputContextManifest: manifest, inputContextManifestSha256: hash(canonicalJson(manifest)),
      parentAttemptIds: [], trigger: "mapper", model: "fixture", promptSha256: "b".repeat(64),
      schemaSha256: "c".repeat(64), rawProviderOutput: rawOutput, rawOutputSha256: hash(rawOutput),
      parsedDrafts: page, diagnostics: [], warnings: [], finishReason: "completed", outputComplete: true,
      extractionConfidence: null,
    });
    const result = materializeMapperPages({
      rawTurns: [turn], targetRawTurnIds: new Set([turn.rawTurnId]), expectedSegments: segments,
      expectedTargetOpaqueId: page.targetSessionOpaqueId, pages: [page], attemptsByPage: new Map([[1, callAttempt]]),
    });
    const parentId = result.assistantBlocks[0]?.discourseContext.parentScopeSelectorId;
    expect(result.complete).toBe(true);
    expect(result.sourceSelectors.find((selector) => selector.selectorId === parentId)?.byteStart)
      .toBe(secondHeader.byteStart);
  });

  it("keeps a rejected USER-as-ASSISTANT proposal localized as one quarantine", () => {
    const content = "1. I chose blue\n2. I chose green";
    const turn = materializeRawTurn({
      archiveId: "fixture", hostConversationId: "c", hostSessionId: "s", hostTurnId: "user-list",
      role: "user", rawTimestamp: null, sessionOrdinal: 0, turnOrdinal: 0, content,
      transportArtifactSha256: "a".repeat(64),
    });
    const segments = segmentRawTurn(turn);
    const page: MapperPageOutput = {
      targetSessionOpaqueId: "memory_000000000000007", pageNumber: 1, pageCount: 1,
      expectedSegmentIds: segments.map((segment) => segment.segmentId), mentions: [], records: [],
      resolutionAssertions: [],
      assistantBlocks: [{
        localBlockKey: "p1_wrong_role", blockKind: "generated_content",
        discourseContext: { frame: "actual_report", commitment: "asserted", parentScopeAnchor: null },
        sourceAnchor: null, sourceSegmentIds: segments.map((segment) => segment.segmentId), items: [],
        supportBindings: [], routingText: "Incorrectly routed user choices", routingTerms: ["choices"],
      }],
      coverageRows: segments.map((segment) => ({
        segmentId: segment.segmentId, routeType: "assistant_block", localRecordKeys: [],
        localBlockKeys: ["p1_wrong_role"], localObjectKeysExpectedInQuarantine: [], reason: "bad model route",
      })),
    };
    const rawOutput = JSON.stringify(page);
    const manifest = { page: 1 } satisfies JsonValue;
    const callAttempt = createAttempt({
      runId: "r", targetId: page.targetSessionOpaqueId, pageNumber: 1,
      inputContextManifest: manifest, inputContextManifestSha256: hash(canonicalJson(manifest)),
      parentAttemptIds: [], trigger: "mapper", model: "fixture", promptSha256: "b".repeat(64),
      schemaSha256: "c".repeat(64), rawProviderOutput: rawOutput, rawOutputSha256: hash(rawOutput),
      parsedDrafts: page, diagnostics: [], warnings: [], finishReason: "completed", outputComplete: true,
      extractionConfidence: null,
    });
    const result = materializeMapperPages({
      rawTurns: [turn], targetRawTurnIds: new Set([turn.rawTurnId]), expectedSegments: segments,
      expectedTargetOpaqueId: page.targetSessionOpaqueId, pages: [page], attemptsByPage: new Map([[1, callAttempt]]),
    });
    expect(result.quarantines).toHaveLength(1);
    expect(result.coverageRows.every((row) => row.routeType === "quarantine")).toBe(true);
    expect(result.completionErrors).toEqual(["quarantine backlog is non-empty"]);
  });

  it("predeclares USER semantic routing and prevents advice atomization in the mapper contract", () => {
    const prompt = readFileSync(resolve(process.cwd(), "prompts/beam-structured-event-map-v1.yaml"), "utf8");
    expect(prompt).toContain("Route concrete USER facts");
    expect(prompt).toContain("Do not create one episodic record per advice-list item");
    expect(prompt).toContain("sourceSpeakerRole");
  });

  it("preserves a concrete USER adoption as a semantic decision", () => {
    const result = materializeFact("user", "I adopted the blue plan.", "adopted");
    expect(result.complete).toBe(true);
    expect(result.records).toEqual([expect.objectContaining({
      recordKind: "decision",
      stance: expect.objectContaining({ sourceSpeakerRole: "user", adoption: "adopted" }),
    })]);
  });

  it("preserves a concrete ASSISTANT report as a semantic record", () => {
    const result = materializeFact("assistant", "The report states revenue reached twenty dollars.", "not_applicable");
    expect(result.complete).toBe(true);
    expect(result.records).toEqual([expect.objectContaining({
      recordKind: "claim",
      stance: expect.objectContaining({ sourceSpeakerRole: "assistant", speechAct: "report" }),
    })]);
  });

  it("quarantines ASSISTANT suggested content until it is repaired as a block", () => {
    const result = materializeFact(
      "assistant",
      "Create a playlist for the party.",
      "not_applicable",
      "suggested",
    );
    expect(result.records).toEqual([]);
    expect(result.quarantines).toEqual([expect.objectContaining({
      objectType: "record",
      issues: expect.arrayContaining([expect.objectContaining({
        detail: expect.stringContaining("must use an assistant block"),
      })]),
    })]);
  });
});
