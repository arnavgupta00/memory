import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createAttempt,
  defaultProjectionMembership,
  materializeMapperPages,
  materializeRawTurn,
  resolveSourceAnchor,
  segmentRawTurn,
} from "../src/ingestion/structuredEventMaterializerV1.js";
import type {
  DraftSourceAnchor,
  MapperPageOutput,
  RawTurn,
} from "../src/ingestion/structuredEventSchemaV1.js";
import { canonicalJson, encodeModelJsonValue } from "../src/ingestion/structuredEventSchemaV1.js";
import { nextAdaptivePageSize, runAdaptivePageRounds } from "../src/ingestion/structuredEventWorkflowV1.js";

function raw(content: string, turnOrdinal = 0): RawTurn {
  return materializeRawTurn({
    archiveId: "fixture",
    hostConversationId: "conversation",
    hostSessionId: "session",
    hostTurnId: `turn-${String(turnOrdinal)}`,
    role: "user",
    rawTimestamp: "2026-08-10T00:00:00Z",
    sessionOrdinal: 0,
    turnOrdinal,
    content,
    transportArtifactSha256: "a".repeat(64),
  });
}

function anchor(turn: RawTurn, exactUtf8: string, prefixUtf8 = "", suffixUtf8 = ""): DraftSourceAnchor {
  return { rawTurnId: turn.rawTurnId, exactUtf8, prefixUtf8, suffixUtf8 };
}

function attempt(page: MapperPageOutput) {
  const inputContextManifest = { page: page.pageNumber };
  const rawProviderOutput = JSON.stringify(page);
  return createAttempt({
    runId: "fixture-run",
    targetId: page.targetSessionOpaqueId,
    pageNumber: page.pageNumber,
    inputContextManifest,
    inputContextManifestSha256: createHash("sha256").update(canonicalJson(inputContextManifest)).digest("hex"),
    parentAttemptIds: [],
    trigger: "mapper",
    model: "fixture",
    promptSha256: "c".repeat(64),
    schemaSha256: "d".repeat(64),
    rawProviderOutput,
    rawOutputSha256: createHash("sha256").update(rawProviderOutput).digest("hex"),
    parsedDrafts: page,
    diagnostics: [],
    warnings: [],
    finishReason: "completed",
    outputComplete: true,
    extractionConfidence: null,
  });
}

describe("structured event UTF-8 selectors and coverage", () => {
  it("keeps an attempt result stable when an unrelated page-level completion error is repaired", () => {
    const turn = raw("first\nsecond\n");
    const segments = segmentRawTurn(turn);
    const firstSegment = segments[0];
    const secondSegment = segments[1];
    if (!firstSegment || !secondSegment) throw new Error("fixture lost structural segments");
    const base = {
      targetSessionOpaqueId: "memory_000000000000010",
      pageCount: 2,
      mentions: [], records: [], assistantBlocks: [], resolutionAssertions: [],
    } as const;
    const firstPage: MapperPageOutput = {
      ...base, pageNumber: 1, expectedSegmentIds: [firstSegment.segmentId],
      coverageRows: [{
        segmentId: firstSegment.segmentId, routeType: "no_semantic_content", localRecordKeys: [],
        localBlockKeys: [], localObjectKeysExpectedInQuarantine: [], reason: "structural fixture",
      }],
    };
    const incompleteSecond: MapperPageOutput = {
      ...base, pageNumber: 2, expectedSegmentIds: [secondSegment.segmentId], coverageRows: [],
    };
    const completeSecond: MapperPageOutput = {
      ...incompleteSecond,
      coverageRows: [{
        segmentId: secondSegment.segmentId, routeType: "no_semantic_content", localRecordKeys: [],
        localBlockKeys: [], localObjectKeysExpectedInQuarantine: [], reason: "structural fixture",
      }],
    };
    const firstAttempt = attempt(firstPage);
    const incomplete = materializeMapperPages({
      rawTurns: [turn], expectedTargetOpaqueId: base.targetSessionOpaqueId,
      targetRawTurnIds: new Set([turn.rawTurnId]), expectedSegments: segments,
      pages: [firstPage, incompleteSecond],
      attemptsByPage: new Map([[1, firstAttempt], [2, attempt(incompleteSecond)]]),
    });
    const complete = materializeMapperPages({
      rawTurns: [turn], expectedTargetOpaqueId: base.targetSessionOpaqueId,
      targetRawTurnIds: new Set([turn.rawTurnId]), expectedSegments: segments,
      pages: [firstPage, completeSecond],
      attemptsByPage: new Map([[1, firstAttempt], [2, attempt(completeSecond)]]),
    });
    const before = incomplete.attemptResults.find((value) => value.attemptId === firstAttempt.attemptId);
    const after = complete.attemptResults.find((value) => value.attemptId === firstAttempt.attemptId);
    expect(before).toEqual(after);
  });

  it("accepts a unique exact quote despite wrong optional context", () => {
    const turn = raw("Before 🧪 café after");
    const result = resolveSourceAnchor(anchor(turn, "🧪 café", "wrong", "also wrong"), new Map([[turn.rawTurnId, turn]]));
    expect(result.selector?.exactUtf8).toBe("🧪 café");
    expect(result.selector?.byteStart).toBe(Buffer.byteLength("Before ", "utf8"));
    expect(result.issues).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });

  it("uses exact byte context only for repeated quotations", () => {
    const turn = raw("Alpha yes; Alpha no; Alpha maybe");
    const selected = resolveSourceAnchor(anchor(turn, "Alpha", "; ", " no"), new Map([[turn.rawTurnId, turn]]));
    const ambiguous = resolveSourceAnchor(anchor(turn, "Alpha"), new Map([[turn.rawTurnId, turn]]));
    const absent = resolveSourceAnchor(anchor(turn, "Beta"), new Map([[turn.rawTurnId, turn]]));
    expect(selected.selector?.byteStart).toBe(Buffer.byteLength("Alpha yes; ", "utf8"));
    expect(ambiguous.issues[0]?.code).toBe("unresolved_ambiguity");
    expect(absent.issues[0]?.code).toBe("quote_not_found");
  });

  it("accepts a repeated quote when one exact adjacent side identifies one occurrence", () => {
    const turn = raw("Alpha yes; Alpha no; Alpha maybe");
    const selected = resolveSourceAnchor(
      anchor(turn, "Alpha", "yes; ", " wrong"),
      new Map([[turn.rawTurnId, turn]]),
    );
    expect(selected.issues).toEqual([]);
    expect(selected.warnings[0]?.code).toBe("optional_context_mismatch");
    expect(selected.selector?.byteStart).toBe(Buffer.byteLength("Alpha yes; ", "utf8"));
  });

  it("uses the immutable page byte range to identify a repeated occurrence", () => {
    const turn = raw("Ashley first; Ashley second");
    const secondStart = Buffer.byteLength("Ashley first; ", "utf8");
    const selected = resolveSourceAnchor(
      anchor(turn, "Ashley"),
      new Map([[turn.rawTurnId, turn]]),
      [{ rawTurnId: turn.rawTurnId, byteStart: secondStart, byteEnd: Buffer.byteLength(turn.content, "utf8") }],
    );
    expect(selected.issues).toEqual([]);
    expect(selected.selector?.byteStart).toBe(secondStart);
  });

  it("binds a repeated mention to its immutable structural segment", () => {
    const turn = raw("Ashley first\nAshley second\n");
    const segments = segmentRawTurn(turn);
    const second = segments[1];
    if (!second) throw new Error("fixture lost second segment");
    const page: MapperPageOutput = {
      targetSessionOpaqueId: "memory_000000000000011",
      pageNumber: 1,
      pageCount: 1,
      expectedSegmentIds: segments.map((segment) => segment.segmentId),
      mentions: [{
        localMentionKey: "p1_second_ashley",
        mentionType: "person",
        anchor: anchor(turn, "Ashley"),
        sourceSegmentId: second.segmentId,
      }],
      records: [], assistantBlocks: [], resolutionAssertions: [],
      coverageRows: segments.map((segment) => ({
        segmentId: segment.segmentId,
        routeType: "no_semantic_content" as const,
        localRecordKeys: [], localBlockKeys: [], localObjectKeysExpectedInQuarantine: [],
        reason: "mention-only occurrence fixture",
      })),
    };
    const value = materializeMapperPages({
      rawTurns: [turn], expectedTargetOpaqueId: page.targetSessionOpaqueId,
      targetRawTurnIds: new Set([turn.rawTurnId]), expectedSegments: segments,
      pages: [page], attemptsByPage: new Map([[1, attempt(page)]]),
    });
    const mention = value.mentions[0];
    const selector = value.sourceSelectors.find((candidate) => candidate.selectorId === mention?.selectorId);
    expect(value.quarantines).toEqual([]);
    expect(selector?.byteStart).toBe(second.byteStart);
  });

  it("binds repeated record evidence through its coverage segment and exact bytes", () => {
    const turn = raw("I chose blue.\nI chose blue.\n");
    const segments = segmentRawTurn(turn);
    const second = segments[1];
    if (!second) throw new Error("fixture lost second segment");
    const claim = anchor(turn, "I chose blue.\n");
    const supportAnchor = {
      ...claim,
      rawTurnId: `rawturn_${"f".repeat(64)}`,
    };
    const requiredPaths = [
      "/recordKind", "/discourseContext/frame", "/discourseContext/commitment", "/predicate/surface",
      "/stance/sourceSpeakerRole", "/stance/speechAct", "/stance/polarity", "/stance/modalForce",
      "/stance/eventStatus", "/stance/adoption", "/stance/speakerCertainty",
    ];
    const page: MapperPageOutput = {
      targetSessionOpaqueId: "memory_000000000000012", pageNumber: 1, pageCount: 1,
      expectedSegmentIds: segments.map((segment) => segment.segmentId), mentions: [],
      records: [{
        localRecordKey: "p1_second_choice", recordKind: "decision",
        discourseContext: { frame: "actual_report", commitment: "asserted", parentScopeAnchor: null },
        predicate: { surface: "chose blue", normalized: null }, arguments: [],
        stance: {
          sourceSpeakerRole: "user", sourceSpeakerSurface: null, reportedSpeakerMentionKey: null,
          speechAct: "assertion", polarity: "positive", modalForce: "actual", eventStatus: "completed",
          adoption: "adopted", speakerCertainty: "certain",
        },
        validTimes: [{
          raw: "now", temporalType: "instant", sourcePrecision: "day", sourceCertainty: "certain",
          resolutionBasis: "source_explicit", normalizedStart: "2026-08-10", normalizedEnd: null,
          normalizedDuration: null, recurrence: null,
        }], claimAnchors: [claim],
        supportBindings: requiredPaths.filter((path) => path !== "/predicate/surface").map((path) => ({
          targetKind: "field" as const, targetPathOrMentionKey: path,
          purpose: "semantic_classification" as const, method: "fixture",
          evidenceAnchors: [path === "/recordKind" ? anchor(turn, "missing text") : supportAnchor],
          metadataEvidence: [], confidence: "high" as const,
        })),
        extractionConfidence: "high",
      }],
      assistantBlocks: [], resolutionAssertions: [],
      coverageRows: segments.map((segment, index) => ({
        segmentId: segment.segmentId,
        routeType: index === 1 ? "semantic" as const : "no_semantic_content" as const,
        localRecordKeys: index === 1 ? ["p1_second_choice"] : [],
        localBlockKeys: [], localObjectKeysExpectedInQuarantine: [], reason: "occurrence fixture",
      })),
    };
    const value = materializeMapperPages({
      rawTurns: [turn], expectedTargetOpaqueId: page.targetSessionOpaqueId,
      targetRawTurnIds: new Set([turn.rawTurnId]), expectedSegments: segments,
      pages: [page], attemptsByPage: new Map([[1, attempt(page)]]),
    });
    expect(value.complete).toBe(true);
    expect(value.records).toHaveLength(1);
    expect(value.sourceSelectors.find((selector) =>
      value.records[0]?.claimSelectorIds.includes(selector.selectorId))?.byteStart).toBe(second.byteStart);
    expect(value.warnings).toEqual(expect.arrayContaining([expect.objectContaining({
      detail: expect.stringContaining("unknown declared turn was replaced"),
    })]));
    expect(value.supportBindings).toEqual(expect.arrayContaining([expect.objectContaining({
      targetFieldPathOrMentionId: "/recordKind",
      method: "host-claim-fallback-v1:fixture",
    })]));
    expect(value.supportBindings).toEqual(expect.arrayContaining([expect.objectContaining({
      targetFieldPathOrMentionId: "/predicate/surface",
      method: "host-claim-provenance-v1",
    })]));
    expect(value.supportBindings).toEqual(expect.arrayContaining([expect.objectContaining({
      targetFieldPathOrMentionId: "/temporal/validTimes/0/temporalType",
      purpose: "temporal_type",
      method: "host-claim-provenance-v1",
    })]));
  });

  it("rejects invalid Unicode and preserves mixed newline/empty-turn structure", () => {
    expect(() => raw("broken\ud800value")).toThrow(/surrogate/);
    const turn = raw("a\r\nb\n");
    expect(segmentRawTurn(turn).map((value) => value.byteEnd - value.byteStart))
      .toEqual([3, 2]);
    expect(segmentRawTurn(raw("")).map((value) => [value.byteStart, value.byteEnd, value.segmentKind]))
      .toEqual([[0, 0, "blank"]]);
  });

  it("quarantines an entire multi-span record when one required span fails", () => {
    const first = raw("I paid 20 dollars", 0);
    const second = raw("for the blue plan", 1);
    const segments = [...segmentRawTurn(first), ...segmentRawTurn(second)];
    const good = anchor(first, "paid 20 dollars");
    const missing = anchor(second, "green plan");
    const requiredPaths = [
      "/recordKind", "/discourseContext/frame", "/discourseContext/commitment", "/predicate/surface",
      "/stance/sourceSpeakerRole", "/stance/speechAct", "/stance/polarity", "/stance/modalForce",
      "/stance/eventStatus", "/stance/adoption", "/stance/speakerCertainty",
      "/arguments/amount/role", "/arguments/amount/valueType", "/arguments/amount/surface",
    ];
    const page: MapperPageOutput = {
      targetSessionOpaqueId: "memory_000000000000001",
      pageNumber: 1,
      pageCount: 1,
      expectedSegmentIds: segments.map((value) => value.segmentId),
      mentions: [],
      records: [{
        localRecordKey: "p1_payment",
        recordKind: "measurement",
        discourseContext: { frame: "actual_report", commitment: "asserted", parentScopeAnchor: null },
        predicate: { surface: "paid", normalized: null },
        arguments: [{
          argumentKey: "amount", role: "value", customRole: null, groupKey: null,
          valueType: "money", surface: "20 dollars",
          sourceTypedValue: encodeModelJsonValue({ amount: 20, currency: "USD" }),
          mentionKey: null, recordRefLocalKey: null,
        }],
        stance: {
          sourceSpeakerRole: "user", sourceSpeakerSurface: null, reportedSpeakerMentionKey: null,
          speechAct: "assertion", polarity: "positive", modalForce: "actual", eventStatus: "completed",
          adoption: "not_applicable", speakerCertainty: "certain",
        },
        validTimes: [],
        claimAnchors: [good, missing],
        supportBindings: requiredPaths.map((path) => ({
          targetKind: "field" as const,
          targetPathOrMentionKey: path,
          purpose: "semantic_classification" as const,
          method: "fixture",
          evidenceAnchors: [good],
          metadataEvidence: [],
          confidence: "high" as const,
        })),
        extractionConfidence: "high",
      }],
      assistantBlocks: [],
      resolutionAssertions: [],
      coverageRows: segments.map((segment) => ({
        segmentId: segment.segmentId,
        routeType: "quarantine",
        localRecordKeys: [],
        localBlockKeys: [],
        localObjectKeysExpectedInQuarantine: ["p1_payment"],
        reason: "fixture expects atomic quarantine",
      })),
    };
    const callAttempt = attempt(page);
    const value = materializeMapperPages({
      rawTurns: [first, second],
      expectedTargetOpaqueId: page.targetSessionOpaqueId,
      targetRawTurnIds: new Set([first.rawTurnId, second.rawTurnId]),
      expectedSegments: segments,
      pages: [page],
      attemptsByPage: new Map([[1, callAttempt]]),
    });
    expect(value.records).toEqual([]);
    expect(value.quarantines).toHaveLength(1);
    expect(value.quarantines[0]?.resolvedSelectorIds).toHaveLength(1);
    expect(value.complete).toBe(false);
  });

  it("marks truncated, missing, and duplicate continuation pages incomplete", () => {
    const turn = raw("A factual segment.");
    const [segment] = segmentRawTurn(turn);
    if (!segment) throw new Error("missing segment");
    const page: MapperPageOutput = {
      targetSessionOpaqueId: "memory_000000000000003",
      pageNumber: 1,
      pageCount: 2,
      expectedSegmentIds: [segment.segmentId],
      mentions: [], records: [], assistantBlocks: [], resolutionAssertions: [],
      coverageRows: [{
        segmentId: segment.segmentId, routeType: "no_semantic_content", localRecordKeys: [], localBlockKeys: [],
        localObjectKeysExpectedInQuarantine: [], reason: "fixture",
      }],
    };
    const completedAttempt = attempt(page);
    const incomplete = materializeMapperPages({
      rawTurns: [turn], targetRawTurnIds: new Set([turn.rawTurnId]), expectedSegments: [segment],
      expectedTargetOpaqueId: page.targetSessionOpaqueId,
      pages: [page], attemptsByPage: new Map([[1, completedAttempt]]),
    });
    expect(incomplete.complete).toBe(false);
    expect(incomplete.completionErrors.join(" ")).toMatch(/pageCount|page numbers/);
    const duplicate = materializeMapperPages({
      rawTurns: [turn], targetRawTurnIds: new Set([turn.rawTurnId]), expectedSegments: [segment],
      expectedTargetOpaqueId: page.targetSessionOpaqueId,
      pages: [{ ...page, pageCount: 1 }, { ...page, pageCount: 1 }], attemptsByPage: new Map([[1, completedAttempt]]),
    });
    expect(duplicate.complete).toBe(false);
  });

  it("uses host-controlled adaptive page reduction without output truncation as a budget tool", () => {
    const sizes: number[] = [];
    let current: number | null = 12;
    while (current !== null) {
      sizes.push(current);
      current = nextAdaptivePageSize(current);
    }
    expect(sizes).toEqual([12, 6, 3, 1]);
  });

  it("re-pages the actual mapper round after an incomplete result", async () => {
    const calledSizes: number[] = [];
    const result = await runAdaptivePageRounds({
      initialPageSize: 6,
      buildPages: (pageSize) => [{ pageSize }],
      callRound: async (pages) => {
        const page = pages[0];
        if (!page) throw new Error("fixture page missing");
        calledSizes.push(page.pageSize);
        return [{ complete: page.pageSize <= 3 }];
      },
      isComplete: (value) => value.complete,
    });
    expect(calledSizes).toEqual([6, 3]);
    expect(result.pageSize).toBe(3);
    expect(result.rounds).toBe(2);
  });

  it("keeps an immutable base projection separate from a confirmed-resolution enrichment", () => {
    const turn = raw("Alice said she chose blue.");
    const segments = segmentRawTurn(turn);
    const claim = anchor(turn, "Alice said she chose blue.");
    const requiredPaths = [
      "/recordKind", "/discourseContext/frame", "/discourseContext/commitment", "/predicate/surface",
      "/stance/sourceSpeakerRole", "/stance/speechAct", "/stance/polarity", "/stance/modalForce",
      "/stance/eventStatus", "/stance/adoption", "/stance/speakerCertainty",
      "/arguments/chooser/role", "/arguments/chooser/valueType", "/arguments/chooser/surface",
      "/arguments/chooser/mentionId",
    ];
    const page: MapperPageOutput = {
      targetSessionOpaqueId: "memory_000000000000004",
      pageNumber: 1,
      pageCount: 1,
      expectedSegmentIds: segments.map((segment) => segment.segmentId),
      mentions: [{
        localMentionKey: "alice",
        mentionType: "person",
        anchor: anchor(turn, "Alice"),
        sourceSegmentId: null,
      }],
      records: [{
        localRecordKey: "choice",
        recordKind: "decision",
        discourseContext: { frame: "actual_report", commitment: "asserted", parentScopeAnchor: null },
        predicate: { surface: "chose", normalized: null },
        arguments: [{
          argumentKey: "chooser", role: "actor", customRole: null, groupKey: null,
          valueType: "entity_mention", surface: "she", sourceTypedValue: null,
          mentionKey: "alice", recordRefLocalKey: null,
        }],
        stance: {
          sourceSpeakerRole: "user", sourceSpeakerSurface: null, reportedSpeakerMentionKey: null,
          speechAct: "report", polarity: "positive", modalForce: "actual", eventStatus: "completed",
          adoption: "not_applicable", speakerCertainty: "certain",
        },
        validTimes: [],
        claimAnchors: [claim],
        supportBindings: requiredPaths.filter((path) => !path.endsWith("/mentionId")).map((path) => ({
          targetKind: "field" as const,
          targetPathOrMentionKey: path,
          purpose: "semantic_classification" as const,
          method: "fixture",
          evidenceAnchors: [claim],
          metadataEvidence: [],
          confidence: "high" as const,
        })),
        extractionConfidence: "high",
      }],
      assistantBlocks: [],
      resolutionAssertions: [{
        localResolutionKey: "alice_coreference",
        targetRecordLocalKey: "choice",
        targetKind: "field",
        targetPathOrMentionKey: "/arguments/chooser/surface",
        kind: "coreference",
        proposedValue: encodeModelJsonValue("Alice"),
        evidenceAnchors: [anchor(turn, "Alice")],
        metadataEvidence: [],
        method: "fixture coreference",
        confidence: "high",
        status: "confirmed",
      }, {
        localResolutionKey: "alice_identity",
        targetRecordLocalKey: "choice",
        targetKind: "mention",
        targetPathOrMentionKey: "alice",
        kind: "identity",
        proposedValue: encodeModelJsonValue("Alice"),
        evidenceAnchors: [anchor(turn, "Alice")],
        metadataEvidence: [],
        method: "fixture identity",
        confidence: "high",
        status: "confirmed",
      }],
      coverageRows: segments.map((segment) => ({
        segmentId: segment.segmentId,
        routeType: "semantic",
        localRecordKeys: ["choice"],
        localBlockKeys: [],
        localObjectKeysExpectedInQuarantine: [],
        reason: "record preserves the reported choice",
      })),
    };
    const value = materializeMapperPages({
      rawTurns: [turn],
      expectedTargetOpaqueId: page.targetSessionOpaqueId,
      targetRawTurnIds: new Set([turn.rawTurnId]),
      expectedSegments: segments,
      pages: [page],
      attemptsByPage: new Map([[1, attempt(page)]]),
    });
    expect(value.complete).toBe(true);
    expect(value.supportBindings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        targetFieldPathOrMentionId: "/arguments/chooser/mentionId",
        method: "host-bound-mention-link-v1",
      }),
    ]));
    expect(value.semanticProjections.map((projection) => projection.projectionKind).sort()).toEqual(["base", "enriched"]);
    const base = value.semanticProjections.find((projection) => projection.projectionKind === "base");
    const enriched = value.semanticProjections.find((projection) => projection.projectionKind === "enriched");
    expect(base?.canonicalText).not.toContain("confirmed_resolutions");
    expect(base?.canonicalText).not.toMatch(/(?:mention|selector|record)_[a-f0-9]{64}/);
    expect(base?.canonicalText).toContain("user");
    expect(base?.canonicalText.length).toBeLessThan(250);
    expect(enriched?.baseProjectionId).toBe(base?.projectionId);
    expect(enriched?.canonicalText).toContain("Alice");
    expect(enriched?.canonicalText).not.toMatch(/(?:mention|selector|record)_[a-f0-9]{64}/);
    const membership = defaultProjectionMembership({
      records: value.records,
      projections: value.semanticProjections,
      lifecycleEvents: value.lifecycleEvents,
    });
    expect(membership).toEqual([expect.objectContaining({ projectionId: enriched?.projectionId, projectionKind: "enriched" })]);

    const collisionPage = structuredClone(page);
    const collisionMention = collisionPage.mentions[0];
    const collisionRecord = collisionPage.records[0];
    if (!collisionMention || !collisionRecord) throw new Error("fixture lost its collision objects");
    collisionMention.localMentionKey = collisionRecord.localRecordKey;
    collisionRecord.arguments[0] = {
      ...collisionRecord.arguments[0]!,
      mentionKey: collisionRecord.localRecordKey,
    };
    const mentionResolution = collisionPage.resolutionAssertions.find((resolution) => resolution.targetKind === "mention");
    if (!mentionResolution) throw new Error("fixture lost its mention resolution");
    mentionResolution.targetPathOrMentionKey = collisionRecord.localRecordKey;
    const collision = materializeMapperPages({
      rawTurns: [turn],
      expectedTargetOpaqueId: collisionPage.targetSessionOpaqueId,
      targetRawTurnIds: new Set([turn.rawTurnId]),
      expectedSegments: segments,
      pages: [collisionPage],
      attemptsByPage: new Map([[1, attempt(collisionPage)]]),
    });
    expect(collision.complete).toBe(false);
    expect(collision.completionErrors).toEqual(expect.arrayContaining([
      expect.stringContaining("cross-type proposal keys are ambiguous"),
    ]));
    expect(collision.attemptResults).toEqual([expect.objectContaining({ status: "incomplete" })]);

    const leakingPage = structuredClone(page);
    const leakingRecord = leakingPage.records[0];
    if (!leakingRecord) throw new Error("fixture lost its record");
    leakingRecord.predicate.surface = turn.rawTurnId;
    const leaking = materializeMapperPages({
      rawTurns: [turn],
      expectedTargetOpaqueId: page.targetSessionOpaqueId,
      targetRawTurnIds: new Set([turn.rawTurnId]),
      expectedSegments: segments,
      pages: [leakingPage],
      attemptsByPage: new Map([[1, attempt(leakingPage)]]),
    });
    expect(leaking.records).toEqual([]);
    expect(leaking.quarantines.some((quarantine) =>
      quarantine.issues.some((entry) => entry.detail.includes("internal identifier")))).toBe(true);

    const identifierTurn = raw("memory_123456 said she chose blue.", 8);
    const identifierSegments = segmentRawTurn(identifierTurn);
    const identifierClaim = anchor(identifierTurn, "memory_123456 said she chose blue.");
    const identifierPage = structuredClone(page);
    identifierPage.expectedSegmentIds = identifierSegments.map((segment) => segment.segmentId);
    const identifierMention = identifierPage.mentions[0];
    const identifierRecord = identifierPage.records[0];
    if (!identifierMention || !identifierRecord) throw new Error("fixture lost its identifier objects");
    identifierMention.anchor = anchor(identifierTurn, "memory_123456");
    identifierRecord.claimAnchors = [identifierClaim];
    identifierRecord.supportBindings = identifierRecord.supportBindings.map((binding) => ({
      ...binding,
      evidenceAnchors: [identifierClaim],
    }));
    for (const resolution of identifierPage.resolutionAssertions) {
      resolution.evidenceAnchors = [anchor(identifierTurn, "memory_123456")];
    }
    identifierPage.coverageRows = identifierSegments.map((segment) => ({
      segmentId: segment.segmentId,
      routeType: "quarantine" as const,
      localRecordKeys: [],
      localBlockKeys: [],
      localObjectKeysExpectedInQuarantine: [identifierMention.localMentionKey, identifierRecord.localRecordKey],
      reason: "identifier-shaped source literal must remain in raw custody only",
    }));
    const identifierLiteral = materializeMapperPages({
      rawTurns: [identifierTurn],
      expectedTargetOpaqueId: identifierPage.targetSessionOpaqueId,
      targetRawTurnIds: new Set([identifierTurn.rawTurnId]),
      expectedSegments: identifierSegments,
      pages: [identifierPage],
      attemptsByPage: new Map([[1, attempt(identifierPage)]]),
    });
    expect(identifierLiteral.records).toEqual([]);
    expect(identifierLiteral.semanticProjections).toEqual([]);
    expect(identifierLiteral.quarantines.some((quarantine) =>
      quarantine.objectType === "mention"
      && quarantine.issues.some((entry) => entry.detail.includes("internal identifier")))).toBe(true);

    const preceding = raw("Alice was introduced in an earlier session.", 9);
    const crossSessionPage = structuredClone(page);
    const crossSessionRecord = crossSessionPage.records[0];
    const firstBinding = crossSessionRecord?.supportBindings[0];
    if (!crossSessionRecord || !firstBinding) throw new Error("fixture lost its record support binding");
    crossSessionRecord.supportBindings[0] = {
      ...firstBinding,
      evidenceAnchors: [anchor(preceding, "Alice")],
    };
    const crossSession = materializeMapperPages({
      rawTurns: [preceding, turn],
      expectedTargetOpaqueId: page.targetSessionOpaqueId,
      targetRawTurnIds: new Set([turn.rawTurnId]),
      expectedSegments: segments,
      pages: [crossSessionPage],
      attemptsByPage: new Map([[1, attempt(crossSessionPage)]]),
    });
    expect(crossSession.records).toEqual([]);
    expect(crossSession.quarantines.some((quarantine) =>
      quarantine.issues.some((entry) => entry.detail.includes("cross-session context")))).toBe(true);
  });
});
