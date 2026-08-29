import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DiscoveryEvidenceSchema,
  EntailmentJudgmentSchema,
  ObligationManifestSchema,
  TypedObligationSchema,
  bindSupportJudgmentsToExpectedIds,
  enforceSupportedEntailments,
  oneSidedPrecisionLowerBound95,
  precisionGateDecision,
  recordProvenanceSelectorIds,
  readFrozenSettledCost,
  semanticProjectionTokenMetrics,
  stratifiedPrecisionSample,
  summarizeTypedEvaluation,
  validateEntailmentJudgmentCitations,
  validateSupportJudgmentBatchCompleteness,
  validateDiscoveryNegative,
} from "../src/ingestion/structuredEventEvaluationV1.js";
import {
  SemanticRecordSchema,
  SupportBindingSchema,
} from "../src/ingestion/structuredEventSchemaV1.js";

const record = `record_${"a".repeat(64)}`;
const link = `link_${"b".repeat(64)}`;
const selector = `selector_${"c".repeat(64)}`;
const block = `block_${"d".repeat(64)}`;
const item = `item_${"e".repeat(64)}`;

function obligation(overrides: Record<string, unknown> = {}) {
  return TypedObligationSchema.parse({
    obligationId: "story.fact",
    storyId: "story",
    obligationType: "direct_semantic",
    eligiblePlane: "semantic_record",
    stage: "semantic_ingestion",
    denominatorName: "direct_semantic",
    description: "The stored fact includes its value and unit.",
    satisfactionRule: "A semantic record states both value and unit.",
    sourceSelectorIds: [selector],
    criticality: "critical",
    stratum: "fact",
    ...overrides,
  });
}

describe("typed ingestion evaluation", () => {
  it("counts field-level source bindings as record occurrence provenance", () => {
    const containingSelector = `selector_${"f".repeat(64)}`;
    const semanticRecord = SemanticRecordSchema.parse({
      schemaVersion: 2,
      recordKind: "intention",
      discourseContext: { frame: "actual_report", commitment: "asserted", parentScopeSelectorId: null },
      predicate: { surface: "create invitations", normalized: null },
      arguments: [],
      stance: {
        sourceSpeakerRole: "user", sourceSpeakerSurface: null, reportedSpeakerMentionId: null,
        speechAct: "intention", polarity: "positive", modalForce: "planned",
        eventStatus: "proposed", adoption: "not_applicable", speakerCertainty: "certain",
      },
      temporal: {
        assertionTime: { raw: "2026-01-01", precision: "exact", source: "host_metadata" },
        sessionOrdinal: 0, turnOrdinal: 0, validTimes: [],
      },
      claimSelectorIds: [selector],
      recordId: record,
    });
    const binding = SupportBindingSchema.parse({
      schemaVersion: 2,
      supportBindingId: `support_${"1".repeat(64)}`,
      targetObjectType: "record",
      targetObjectId: record,
      targetFieldPathOrMentionId: "/stance/modalForce",
      purpose: "semantic_classification",
      method: "coordinated_plan",
      selectorIds: [containingSelector],
      metadataSelectorIds: [],
      confidence: "high",
    });
    expect(recordProvenanceSelectorIds(semanticRecord, [binding]))
      .toEqual([selector, containingSelector].sort());
  });

  it("does not count a negative unless the whole eligible plane was scanned", () => {
    const atom = obligation();
    const incompleteDiscovery = DiscoveryEvidenceSchema.parse({
      obligationId: atom.obligationId,
      eligibleObjectIds: [record, `record_${"c".repeat(64)}`],
      discoveredObjectIds: [record],
      exhaustivelyScannedObjectIds: [record],
      validatedDiscoveryRecallBound: null,
    });
    const negative = EntailmentJudgmentSchema.parse({
      obligationId: atom.obligationId, entailed: false, coveringObjectIds: [], missingDetails: ["unit"],
    });
    expect(() => validateDiscoveryNegative(atom, incompleteDiscovery, negative)).toThrow(/not an ingestion loss/);
  });

  it("keeps semantic and link story denominators separate", () => {
    const semantic = obligation();
    const typedLink = obligation({
      obligationId: "story.update",
      obligationType: "typed_link",
      eligiblePlane: "typed_link",
      stage: "link_overlay",
      denominatorName: "typed_link",
      description: "The later value updates the earlier value.",
      satisfactionRule: "A directed UPDATES link exists.",
    });
    const summary = summarizeTypedEvaluation({
      obligations: [semantic, typedLink],
      discoveries: [
        { obligationId: semantic.obligationId, eligibleObjectIds: [record], discoveredObjectIds: [record], exhaustivelyScannedObjectIds: [record], validatedDiscoveryRecallBound: null },
        { obligationId: typedLink.obligationId, eligibleObjectIds: [link], discoveredObjectIds: [link], exhaustivelyScannedObjectIds: [link], validatedDiscoveryRecallBound: null },
      ],
      judgments: [
        { obligationId: semantic.obligationId, entailed: true, coveringObjectIds: [record], missingDetails: [] },
        { obligationId: typedLink.obligationId, entailed: false, coveringObjectIds: [], missingDetails: ["direction"] },
      ],
    });
    expect(summary.semanticStories).toEqual({ complete: 1, total: 1, completeStoryIds: ["story"] });
    expect(summary.linkStories).toEqual({ complete: 0, total: 1, completeStoryIds: [] });
    expect(summary.combinedReadyStories.complete).toBe(0);
    expect(summary.denominators.compact_route).toEqual({ covered: 0, total: 0, ratio: null });
    const semanticOnly = summarizeTypedEvaluation({
      obligations: [semantic],
      discoveries: [{
        obligationId: semantic.obligationId,
        eligibleObjectIds: [record], discoveredObjectIds: [record], exhaustivelyScannedObjectIds: [record],
        validatedDiscoveryRecallBound: null,
      }],
      judgments: [{ obligationId: semantic.obligationId, entailed: true, coveringObjectIds: [record], missingDetails: [] }],
    });
    expect(semanticOnly.combinedReadyStories).toEqual({ complete: 0, total: 0, completeStoryIds: [] });
  });

  it("never places derived answers in an ingestion denominator", () => {
    expect(() => obligation({
      obligationType: "derived_relation", eligiblePlane: "semantic_record", stage: "answer_stage", denominatorName: "not_scored",
    })).toThrow();
    const derived = obligation({
      obligationType: "derived_relation", eligiblePlane: "none", stage: "answer_stage", denominatorName: "not_scored",
    });
    const summary = summarizeTypedEvaluation({
      obligations: [derived], discoveries: [],
      judgments: [{ obligationId: derived.obligationId, entailed: false, coveringObjectIds: [], missingDetails: ["computed later"] }],
    });
    expect(summary.semanticStories.total).toBe(0);
    expect(summary.linkStories.total).toBe(0);
  });

  it("always includes critical objects in an independent precision sample", () => {
    const population = Array.from({ length: 20 }, (_, index) => ({
      objectId: `record_${index.toString(16).padStart(64, "0")}`,
      clusterId: `turn-${String(Math.floor(index / 2))}`,
      sourceRole: "user" as const,
      plane: "semantic_record" as const,
      speechAct: "assertion",
      discourseFrame: "actual_report",
      usesResolution: false,
      confidenceLevels: ["high" as const],
      listLengthBucket: "none" as const,
      objectKind: "claim",
      critical: index === 19,
    }));
    const sample = stratifiedPrecisionSample({ population, seed: "fixture", targetNonCritical: 3 });
    expect(sample.some((row) => row.objectId === population[19]?.objectId)).toBe(true);
  });

  it("retains multiple confidence occurrences without choosing one optimistic value", () => {
    const population = [{
      objectId: record,
      clusterId: "turn-1",
      sourceRole: "user" as const,
      plane: "semantic_record" as const,
      speechAct: "assertion",
      discourseFrame: "actual_report",
      usesResolution: false,
      confidenceLevels: ["high" as const, "low" as const],
      listLengthBucket: "none" as const,
      objectKind: "claim",
      critical: true,
    }];
    expect(stratifiedPrecisionSample({ population, seed: "fixture", targetNonCritical: 0 })[0]?.confidenceLevels)
      .toEqual(["high", "low"]);
  });

  it("can produce an exact bounded-cohort precision census", () => {
    const population = Array.from({ length: 4 }, (_, index) => ({
      objectId: `record_${String(index + 1).repeat(64)}`,
      clusterId: `turn-${String(index)}`,
      sourceRole: "user" as const,
      plane: "semantic_record" as const,
      speechAct: "assertion",
      discourseFrame: "actual_report",
      usesResolution: false,
      confidenceLevels: ["high" as const],
      listLengthBucket: "none" as const,
      objectKind: "claim",
      critical: false,
    }));
    expect(stratifiedPrecisionSample({ population, seed: "fixture", targetNonCritical: population.length }))
      .toHaveLength(population.length);
  });

  it("blocks non-census development precision and unsupported certification population claims", () => {
    expect(precisionGateDecision({
      role: "development_falsification",
      supported: 10, total: 10, criticalSupported: 1, criticalTotal: 1, isCensus: false,
      minimumSupportedRatio: 0.99, requireAllCriticalSupported: true,
    })).toEqual(expect.objectContaining({ status: "incomplete_census", passed: false }));
    expect(precisionGateDecision({
      role: "custodian_sealed_certification",
      supported: 300, total: 300, criticalSupported: 20, criticalTotal: 20, isCensus: true,
      minimumSupportedRatio: 0.99, requireAllCriticalSupported: true,
    })).toEqual({ status: "population_inference_unavailable", populationClaimAllowed: false, passed: false });
  });

  it("freezes precision policy without guessing the model-created population size", () => {
    const policy = {
      minimumSupportedRatio: 0.99,
      requireAllCriticalSupported: true,
    } as const;
    expect(precisionGateDecision({
      role: "development_falsification",
      supported: 99, total: 100, criticalSupported: 4, criticalTotal: 4, isCensus: true,
      ...policy,
    })).toEqual(expect.objectContaining({ status: "passed", passed: true }));
    expect(precisionGateDecision({
      role: "development_falsification",
      supported: 98, total: 100, criticalSupported: 4, criticalTotal: 4, isCensus: true,
      ...policy,
    })).toEqual(expect.objectContaining({ status: "failed", passed: false }));
    expect(precisionGateDecision({
      role: "development_falsification",
      supported: 99, total: 100, criticalSupported: 3, criticalTotal: 4, isCensus: true,
      ...policy,
    })).toEqual(expect.objectContaining({ status: "failed", passed: false }));
  });

  it("treats an empty precision denominator as not evaluable", () => {
    expect(oneSidedPrecisionLowerBound95(0, 0)).toBeNull();
    expect(oneSidedPrecisionLowerBound95(299, 299)).toBeGreaterThanOrEqual(0.99);
  });

  it("downgrades a positive entailment when its covering object is not source-supported", () => {
    const [result] = enforceSupportedEntailments({
      judgments: [{
        obligationId: "story.fact",
        entailed: true,
        coveringObjectIds: [record],
        missingDetails: [],
      }],
      supportJudgments: [{
        objectId: record,
        supported: false,
        criticalError: true,
        unsupportedFields: ["/arguments/0/value"],
        reason: "the cited source does not support the value",
      }],
    });
    expect(result).toEqual(expect.objectContaining({
      entailed: false,
      missingDetails: expect.arrayContaining([expect.stringContaining("not fully supported")]),
    }));
  });

  it("rejects an invented entailment citation outside the exact candidate batch", () => {
    expect(() => validateEntailmentJudgmentCitations({
      judgment: {
        obligationId: "story.fact",
        entailed: true,
        coveringObjectIds: [`block_${"a".repeat(64)}`],
        missingDetails: [],
      },
      obligationId: "story.fact",
      eligibleObjectIds: new Set([`block_${"b".repeat(64)}`]),
    })).toThrow(/outside its batch/);
    expect(validateEntailmentJudgmentCitations({
      judgment: {
        obligationId: "story.fact",
        entailed: true,
        coveringObjectIds: [`block_${"b".repeat(64)}`],
        missingDetails: [],
      },
      obligationId: "story.fact",
      eligibleObjectIds: new Set([`block_${"b".repeat(64)}`]),
    }).entailed).toBe(true);
  });

  it("rejects a shortened support object ID and accepts an exact complete batch", () => {
    const exactId = `link_${"a".repeat(64)}`;
    const judgment = {
      objectId: exactId,
      supported: true,
      criticalError: false,
      unsupportedFields: [],
      reason: "all meaning-bearing fields are supported",
    };
    expect(() => validateSupportJudgmentBatchCompleteness({
      judgments: [{ ...judgment, objectId: exactId.slice(0, -1) }],
      expectedObjectIds: [exactId],
    })).toThrow(/missing=.*extra=/);
    expect(validateSupportJudgmentBatchCompleteness({
      judgments: [judgment],
      expectedObjectIds: [exactId],
    })).toEqual([judgment]);
  });

  it("host-binds only a unique one-character support-ID copy error", () => {
    const first = `link_${"a".repeat(64)}`;
    const second = `link_${"b".repeat(64)}`;
    const judgment = {
      objectId: first.slice(0, -1),
      supported: true,
      criticalError: false,
      unsupportedFields: [],
      reason: "all meaning-bearing fields are supported",
    };
    expect(bindSupportJudgmentsToExpectedIds({
      judgments: [judgment],
      expectedObjectIds: [first, second],
    })[0]?.objectId).toBe(first);
    const ambiguousReturned = `link_${"a".repeat(63)}`;
    const ambiguousFirst = `${ambiguousReturned}a`;
    const ambiguousSecond = `${ambiguousReturned}b`;
    expect(bindSupportJudgmentsToExpectedIds({
      judgments: [{ ...judgment, objectId: ambiguousReturned }],
      expectedObjectIds: [ambiguousFirst, ambiguousSecond],
    })[0]?.objectId).toBe(ambiguousReturned);
  });

  it("rejects an evaluation manifest that omits mandatory denominators", () => {
    expect(() => ObligationManifestSchema.parse({
      schemaVersion: 1,
      role: "development_falsification",
      cohortHash: "d".repeat(64),
      obligations: [obligation()],
      exactGates: [{ denominatorName: "semantic_story_complete", criticality: null, stratum: null, numeratorRequired: 1, denominator: 1 }],
      precisionPolicy: {
        samplingMode: "bounded_cohort_census",
        denominatorBasis: "frozen_active_population",
        minimumSupportedRatio: 0.99,
        requireAllCriticalSupported: true,
      },
    })).toThrow(/semantic_story_complete|direct_semantic|source_occurrence/);
  });

  it("requires exact gates for every criticality and stratum cell", () => {
    const critical = obligation();
    const standard = obligation({ obligationId: "story.standard", criticality: "standard" });
    const exactGates = [
      { denominatorName: "direct_semantic", criticality: "critical" as const, stratum: "fact", numeratorRequired: 1, denominator: 1 },
      { denominatorName: "direct_semantic", criticality: "standard" as const, stratum: "fact", numeratorRequired: 1, denominator: 1 },
      { denominatorName: "source_occurrence", criticality: "critical" as const, stratum: "fact", numeratorRequired: 1, denominator: 1 },
      { denominatorName: "source_occurrence", criticality: "standard" as const, stratum: "fact", numeratorRequired: 1, denominator: 1 },
      { denominatorName: "semantic_story_complete", criticality: null, stratum: null, numeratorRequired: 1, denominator: 1 },
    ];
    expect(ObligationManifestSchema.parse({
      schemaVersion: 1,
      role: "development_falsification",
      cohortHash: "e".repeat(64),
      obligations: [critical, standard],
      exactGates,
      precisionPolicy: {
        samplingMode: "bounded_cohort_census",
        denominatorBasis: "frozen_active_population",
        minimumSupportedRatio: 0.99,
        requireAllCriticalSupported: true,
      },
    }).exactGates).toHaveLength(5);
    expect(() => ObligationManifestSchema.parse({
      schemaVersion: 1,
      role: "development_falsification",
      cohortHash: "e".repeat(64),
      obligations: [critical, standard],
      exactGates: exactGates.filter((gate) =>
        !(gate.denominatorName === "direct_semantic" && gate.criticality === "critical")),
      precisionPolicy: {
        samplingMode: "bounded_cohort_census",
        denominatorBasis: "frozen_active_population",
        minimumSupportedRatio: 0.99,
        requireAllCriticalSupported: true,
      },
    })).toThrow(/direct_semantic\|critical\|fact/);
  });

  it("rejects a weakened or guessed precision gate contract", () => {
    const exactGates = [
      { denominatorName: "direct_semantic", criticality: "critical" as const, stratum: "fact", numeratorRequired: 1, denominator: 1 },
      { denominatorName: "source_occurrence", criticality: "critical" as const, stratum: "fact", numeratorRequired: 1, denominator: 1 },
      { denominatorName: "semantic_story_complete", criticality: null, stratum: null, numeratorRequired: 1, denominator: 1 },
    ];
    const manifest = {
      schemaVersion: 1,
      role: "development_falsification",
      cohortHash: "f".repeat(64),
      obligations: [obligation()],
      exactGates,
      precisionPolicy: {
        samplingMode: "bounded_cohort_census",
        denominatorBasis: "frozen_active_population",
        minimumSupportedRatio: 0.98,
        requireAllCriticalSupported: true,
      },
    };
    expect(() => ObligationManifestSchema.parse(manifest)).toThrow();
    expect(() => ObligationManifestSchema.parse({
      ...manifest,
      precisionPolicy: { ...manifest.precisionPolicy, minimumSupportedRatio: 0.99 },
      exactGates: [...exactGates, {
        denominatorName: "precision_supported",
        criticality: null,
        stratum: null,
        numeratorRequired: 99,
        denominator: 100,
      }],
    })).toThrow();
  });

  it("accounts for serialized lexical postings, compact targets, and active raw-only routes", () => {
    const metrics = semanticProjectionTokenMetrics({
      records: [],
      semantic: [],
      blocks: [{
        schemaVersion: 2,
        projectionId: `projection_${"f".repeat(64)}`,
        blockId: block,
        rendererVersion: "fixture",
        routingText: "route",
        routingTerms: ["route"],
        itemRoutingTerms: { [item]: ["detail"] },
      }],
      rawLexicalPostings: [{
        schemaVersion: 2,
        postingId: `lexical_posting_${"1".repeat(64)}`,
        targetObjectType: "block",
        targetObjectId: block,
        sourceSelectorId: selector,
        normalizedTerms: ["route"],
      }, {
        schemaVersion: 2,
        postingId: `lexical_posting_${"2".repeat(64)}`,
        targetObjectType: "item",
        targetObjectId: item,
        sourceSelectorId: selector,
        normalizedTerms: ["detail"],
      }],
      coverageRows: [{
        schemaVersion: 2,
        segmentId: `segment_${"3".repeat(64)}`,
        routeType: "no_semantic_content",
        recordIds: [], blockIds: [], quarantineIds: [], reason: "fixture",
      }, {
        schemaVersion: 2,
        segmentId: `segment_${"4".repeat(64)}`,
        routeType: "quarantine",
        recordIds: [], blockIds: [], quarantineIds: [`quarantine_${"5".repeat(64)}`], reason: "fixture",
      }],
      rawTokenCount: 100,
      rawRecoverableTurnCount: 1,
      provenanceStorageByteCount: 1000,
      quarantineBacklogCount: 1,
    });
    expect(metrics.rawLexicalIndexTokens).toBeGreaterThan(0);
    expect(metrics.coverage.compactDiscoverability).toEqual({ targetCount: 2, indexedTargetCount: 2, ratio: 1 });
    expect(metrics.coverage.rawOnlySegmentCount).toBe(2);
    expect(metrics.roleDistribution.semanticProjectionTokensBySpeechAct).toEqual({});
  });

  it("initializes evaluation spend only from the frozen settled semantic-plus-link cost artifact", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "beam-frozen-cost-"));
    try {
      const artifactPath = resolve(directory, "semantic-plus-link-cost.json");
      const bytes = `${JSON.stringify({
        ceiling_usd: 10,
        spent_usd: 3,
        reserved_usd: 0,
        remaining_usd: 7,
      })}\n`;
      writeFileSync(artifactPath, bytes);
      const linkFreeze = {
        schemaVersion: 1 as const,
        status: "complete" as const,
        semanticFreezeSha256: "6".repeat(64),
        linkerPromptSha256: "7".repeat(64),
        artifacts: [{
          path: artifactPath,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          byteLength: Buffer.byteLength(bytes),
        }],
        createdAt: "2026-08-11T00:00:00.000Z",
        questionBlind: true as const,
      };
      expect(readFrozenSettledCost({ artifactPath, linkFreeze, approvedCeilingUsd: 10 }).spent_usd).toBe(3);
      writeFileSync(artifactPath, bytes.replace('"spent_usd":3', '"spent_usd":4'));
      expect(() => readFrozenSettledCost({ artifactPath, linkFreeze, approvedCeilingUsd: 10 }))
        .toThrow(/does not match its manifest/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("normalizes only signed floating-point epsilon in frozen settled cost", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "beam-frozen-cost-epsilon-"));
    try {
      const artifactPath = resolve(directory, "semantic-plus-link-cost.json");
      const bytes = `${JSON.stringify({
        ceiling_usd: 10, spent_usd: 3, reserved_usd: -2.7755575615628914e-16, remaining_usd: 7,
      })}\n`;
      writeFileSync(artifactPath, bytes);
      const linkFreeze = {
        schemaVersion: 1 as const, status: "complete" as const,
        semanticFreezeSha256: "6".repeat(64), linkerPromptSha256: "7".repeat(64),
        artifacts: [{
          path: artifactPath, sha256: createHash("sha256").update(bytes).digest("hex"),
          byteLength: Buffer.byteLength(bytes),
        }],
        createdAt: "2026-08-11T00:00:00.000Z", questionBlind: true as const,
      };
      expect(readFrozenSettledCost({ artifactPath, linkFreeze, approvedCeilingUsd: 10 }).reserved_usd).toBe(0);
      const invalid = bytes.replace("-2.7755575615628914e-16", "-0.01");
      writeFileSync(artifactPath, invalid);
      const invalidFreeze = {
        ...linkFreeze,
        artifacts: [{
          path: artifactPath, sha256: createHash("sha256").update(invalid).digest("hex"),
          byteLength: Buffer.byteLength(invalid),
        }],
      };
      expect(() => readFrozenSettledCost({ artifactPath, linkFreeze: invalidFreeze, approvedCeilingUsd: 10 }))
        .toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
