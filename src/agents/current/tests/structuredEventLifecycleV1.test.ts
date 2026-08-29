import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createAttempt,
  createAttemptMaterializationResult,
  createAttemptSupersession,
  createLifecycleEvent,
  defaultProjectionMembership,
  validateLifecycleLineage,
} from "../src/ingestion/structuredEventMaterializerV1.js";
import { canonicalJson, type Attempt } from "../src/ingestion/structuredEventSchemaV1.js";

const recordId = `record_${"a".repeat(64)}`;
const replacementId = `record_${"b".repeat(64)}`;
const attemptA = `attempt_${"c".repeat(64)}`;
const attemptB = `attempt_${"d".repeat(64)}`;
const attemptC = `attempt_${"e".repeat(64)}`;
const projectionId = `projection_${"f".repeat(64)}`;
const replacementProjectionId = `projection_${"0".repeat(64)}`;

function judgmentAttempt(args: {
  label: string;
  role: "semantic_judge" | "adjudicator";
  targetRecordId: string;
  targetProjectionId: string;
  parentAttemptIds?: string[];
  outputComplete?: boolean;
  priorLifecycleEventIds?: string[];
}): Attempt {
  const priorLifecycleEventIds = args.priorLifecycleEventIds ?? [];
  const inputContextManifest = {
    targetRecordId: args.targetRecordId,
    targetProjectionId: args.targetProjectionId,
    priorLifecycleEventIds,
  };
  const rawProviderOutput = JSON.stringify({ label: args.label });
  return createAttempt({
    runId: "lifecycle-fixture",
    targetId: args.targetRecordId,
    pageNumber: 1,
    inputContextManifest,
    inputContextManifestSha256: createHash("sha256").update(canonicalJson(inputContextManifest)).digest("hex"),
    parentAttemptIds: args.parentAttemptIds ?? [],
    trigger: args.role,
    model: `fixture-${args.label}`,
    promptSha256: "1".repeat(64),
    schemaSha256: "2".repeat(64),
    rawProviderOutput,
    rawOutputSha256: createHash("sha256").update(rawProviderOutput).digest("hex"),
    parsedDrafts: {
      targetRecordId: args.targetRecordId,
      targetProjectionId: args.targetProjectionId,
      priorLifecycleEventIds,
      lifecycleState: "invalidated",
      reason: "fixture verdict",
    },
    diagnostics: [],
    warnings: [],
    finishReason: "completed",
    outputComplete: args.outputComplete ?? true,
    extractionConfidence: null,
  });
}

describe("append-only lifecycle", () => {
  it("permits a model only to challenge, not invalidate", () => {
    const accepted = createLifecycleEvent({
      recordId,
      judgedProjectionId: projectionId,
      state: "accepted",
      basis: "materialization",
      semanticJudgeAttemptIds: [],
      adjudicatorAttemptId: null,
      replacementRecordIds: [],
      priorLifecycleEventIds: [],
      detail: "fixture accepted",
    });
    const challenged = createLifecycleEvent({
      recordId,
      judgedProjectionId: projectionId,
      state: "challenged",
      basis: "model_challenge",
      semanticJudgeAttemptIds: [attemptA],
      adjudicatorAttemptId: null,
      replacementRecordIds: [],
      priorLifecycleEventIds: [accepted.lifecycleEventId],
      detail: "fixture challenge",
    });
    expect(challenged.lifecycleEventId).toMatch(/^lifecycle_[a-f0-9]{64}$/);
    expect(() => createLifecycleEvent({
      recordId,
      judgedProjectionId: projectionId,
      state: "invalidated",
      basis: "model_challenge",
      semanticJudgeAttemptIds: [attemptA],
      adjudicatorAttemptId: null,
      replacementRecordIds: [replacementId],
      priorLifecycleEventIds: [challenged.lifecycleEventId],
      detail: "invalid model-only transition",
    })).toThrow(/model challenge|invalidation/);
  });

  it("requires two judgments plus adjudication and a replacement for semantic invalidation", () => {
    const accepted = createLifecycleEvent({
      recordId,
      judgedProjectionId: projectionId,
      state: "accepted",
      basis: "materialization",
      semanticJudgeAttemptIds: [],
      adjudicatorAttemptId: null,
      replacementRecordIds: [],
      priorLifecycleEventIds: [],
      detail: "fixture accepted",
    });
    expect(() => createLifecycleEvent({
      recordId,
      judgedProjectionId: projectionId,
      state: "invalidated",
      basis: "dual_judge_adjudication",
      semanticJudgeAttemptIds: [attemptA],
      adjudicatorAttemptId: attemptC,
      replacementRecordIds: [replacementId],
      priorLifecycleEventIds: [accepted.lifecycleEventId],
      detail: "only one judgment",
    })).toThrow(/dual-judge/);
    const valid = createLifecycleEvent({
      recordId,
      judgedProjectionId: projectionId,
      state: "invalidated",
      basis: "dual_judge_adjudication",
      semanticJudgeAttemptIds: [attemptA, attemptB],
      adjudicatorAttemptId: attemptC,
      replacementRecordIds: [replacementId],
      priorLifecycleEventIds: [accepted.lifecycleEventId],
      detail: "independent judgments and accepted replacement",
    });
    expect(valid.state).toBe("invalidated");
    expect(() => createLifecycleEvent({
      recordId,
      judgedProjectionId: projectionId,
      state: "invalidated",
      basis: "deterministic_invalidity",
      semanticJudgeAttemptIds: [],
      adjudicatorAttemptId: null,
      replacementRecordIds: [],
      priorLifecycleEventIds: [accepted.lifecycleEventId],
      detail: "missing replacement",
    })).toThrow(/projection_gap/);
  });

  it("rejects re-acceptance after an invalidated terminal state", () => {
    const accepted = createLifecycleEvent({
      recordId,
      judgedProjectionId: projectionId,
      state: "accepted",
      basis: "materialization",
      semanticJudgeAttemptIds: [],
      adjudicatorAttemptId: null,
      replacementRecordIds: [],
      priorLifecycleEventIds: [],
      detail: "fixture accepted",
    });
    const invalidated = createLifecycleEvent({
      recordId,
      judgedProjectionId: projectionId,
      state: "invalidated",
      basis: "deterministic_invalidity",
      semanticJudgeAttemptIds: [],
      adjudicatorAttemptId: null,
      replacementRecordIds: [replacementId],
      priorLifecycleEventIds: [accepted.lifecycleEventId],
      detail: "fixture invalidated",
    });
    expect(() => createLifecycleEvent({
      recordId,
      judgedProjectionId: projectionId,
      state: "accepted",
      basis: "materialization",
      semanticJudgeAttemptIds: [],
      adjudicatorAttemptId: null,
      replacementRecordIds: [],
      priorLifecycleEventIds: [invalidated.lifecycleEventId],
      detail: "invalid reactivation",
    })).toThrow(/materialization lifecycle/);
  });

  it("stores materialization outcomes outside immutable model-call attempts", () => {
    const result = createAttemptMaterializationResult({
      attemptId: attemptA,
      status: "incomplete",
      materializedObjectIds: [],
      quarantineIds: [],
      completionErrors: ["provider output was truncated"],
      warnings: [],
    });
    expect(result.attemptResultId).toMatch(/^attempt_result_[a-f0-9]{64}$/);
    const supersession = createAttemptSupersession({
      parentAttemptId: attemptA,
      replacementAttemptId: attemptB,
      reason: "targeted_repair",
    });
    expect(supersession.supersessionId).toMatch(/^supersession_[a-f0-9]{64}$/);
  });

  it("excludes an invalidated record from default searchable membership", () => {
    const accepted = createLifecycleEvent({
      recordId,
      judgedProjectionId: projectionId,
      state: "accepted",
      basis: "materialization",
      semanticJudgeAttemptIds: [],
      adjudicatorAttemptId: null,
      replacementRecordIds: [],
      priorLifecycleEventIds: [],
      detail: "fixture accepted",
    });
    const invalidated = createLifecycleEvent({
      recordId,
      judgedProjectionId: projectionId,
      state: "invalidated",
      basis: "deterministic_invalidity",
      semanticJudgeAttemptIds: [],
      adjudicatorAttemptId: null,
      replacementRecordIds: [replacementId],
      priorLifecycleEventIds: [accepted.lifecycleEventId],
      detail: "fixture replacement",
    });
    const replacementAccepted = createLifecycleEvent({
      recordId: replacementId,
      judgedProjectionId: replacementProjectionId,
      state: "accepted",
      basis: "materialization",
      semanticJudgeAttemptIds: [],
      adjudicatorAttemptId: null,
      replacementRecordIds: [],
      priorLifecycleEventIds: [],
      detail: "replacement accepted",
    });
    const record = {
      schemaVersion: 2 as const,
      recordKind: "claim" as const,
      discourseContext: { frame: "actual_report" as const, commitment: "asserted" as const, parentScopeSelectorId: null },
      predicate: { surface: "fixture", normalized: null },
      arguments: [],
      stance: {
        sourceSpeakerRole: "user" as const, sourceSpeakerSurface: null, reportedSpeakerMentionId: null,
        speechAct: "assertion" as const, polarity: "positive" as const, modalForce: "actual" as const,
        eventStatus: "completed" as const, adoption: "not_applicable" as const, speakerCertainty: "certain" as const,
      },
      temporal: {
        assertionTime: { raw: null, precision: "unknown" as const, source: "host_metadata" as const },
        sessionOrdinal: 0,
        turnOrdinal: 0,
        validTimes: [],
      },
      claimSelectorIds: [`selector_${"e".repeat(64)}`],
    };
    const memberships = defaultProjectionMembership({
      records: [{ ...record, recordId }, { ...record, recordId: replacementId }],
      projections: [{
        schemaVersion: 2,
        projectionId,
        recordId,
        projectionKind: "base",
        baseProjectionId: null,
        rendererVersion: "fixture",
        confirmedResolutionIds: [],
        canonicalText: "fixture",
      }, {
        schemaVersion: 2,
        projectionId: replacementProjectionId,
        recordId: replacementId,
        projectionKind: "base",
        baseProjectionId: null,
        rendererVersion: "fixture",
        confirmedResolutionIds: [],
        canonicalText: "replacement fixture",
      }],
      lifecycleEvents: [accepted, invalidated, replacementAccepted],
    });
    expect(memberships).toEqual([expect.objectContaining({ recordId: replacementId })]);
    const gap = createLifecycleEvent({
      recordId,
      judgedProjectionId: projectionId,
      state: "projection_gap",
      basis: "deterministic_invalidity",
      semanticJudgeAttemptIds: [],
      adjudicatorAttemptId: null,
      replacementRecordIds: [],
      priorLifecycleEventIds: [accepted.lifecycleEventId],
      detail: "no supported replacement exists",
    });
    expect(() => defaultProjectionMembership({
      records: [{ ...record, recordId }],
      projections: [{
        schemaVersion: 2,
        projectionId,
        recordId,
        projectionKind: "base",
        baseProjectionId: null,
        rendererVersion: "fixture",
        confirmedResolutionIds: [],
        canonicalText: "fixture",
      }],
      lifecycleEvents: [accepted, gap],
    })).toThrow(/projection_gap/);
  });

  it("binds both semantic judges and the adjudicator to the exact record projection state", () => {
    const accepted = createLifecycleEvent({
      recordId,
      judgedProjectionId: projectionId,
      state: "accepted",
      basis: "materialization",
      semanticJudgeAttemptIds: [],
      adjudicatorAttemptId: null,
      replacementRecordIds: [],
      priorLifecycleEventIds: [],
      detail: "fixture accepted",
    });
    const priorLifecycleEventIds = [accepted.lifecycleEventId];
    const judgeA = judgmentAttempt({ label: "judge-a", role: "semantic_judge", targetRecordId: recordId, targetProjectionId: projectionId, priorLifecycleEventIds });
    const judgeB = judgmentAttempt({ label: "judge-b", role: "semantic_judge", targetRecordId: recordId, targetProjectionId: projectionId, priorLifecycleEventIds });
    const adjudicator = judgmentAttempt({
      label: "adjudicator",
      role: "adjudicator",
      targetRecordId: recordId,
      targetProjectionId: projectionId,
      parentAttemptIds: [judgeA.attemptId, judgeB.attemptId],
      priorLifecycleEventIds,
    });
    const invalidated = createLifecycleEvent({
      recordId,
      judgedProjectionId: projectionId,
      state: "invalidated",
      basis: "dual_judge_adjudication",
      semanticJudgeAttemptIds: [judgeA.attemptId, judgeB.attemptId],
      adjudicatorAttemptId: adjudicator.attemptId,
      replacementRecordIds: [replacementId],
      priorLifecycleEventIds,
      detail: "fixture adjudication",
    });
    const record = {
      schemaVersion: 2 as const,
      recordKind: "claim" as const,
      discourseContext: { frame: "actual_report" as const, commitment: "asserted" as const, parentScopeSelectorId: null },
      predicate: { surface: "fixture", normalized: null },
      arguments: [],
      stance: {
        sourceSpeakerRole: "user" as const, sourceSpeakerSurface: null, reportedSpeakerMentionId: null,
        speechAct: "assertion" as const, polarity: "positive" as const, modalForce: "actual" as const,
        eventStatus: "completed" as const, adoption: "not_applicable" as const, speakerCertainty: "certain" as const,
      },
      temporal: {
        assertionTime: { raw: null, precision: "unknown" as const, source: "host_metadata" as const },
        sessionOrdinal: 0, turnOrdinal: 0, validTimes: [],
      },
      claimSelectorIds: [`selector_${"e".repeat(64)}`],
    };
    const projections = [{
      schemaVersion: 2 as const, projectionId, recordId, projectionKind: "base" as const,
      baseProjectionId: null, rendererVersion: "fixture", confirmedResolutionIds: [], canonicalText: "fixture",
    }, {
      schemaVersion: 2 as const, projectionId: replacementProjectionId, recordId: replacementId, projectionKind: "base" as const,
      baseProjectionId: null, rendererVersion: "fixture", confirmedResolutionIds: [], canonicalText: "replacement",
    }];
    expect(() => validateLifecycleLineage({
      events: [accepted, invalidated],
      attempts: [judgeA, judgeB, adjudicator],
      records: [{ ...record, recordId }, { ...record, recordId: replacementId }],
      projections,
    })).not.toThrow();

    const wrongTargetJudge = judgmentAttempt({
      label: "wrong-target",
      role: "semantic_judge",
      targetRecordId: replacementId,
      targetProjectionId: replacementProjectionId,
      priorLifecycleEventIds,
    });
    const wrongAdjudicator = judgmentAttempt({
      label: "wrong-adjudicator",
      role: "adjudicator",
      targetRecordId: recordId,
      targetProjectionId: projectionId,
      parentAttemptIds: [wrongTargetJudge.attemptId, judgeB.attemptId],
      priorLifecycleEventIds,
    });
    const invalidEvent = createLifecycleEvent({
      recordId,
      judgedProjectionId: projectionId,
      state: "invalidated",
      basis: "dual_judge_adjudication",
      semanticJudgeAttemptIds: [wrongTargetJudge.attemptId, judgeB.attemptId],
      adjudicatorAttemptId: wrongAdjudicator.attemptId,
      replacementRecordIds: [replacementId],
      priorLifecycleEventIds,
      detail: "invalid target binding fixture",
    });
    expect(() => validateLifecycleLineage({
      events: [accepted, invalidEvent], attempts: [wrongTargetJudge, judgeB, wrongAdjudicator], records: [{ ...record, recordId }, { ...record, recordId: replacementId }], projections,
    })).toThrow(/wrong record|not bound/);

    const truncatedJudge = judgmentAttempt({
      label: "truncated",
      role: "semantic_judge",
      targetRecordId: recordId,
      targetProjectionId: projectionId,
      outputComplete: false,
      priorLifecycleEventIds,
    });
    const truncatedAdjudicator = judgmentAttempt({
      label: "truncated-adjudicator",
      role: "adjudicator",
      targetRecordId: recordId,
      targetProjectionId: projectionId,
      parentAttemptIds: [truncatedJudge.attemptId, judgeB.attemptId],
      priorLifecycleEventIds,
    });
    const truncatedEvent = createLifecycleEvent({
      recordId,
      judgedProjectionId: projectionId,
      state: "invalidated",
      basis: "dual_judge_adjudication",
      semanticJudgeAttemptIds: [truncatedJudge.attemptId, judgeB.attemptId],
      adjudicatorAttemptId: truncatedAdjudicator.attemptId,
      replacementRecordIds: [replacementId],
      priorLifecycleEventIds,
      detail: "truncated judgment fixture",
    });
    expect(() => validateLifecycleLineage({
      events: [accepted, truncatedEvent],
      attempts: [truncatedJudge, judgeB, truncatedAdjudicator],
      records: [{ ...record, recordId }, { ...record, recordId: replacementId }],
      projections,
    })).toThrow(/output is incomplete/);
  });
});
