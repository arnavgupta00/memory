import { describe, expect, it } from "vitest";
import { z } from "zod";

import { assertOpenAiStructuredOutputSchemaCompatible } from "../src/compression/structuredCall.js";
import type { MapperMaterialization } from "../src/ingestion/structuredEventMaterializerV1.js";
import {
  crossTypeProposalKeyCollisions,
  createAttemptMaterializationResult,
} from "../src/ingestion/structuredEventMaterializerV1.js";
import { isTerminalProviderFailure } from "../src/ingestion/structuredEventWorkflowV1.js";
import {
  LinkerOutputSchema,
  MapperPagePatchOutputSchema,
  MapperPageOutputSchema,
  decodeModelJsonValue,
  encodeModelJsonValue,
  type Attempt,
  type DerivationOccurrence,
  type MapperPageOutput,
  type SupportBinding,
} from "../src/ingestion/structuredEventSchemaV1.js";
import {
  activePageAfterRepair,
  appendMissingAttemptResults,
  applyMapperPagePatch,
  bindMapperPageToHostManifest,
  finalizeAttemptResultAfterPostchecks,
  pagesNeedingCoverageRepair,
  relevantRepairPage,
  repairAffectedProposalRoots,
  repairedQuarantineLineageErrors,
  selectActiveAndHistoricalMaterializationArtifacts,
  targetedRepairPreservationErrors,
} from "../src/scripts/beamStructuredEventIngestionV1.js";

const parentAttemptId = `attempt_${"1".repeat(64)}`;
const repairAttemptId = `attempt_${"2".repeat(64)}`;
const neverMaterializedAttemptId = `attempt_${"3".repeat(64)}`;

describe("repair page activation", () => {
  it("fails fast on provider account errors but not transient rate limits", () => {
    expect(isTerminalProviderFailure("429 You have no credits remaining. Add credits to continue using the API.")).toBe(true);
    expect(isTerminalProviderFailure("insufficient_quota: check billing")).toBe(true);
    expect(isTerminalProviderFailure("401 invalid API key")).toBe(true);
    expect(isTerminalProviderFailure("429 rate limit exceeded; retry later")).toBe(false);
    expect(isTerminalProviderFailure(null)).toBe(false);
  });

  it("keeps the prior complete page when a repair call has no output", () => {
    const prior = { output: { pageNumber: 3 }, attempt: "prior" };
    const failedRepair = { output: null, attempt: "failed-repair" };
    expect(activePageAfterRepair(prior, failedRepair)).toBe(prior);
  });

  it("activates a completed repair output", () => {
    const prior = { output: { pageNumber: 3 }, attempt: "prior" };
    const repair = { output: { pageNumber: 3 }, attempt: "repair" };
    expect(activePageAfterRepair(prior, repair)).toBe(repair);
  });
});

function emptyPass(): MapperMaterialization {
  return {
    records: [], mentions: [], supportBindings: [], resolutionAssertions: [], semanticProjections: [],
    assistantBlocks: [], assistantBlockItems: [], assistantBlockProjections: [], sourceSelectors: [],
    metadataSelectors: [], quarantines: [], coverageRows: [], derivations: [], lifecycleEvents: [],
    attemptResults: [], warnings: [], complete: true, completionErrors: [],
  };
}

function support(idHex: string, method = "fixture"): SupportBinding {
  return {
    schemaVersion: 2,
    supportBindingId: `support_${idHex.repeat(64)}`,
    targetObjectType: "record",
    targetObjectId: `record_${"a".repeat(64)}`,
    targetFieldPathOrMentionId: "/predicate/surface",
    purpose: "semantic_classification",
    method,
    selectorIds: [`selector_${"b".repeat(64)}`],
    metadataSelectorIds: [],
    confidence: "high",
  };
}

function derivation(attemptId: string, binding: SupportBinding): DerivationOccurrence {
  return {
    schemaVersion: 2,
    derivationId: `derivation_${attemptId === parentAttemptId ? "4".repeat(64) : "5".repeat(64)}`,
    attemptId,
    objectType: "support_binding",
    objectId: binding.supportBindingId,
    proposalLocalKey: "fact:support:/predicate/surface",
    extractionConfidence: "high",
  };
}

describe("structured ingestion orchestration invariants", () => {
  it("selects only pages with missing or internally inconsistent coverage", () => {
    const page = (pageNumber: number, expectedSegmentIds: string[], returnedSegmentIds: string[]): MapperPageOutput => ({
      targetSessionOpaqueId: "memory_000000000000014", pageNumber, pageCount: 2,
      expectedSegmentIds, mentions: [], records: [], assistantBlocks: [], resolutionAssertions: [],
      coverageRows: returnedSegmentIds.map((segmentId) => ({
        segmentId, routeType: "no_semantic_content", localRecordKeys: [], localBlockKeys: [],
        localObjectKeysExpectedInQuarantine: [], reason: "fixture",
      })),
    });
    const first = page(1, ["segment-a", "segment-b"], ["segment-a"]);
    const second = page(2, ["segment-c"], ["segment-c"]);
    expect(pagesNeedingCoverageRepair({
      pages: [first, second], outputsByPage: new Map([[1, first], [2, second]]), completionErrors: [],
    })).toEqual([1]);
    expect(pagesNeedingCoverageRepair({
      pages: [first, second], outputsByPage: new Map([[1, page(1, ["segment-a", "segment-b"], ["segment-a", "segment-b"])], [2, second]]),
      completionErrors: ["segment segment-c route assistant_block does not match its materialized objects"],
    })).toEqual([2]);
  });

  it("preflights every ingestion model schema before any API dispatch", () => {
    expect(() => assertOpenAiStructuredOutputSchemaCompatible(
      MapperPageOutputSchema,
      "beam_structured_event_mapper_v1",
    )).not.toThrow();
    expect(() => assertOpenAiStructuredOutputSchemaCompatible(
      MapperPagePatchOutputSchema,
      "beam_structured_event_mapper_patch_v1",
    )).not.toThrow();
    expect(() => assertOpenAiStructuredOutputSchemaCompatible(
      LinkerOutputSchema,
      "beam_structured_event_linker_v1",
    )).not.toThrow();
    expect(() => assertOpenAiStructuredOutputSchemaCompatible(
      z.strictObject({ dynamic: z.record(z.string(), z.string()) }),
      "known_bad_dynamic_object",
    )).toThrow(/propertyNames/);
  });

  it("losslessly crosses the fixed-entry model JSON boundary", () => {
    const value = {
      amount: 600,
      currency: "USD",
      schedule: ["15:30", null, { recurring: false }],
    };
    expect(decodeModelJsonValue(encodeModelJsonValue(value))).toEqual(value);
    expect(() => decodeModelJsonValue({
      kind: "object",
      objectEntries: [
        { key: "duplicate", value: { kind: "number", numberValue: 1 } },
        { key: "duplicate", value: { kind: "number", numberValue: 2 } },
      ],
    })).toThrow(/duplicate keys/);
  });

  it("binds immutable mapper page identity from the host, not the model echo", () => {
    const modelSegmentId = `segment_${"b".repeat(64)}`;
    const modelOutput = MapperPageOutputSchema.parse({
      targetSessionOpaqueId: "memory_000000000000001",
      pageNumber: 99,
      pageCount: 99,
      expectedSegmentIds: [modelSegmentId],
      mentions: [],
      records: [],
      assistantBlocks: [],
      resolutionAssertions: [],
      coverageRows: [{
        segmentId: modelSegmentId,
        routeType: "no_semantic_content",
        localRecordKeys: [],
        localBlockKeys: [],
        localObjectKeysExpectedInQuarantine: [],
        reason: "fixture",
      }],
    });
    const bound = bindMapperPageToHostManifest(modelOutput, {
      targetSessionOpaqueId: "memory_000000000000002",
      pageNumber: 2,
      pageCount: 3,
      expectedSegmentIds: [`segment_${"a".repeat(64)}`],
    });
    expect(bound).toMatchObject({
      targetSessionOpaqueId: "memory_000000000000002",
      pageNumber: 2,
      pageCount: 3,
      expectedSegmentIds: [`segment_${"a".repeat(64)}`],
    });
    expect(bound.coverageRows).toEqual([]);
  });

  it("reconciles a unique one-character opaque segment-ID copy error", () => {
    const expectedSegmentId = `segment_${"a".repeat(64)}`;
    const copiedSegmentId = `segment_b${"a".repeat(63)}`;
    const modelOutput = MapperPageOutputSchema.parse({
      targetSessionOpaqueId: "memory_000000000000001",
      pageNumber: 1,
      pageCount: 1,
      expectedSegmentIds: [copiedSegmentId],
      mentions: [],
      records: [],
      assistantBlocks: [{
        localBlockKey: "assistant_list_item",
        blockKind: "procedure",
        discourseContext: { frame: "template", commitment: "suggested", parentScopeAnchor: null },
        sourceAnchor: null,
        sourceSegmentIds: [copiedSegmentId],
        items: [],
        supportBindings: [],
        routingText: "Design digital invitations",
        routingTerms: ["invitations"],
      }],
      resolutionAssertions: [],
      coverageRows: [{
        segmentId: copiedSegmentId,
        routeType: "assistant_block",
        localRecordKeys: [],
        localBlockKeys: ["assistant_list_item"],
        localObjectKeysExpectedInQuarantine: [],
        reason: "assistant suggestion",
      }],
    });
    const bound = bindMapperPageToHostManifest(modelOutput, {
      targetSessionOpaqueId: "memory_000000000000002",
      pageNumber: 1,
      pageCount: 1,
      expectedSegmentIds: [expectedSegmentId],
    });
    expect(bound.coverageRows[0]?.segmentId).toBe(expectedSegmentId);
    expect(bound.assistantBlocks[0]?.sourceSegmentIds).toEqual([expectedSegmentId]);
  });

  it("does not guess when a copied segment ID has multiple near matches", () => {
    const copiedSegmentId = `segment_b${"a".repeat(63)}`;
    const modelOutput = MapperPageOutputSchema.parse({
      targetSessionOpaqueId: "memory_000000000000001",
      pageNumber: 1,
      pageCount: 1,
      expectedSegmentIds: [copiedSegmentId],
      mentions: [], records: [], assistantBlocks: [], resolutionAssertions: [],
      coverageRows: [{
        segmentId: copiedSegmentId,
        routeType: "no_semantic_content",
        localRecordKeys: [], localBlockKeys: [], localObjectKeysExpectedInQuarantine: [], reason: "fixture",
      }],
    });
    const bound = bindMapperPageToHostManifest(modelOutput, {
      targetSessionOpaqueId: "memory_000000000000002",
      pageNumber: 1,
      pageCount: 1,
      expectedSegmentIds: [`segment_a${"a".repeat(63)}`, `segment_c${"a".repeat(63)}`],
    });
    expect(bound.coverageRows).toEqual([]);
  });

  it("keeps provider-unenforceable conditional mistakes parseable for quarantine", () => {
    const segmentId = `segment_${"c".repeat(64)}`;
    expect(() => MapperPageOutputSchema.parse({
      targetSessionOpaqueId: "memory_000000000000001",
      pageNumber: 1,
      pageCount: 1,
      expectedSegmentIds: [segmentId],
      mentions: [],
      records: [],
      assistantBlocks: [{
        localBlockKey: "invalid_route",
        blockKind: "other",
        discourseContext: { frame: "actual_report", commitment: "asserted", parentScopeAnchor: null },
        sourceAnchor: null,
        sourceSegmentIds: [],
        items: [],
        supportBindings: [],
        routingText: "proposal retained for deterministic quarantine",
        routingTerms: [],
      }],
      resolutionAssertions: [],
      coverageRows: [{
        segmentId,
        routeType: "quarantine",
        localRecordKeys: [],
        localBlockKeys: [],
        localObjectKeysExpectedInQuarantine: ["invalid_route"],
        reason: "invalid source route",
      }],
    })).not.toThrow();
  });

  it("losslessly patches only approved roots and missing coverage rows", () => {
    const firstSegmentId = `segment_${"d".repeat(64)}`;
    const secondSegmentId = `segment_${"e".repeat(64)}`;
    const anchor = {
      rawTurnId: `rawturn_${"f".repeat(64)}`,
      exactUtf8: "Ashley",
      prefixUtf8: "",
      suffixUtf8: "",
    };
    const prior = MapperPageOutputSchema.parse({
      targetSessionOpaqueId: "memory_000000000000001",
      pageNumber: 1,
      pageCount: 1,
      expectedSegmentIds: [firstSegmentId, secondSegmentId],
      mentions: [
        { localMentionKey: "repair_me", mentionType: "unknown", anchor, sourceSegmentId: null },
        { localMentionKey: "preserve_me", mentionType: "person", anchor, sourceSegmentId: null },
      ],
      records: [], assistantBlocks: [], resolutionAssertions: [],
      coverageRows: [{
        segmentId: firstSegmentId, routeType: "no_semantic_content", localRecordKeys: [],
        localBlockKeys: [], localObjectKeysExpectedInQuarantine: [], reason: "fixture",
      }],
    });
    const preservedBytes = JSON.stringify(prior.mentions[1]);
    const patched = applyMapperPagePatch({
      prior,
      scope: {
        mode: "targeted_patch",
        allowedObjects: [{ objectType: "mention", localObjectKey: "repair_me" }],
        allowedCoverageSegmentIds: [secondSegmentId],
      },
      patch: MapperPagePatchOutputSchema.parse({
        mentions: [{ localMentionKey: "repair_me", mentionType: "person", anchor, sourceSegmentId: null }],
        records: [], assistantBlocks: [], resolutionAssertions: [],
        coverageRows: [{
          segmentId: secondSegmentId, routeType: "no_semantic_content", localRecordKeys: [],
          localBlockKeys: [], localObjectKeysExpectedInQuarantine: [], reason: "missing row repaired",
        }],
      }),
    });
    expect(patched.mentions[0]?.mentionType).toBe("person");
    expect(JSON.stringify(patched.mentions[1])).toBe(preservedBytes);
    expect(patched.coverageRows.map((value) => value.segmentId)).toEqual([firstSegmentId, secondSegmentId]);
    const rejectedMutation = applyMapperPagePatch({
      prior,
      scope: { mode: "targeted_patch", allowedObjects: [], allowedCoverageSegmentIds: [] },
      patch: {
        mentions: [{ localMentionKey: "preserve_me", mentionType: "place", anchor, sourceSegmentId: null }],
        records: [], assistantBlocks: [], resolutionAssertions: [], coverageRows: [],
      },
    });
    expect(rejectedMutation.mentions.find((value) => value.localMentionKey === "preserve_me")?.mentionType)
      .toBe("person");
  });

  it("limits an isolated block repair to its source segments plus one neighbour", () => {
    const segmentIds = ["1", "2", "3", "4", "5"].map((value) => `segment_${value.repeat(64)}`);
    const targetSegmentId = segmentIds[2];
    if (!targetSegmentId) throw new Error("fixture lost target segment");
    const rawTurnId = `rawturn_${"a".repeat(64)}`;
    const page = {
      pageNumber: 1,
      pageCount: 1,
      expectedSegmentIds: segmentIds,
      segments: segmentIds.map((segmentId, ordinal) => ({
        segmentId, rawTurnId, segmentKind: "prose" as const, ordinal,
        byteStart: ordinal * 10, byteEnd: ordinal * 10 + 9, exactUtf8: `segment ${String(ordinal)}`,
      })),
    };
    const prior = MapperPageOutputSchema.parse({
      targetSessionOpaqueId: "memory_000000000000001", pageNumber: 1, pageCount: 1,
      expectedSegmentIds: segmentIds, mentions: [], records: [], resolutionAssertions: [],
      assistantBlocks: [{
        localBlockKey: "repair_me", blockKind: "advice",
        discourseContext: { frame: "actual_report", commitment: "suggested", parentScopeAnchor: null },
        sourceAnchor: null, sourceSegmentIds: [targetSegmentId], items: [], supportBindings: [],
        routingText: "middle advice", routingTerms: ["advice"],
      }],
      coverageRows: segmentIds.map((segmentId) => ({
        segmentId, routeType: "no_semantic_content", localRecordKeys: [], localBlockKeys: [],
        localObjectKeysExpectedInQuarantine: [], reason: "fixture",
      })),
    });
    const relevant = relevantRepairPage({
      page,
      priorOutput: prior,
      repairScope: {
        mode: "targeted_patch",
        allowedObjects: [{ objectType: "assistant_block", localObjectKey: "repair_me" }],
        allowedCoverageSegmentIds: [targetSegmentId],
      },
    });
    expect(relevant.expectedSegmentIds).toEqual(segmentIds.slice(1, 4));
    expect(relevant.expectedSegmentIds.length).toBeLessThan(page.expectedSegmentIds.length);
  });

  it("allows one quarantined root to be reclassified without opening another mutation scope", () => {
    const segmentId = `segment_${"8".repeat(64)}`;
    const rawTurnId = `rawturn_${"9".repeat(64)}`;
    const prior = MapperPageOutputSchema.parse({
      targetSessionOpaqueId: "memory_000000000000001", pageNumber: 1, pageCount: 1,
      expectedSegmentIds: [segmentId], mentions: [], records: [], resolutionAssertions: [],
      assistantBlocks: [{
        localBlockKey: "wrong_role", blockKind: "other",
        discourseContext: { frame: "actual_report", commitment: "asserted", parentScopeAnchor: null },
        sourceAnchor: null, sourceSegmentIds: [segmentId], items: [], supportBindings: [],
        routingText: "wrongly typed user statement", routingTerms: ["statement"],
      }],
      coverageRows: [{
        segmentId, routeType: "assistant_block", localRecordKeys: [], localBlockKeys: ["wrong_role"],
        localObjectKeysExpectedInQuarantine: [], reason: "wrong source role",
      }],
    });
    const patched = applyMapperPagePatch({
      prior,
      scope: {
        mode: "targeted_patch",
        allowedObjects: [{ objectType: "assistant_block", localObjectKey: "wrong_role" }],
        allowedCoverageSegmentIds: [segmentId],
      },
      patch: MapperPagePatchOutputSchema.parse({
        mentions: [], assistantBlocks: [], resolutionAssertions: [],
        records: [{
          localRecordKey: "wrong_role", recordKind: "claim",
          discourseContext: { frame: "actual_report", commitment: "asserted", parentScopeAnchor: null },
          predicate: { surface: "I chose blue", normalized: null }, arguments: [],
          stance: {
            sourceSpeakerRole: "user", sourceSpeakerSurface: null, reportedSpeakerMentionKey: null,
            speechAct: "assertion", polarity: "positive", modalForce: "actual", eventStatus: "completed",
            adoption: "not_applicable", speakerCertainty: "certain",
          },
          validTimes: [],
          claimAnchors: [{ rawTurnId, exactUtf8: "I chose blue", prefixUtf8: "", suffixUtf8: "" }],
          supportBindings: [], extractionConfidence: "high",
        }],
        coverageRows: [{
          segmentId, routeType: "semantic", localRecordKeys: ["wrong_role"], localBlockKeys: [],
          localObjectKeysExpectedInQuarantine: [], reason: "reclassified as a user claim",
        }],
      }),
    });
    expect(patched.assistantBlocks).toEqual([]);
    expect(patched.records.map((value) => value.localRecordKey)).toEqual(["wrong_role"]);
    expect(patched.coverageRows[0]?.routeType).toBe("semantic");
  });

  it("rejects cross-type proposal keys before quarantine repair can merge their roots", () => {
    expect(crossTypeProposalKeyCollisions({
      mentionKeys: [],
      recordKeys: ["fact"],
      blockKeys: ["fact"],
      resolutionKeys: [],
    })).toEqual(["fact"]);
  });

  it("blocks a targeted repair that changes an unaffected support binding", () => {
    const before = emptyPass();
    const after = emptyPass();
    const original = support("6");
    const changed = support("7", "changed by full-page rewrite");
    before.supportBindings.push(original);
    before.derivations.push(derivation(parentAttemptId, original));
    after.supportBindings.push(changed);
    after.derivations.push(derivation(repairAttemptId, changed));
    expect(targetedRepairPreservationErrors({
      prior: before,
      current: after,
      repairedParentAttemptIds: new Set([parentAttemptId]),
      repairAttemptIds: new Set([repairAttemptId]),
      affectedProposalRoots: new Set(["different_quarantined_object"]),
    })).toEqual(expect.arrayContaining([
      expect.stringContaining("changed unaffected support_binding"),
      expect.stringContaining("added unrelated support_binding"),
    ]));
  });

  it("allows a quarantined assistant block repair to restore an omitted item child", () => {
    const before = emptyPass();
    const after = emptyPass();
    before.quarantines.push({
      schemaVersion: 2,
      quarantineId: `quarantine_${"d".repeat(64)}`,
      attemptId: parentAttemptId,
      objectType: "assistant_block",
      localObjectKey: "advice_block",
      draft: {
        localBlockKey: "advice_block",
        items: [{ localItemKey: "step_one" }, { localItemKey: "step_two" }],
      },
      resolvedSelectorIds: [],
      issues: [{ code: "schema_invalid", detail: "fixture", candidateByteOffsets: [] }],
      parentQuarantineIds: [],
    });
    after.derivations.push({
      schemaVersion: 2,
      derivationId: `derivation_${"a".repeat(64)}`,
      attemptId: repairAttemptId,
      objectType: "block",
      objectId: `block_${"b".repeat(64)}`,
      proposalLocalKey: "advice_block",
      extractionConfidence: null,
    }, {
      schemaVersion: 2,
      derivationId: `derivation_${"c".repeat(64)}`,
      attemptId: repairAttemptId,
      objectType: "item",
      objectId: `item_${"d".repeat(64)}`,
      proposalLocalKey: "step_one",
      extractionConfidence: null,
    }, {
      schemaVersion: 2,
      derivationId: `derivation_${"e".repeat(64)}`,
      attemptId: repairAttemptId,
      objectType: "item",
      objectId: `item_${"f".repeat(64)}`,
      proposalLocalKey: "step_two",
      extractionConfidence: null,
    }, {
      schemaVersion: 2,
      derivationId: `derivation_${"0".repeat(64)}`,
      attemptId: repairAttemptId,
      objectType: "item",
      objectId: `item_${"1".repeat(64)}`,
      proposalLocalKey: "newly_restored_step",
      extractionConfidence: null,
    });
    const repairedBlockId = `block_${"b".repeat(64)}`;
    after.assistantBlocks.push({ blockId: repairedBlockId } as MapperMaterialization["assistantBlocks"][number]);
    after.assistantBlockItems.push({
      itemId: `item_${"d".repeat(64)}`, blockId: repairedBlockId,
    } as MapperMaterialization["assistantBlockItems"][number], {
      itemId: `item_${"f".repeat(64)}`, blockId: repairedBlockId,
    } as MapperMaterialization["assistantBlockItems"][number], {
      itemId: `item_${"1".repeat(64)}`, blockId: repairedBlockId,
    } as MapperMaterialization["assistantBlockItems"][number]);
    const affectedProposalRoots = repairAffectedProposalRoots({
      prior: before,
      current: after,
      repairedParentAttemptIds: new Set([parentAttemptId]),
      repairAttemptIds: new Set([repairAttemptId]),
    });
    expect([...affectedProposalRoots].sort()).toEqual([
      "advice_block", "newly_restored_step", "step_one", "step_two",
    ]);
    expect(targetedRepairPreservationErrors({
      prior: before,
      current: after,
      repairedParentAttemptIds: new Set([parentAttemptId]),
      repairAttemptIds: new Set([repairAttemptId]),
      affectedProposalRoots,
    })).toEqual([]);
  });

  it("allows a cross-type collision repair to rename only content-identical objects", () => {
    const before = emptyPass();
    const after = emptyPass();
    const mentionId = `mention_${"6".repeat(64)}`;
    const recordId = `record_${"7".repeat(64)}`;
    before.derivations.push({
      schemaVersion: 2,
      derivationId: `derivation_${"6".repeat(64)}`,
      attemptId: parentAttemptId,
      objectType: "mention",
      objectId: mentionId,
      proposalLocalKey: "fact",
      extractionConfidence: null,
    }, {
      schemaVersion: 2,
      derivationId: `derivation_${"7".repeat(64)}`,
      attemptId: parentAttemptId,
      objectType: "record",
      objectId: recordId,
      proposalLocalKey: "fact",
      extractionConfidence: "high",
    }, {
      schemaVersion: 2,
      derivationId: `derivation_${"b".repeat(64)}`,
      attemptId: parentAttemptId,
      objectType: "support_binding",
      objectId: `support_${"b".repeat(64)}`,
      proposalLocalKey: "fact:support:/predicate/surface",
      extractionConfidence: "high",
    });
    after.derivations.push({
      schemaVersion: 2,
      derivationId: `derivation_${"8".repeat(64)}`,
      attemptId: repairAttemptId,
      objectType: "mention",
      objectId: mentionId,
      proposalLocalKey: "person_mention",
      extractionConfidence: null,
    }, {
      schemaVersion: 2,
      derivationId: `derivation_${"9".repeat(64)}`,
      attemptId: repairAttemptId,
      objectType: "record",
      objectId: recordId,
      proposalLocalKey: "fact",
      extractionConfidence: "high",
    }, {
      schemaVersion: 2,
      derivationId: `derivation_${"c".repeat(64)}`,
      attemptId: repairAttemptId,
      objectType: "support_binding",
      objectId: `support_${"b".repeat(64)}`,
      proposalLocalKey: "fact:support:/predicate/surface",
      extractionConfidence: "high",
    });
    const affectedProposalRoots = repairAffectedProposalRoots({
      prior: before,
      current: after,
      repairedParentAttemptIds: new Set([parentAttemptId]),
      repairAttemptIds: new Set([repairAttemptId]),
    });
    expect([...affectedProposalRoots]).toEqual(["fact"]);
    expect(targetedRepairPreservationErrors({
      prior: before,
      current: after,
      repairedParentAttemptIds: new Set([parentAttemptId]),
      repairAttemptIds: new Set([repairAttemptId]),
      affectedProposalRoots,
    })).toEqual([]);

    const changed = structuredClone(after);
    changed.derivations[0] = {
      ...changed.derivations[0]!,
      objectId: `mention_${"a".repeat(64)}`,
    };
    expect(targetedRepairPreservationErrors({
      prior: before,
      current: changed,
      repairedParentAttemptIds: new Set([parentAttemptId]),
      repairAttemptIds: new Set([repairAttemptId]),
      affectedProposalRoots,
    })).toEqual(expect.arrayContaining([
      expect.stringContaining("collision repair changed prior mention:fact"),
      expect.stringContaining("added unrelated mention:person_mention"),
    ]));

    const changedSupport = structuredClone(after);
    const currentSupport = changedSupport.derivations.find((value) => value.objectType === "support_binding");
    if (!currentSupport) throw new Error("fixture lost its collision support derivation");
    currentSupport.objectId = `support_${"c".repeat(64)}`;
    expect(targetedRepairPreservationErrors({
      prior: before,
      current: changedSupport,
      repairedParentAttemptIds: new Set([parentAttemptId]),
      repairAttemptIds: new Set([repairAttemptId]),
      affectedProposalRoots,
    })).toEqual([expect.stringContaining("collision repair changed prior support_binding:fact:support")]);
  });

  it("records exactly one immutable outcome per attempt", () => {
    const pass = emptyPass();
    pass.attemptResults.push(createAttemptMaterializationResult({
      attemptId: parentAttemptId,
      status: "accepted",
      materializedObjectIds: [],
      quarantineIds: [],
      completionErrors: [],
      warnings: [],
    }));
    const attempts = [
      { attemptId: parentAttemptId, outputComplete: true, warnings: [] },
      { attemptId: neverMaterializedAttemptId, outputComplete: false, warnings: [] },
    ] as Attempt[];
    appendMissingAttemptResults({ attempts, materializationPasses: [pass], destination: pass });
    expect(pass.attemptResults.map((value) => value.attemptId).sort())
      .toEqual([neverMaterializedAttemptId, parentAttemptId].sort());
    expect(new Set(pass.attemptResults.map((value) => value.attemptId)).size).toBe(2);
  });

  it("keeps the first immutable attempt outcome when a later repair changes global materialization context", () => {
    const firstPass = emptyPass();
    const laterPass = emptyPass();
    const firstResult = createAttemptMaterializationResult({
      attemptId: parentAttemptId,
      status: "quarantined",
      materializedObjectIds: [],
      quarantineIds: [`quarantine_${"4".repeat(64)}`],
      completionErrors: [],
      warnings: [],
    });
    firstPass.attemptResults.push(firstResult);
    laterPass.attemptResults.push(createAttemptMaterializationResult({
      attemptId: parentAttemptId,
      status: "accepted",
      materializedObjectIds: [`record_${"5".repeat(64)}`],
      quarantineIds: [],
      completionErrors: [],
      warnings: [],
    }));

    appendMissingAttemptResults({
      attempts: [{ attemptId: parentAttemptId, outputComplete: true, warnings: [] } as Attempt],
      materializationPasses: [firstPass, laterPass],
      destination: laterPass,
    });
    expect(laterPass.attemptResults).toEqual([firstResult]);
    expect(selectActiveAndHistoricalMaterializationArtifacts({
      activePasses: [laterPass],
      historicalPasses: [firstPass, laterPass],
    }).attemptResults).toEqual([firstResult]);
  });

  it("cannot erase a repaired quarantine into no-semantic-content", () => {
    const before = emptyPass();
    const after = emptyPass();
    const quarantineId = `quarantine_${"8".repeat(64)}`;
    const segmentId = `segment_${"9".repeat(64)}`;
    before.quarantines.push({
      schemaVersion: 2,
      quarantineId,
      attemptId: parentAttemptId,
      objectType: "record",
      localObjectKey: "missing_fact",
      draft: {},
      resolvedSelectorIds: [],
      issues: [{ code: "schema_invalid", detail: "fixture", candidateByteOffsets: [] }],
      parentQuarantineIds: [],
    });
    before.coverageRows.push({
      schemaVersion: 2, segmentId, routeType: "quarantine", recordIds: [], blockIds: [],
      quarantineIds: [quarantineId], reason: "fixture",
    });
    after.coverageRows.push({
      schemaVersion: 2, segmentId, routeType: "no_semantic_content", recordIds: [], blockIds: [],
      quarantineIds: [], reason: "incorrect erasure",
    });
    expect(repairedQuarantineLineageErrors({
      prior: before,
      current: after,
      repairedParentAttemptIds: new Set([parentAttemptId]),
    })).toEqual(expect.arrayContaining([
      expect.stringContaining("silently dropped quarantined root"),
      expect.stringContaining("erased quarantined segment"),
    ]));
  });

  it("does not let a same-key block satisfy a quarantined record repair root", () => {
    const before = emptyPass();
    const after = emptyPass();
    before.quarantines.push({
      schemaVersion: 2,
      quarantineId: `quarantine_${"a".repeat(64)}`,
      attemptId: parentAttemptId,
      objectType: "record",
      localObjectKey: "fact",
      draft: {},
      resolvedSelectorIds: [],
      issues: [{ code: "schema_invalid", detail: "fixture", candidateByteOffsets: [] }],
      parentQuarantineIds: [],
    });
    after.derivations.push({
      schemaVersion: 2,
      derivationId: `derivation_${"b".repeat(64)}`,
      attemptId: repairAttemptId,
      objectType: "block",
      objectId: `block_${"c".repeat(64)}`,
      proposalLocalKey: "fact",
      extractionConfidence: null,
    });
    expect(repairedQuarantineLineageErrors({
      prior: before,
      current: after,
      repairedParentAttemptIds: new Set([parentAttemptId]),
    })).toEqual([expect.stringContaining("silently dropped quarantined root fact")]);
  });

  it("finalizes a repair result after host preservation checks", () => {
    const pass = emptyPass();
    pass.attemptResults.push(createAttemptMaterializationResult({
      attemptId: repairAttemptId,
      status: "accepted",
      materializedObjectIds: [],
      quarantineIds: [],
      completionErrors: [],
      warnings: [],
    }));
    finalizeAttemptResultAfterPostchecks({
      materialized: pass,
      attempt: { attemptId: repairAttemptId, outputComplete: true, warnings: [] } as Attempt,
      postcheckErrors: ["repair changed unaffected support"],
    });
    expect(pass.attemptResults).toEqual([expect.objectContaining({
      attemptId: repairAttemptId,
      status: "incomplete",
      completionErrors: ["repair changed unaffected support"],
    })]);
  });

  it("preserves materializer completion errors when finalizing repair postchecks", () => {
    const pass = emptyPass();
    pass.attemptResults.push(createAttemptMaterializationResult({
      attemptId: repairAttemptId,
      status: "incomplete",
      materializedObjectIds: [],
      quarantineIds: [],
      completionErrors: ["segment route is inconsistent"],
      warnings: [],
    }));
    finalizeAttemptResultAfterPostchecks({
      materialized: pass,
      attempt: { attemptId: repairAttemptId, outputComplete: true, warnings: [] } as Attempt,
      postcheckErrors: [],
    });
    expect(pass.attemptResults).toEqual([expect.objectContaining({
      status: "incomplete",
      completionErrors: ["segment route is inconsistent"],
    })]);
  });

  it("keeps only active semantic objects while retaining historical repair evidence", () => {
    const historical = emptyPass();
    const active = emptyPass();
    const oldRecordId = `record_${"a".repeat(64)}`;
    const newRecordId = `record_${"b".repeat(64)}`;
    historical.records.push({ recordId: oldRecordId } as MapperMaterialization["records"][number]);
    active.records.push({ recordId: newRecordId } as MapperMaterialization["records"][number]);
    historical.supportBindings.push(support("a"));
    active.supportBindings.push(support("b"));
    historical.semanticProjections.push({
      projectionId: `projection_${"c".repeat(64)}`,
    } as MapperMaterialization["semanticProjections"][number]);
    active.semanticProjections.push({
      projectionId: `projection_${"d".repeat(64)}`,
    } as MapperMaterialization["semanticProjections"][number]);
    historical.quarantines.push({
      quarantineId: `quarantine_${"e".repeat(64)}`,
    } as MapperMaterialization["quarantines"][number]);
    historical.derivations.push({
      derivationId: `derivation_${"f".repeat(64)}`,
    } as MapperMaterialization["derivations"][number]);

    const selected = selectActiveAndHistoricalMaterializationArtifacts({
      activePasses: [active],
      historicalPasses: [historical, active],
    });
    expect(selected.records.map((value) => value.recordId)).toEqual([newRecordId]);
    expect(selected.supportBindings).toEqual(active.supportBindings);
    expect(selected.semanticProjections).toEqual(active.semanticProjections);
    expect(selected.quarantines).toEqual(historical.quarantines);
    expect(selected.derivations).toEqual(historical.derivations);
  });
});
