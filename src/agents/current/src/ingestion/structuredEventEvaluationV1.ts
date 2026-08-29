import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { getEncoding } from "js-tiktoken";
import { z } from "zod";

import {
  BlockIdSchema,
  ItemIdSchema,
  LinkIdSchema,
  ProjectionIdSchema,
  RawLexicalPostingSchema,
  RecordIdSchema,
  Sha256Schema,
  canonicalJson,
  type AssistantBlockProjection,
  type CoverageRow,
  type JsonValue,
  type RawLexicalPosting,
  type SemanticProjection,
  type SemanticRecord,
  type SupportBinding,
} from "./structuredEventSchemaV1.js";

const O200K = getEncoding("o200k_base");

/** Include field-level bindings when proving the source occurrence of a record. */
export function recordProvenanceSelectorIds(
  record: SemanticRecord,
  supportBindings: readonly SupportBinding[],
): string[] {
  return [...new Set([
    ...record.claimSelectorIds,
    ...supportBindings
      .filter((binding) => binding.targetObjectType === "record" && binding.targetObjectId === record.recordId)
      .flatMap((binding) => binding.selectorIds),
  ])].sort();
}

export const ObligationTypeSchema = z.enum([
  "direct_semantic",
  "compact_route",
  "operand",
  "asserted_relation",
  "derived_relation",
  "typed_link",
  "answer_only",
]);

export const EligiblePlaneSchema = z.enum([
  "semantic_record",
  "assistant_block",
  "semantic_operand",
  "typed_link",
  "answer_stage",
  "none",
]);

export const EvaluationStageSchema = z.enum(["semantic_ingestion", "link_overlay", "answer_stage"]);
export const ScoringDenominatorSchema = z.enum([
  "direct_semantic",
  "compact_route",
  "operand",
  "asserted_relation",
  "typed_link",
  "not_scored",
]);

export const TypedObligationSchema = z.strictObject({
  obligationId: z.string().regex(/^[a-zA-Z0-9._:-]+$/),
  storyId: z.string().regex(/^[a-zA-Z0-9._:-]+$/),
  obligationType: ObligationTypeSchema,
  eligiblePlane: EligiblePlaneSchema,
  stage: EvaluationStageSchema,
  denominatorName: ScoringDenominatorSchema,
  description: z.string().min(1).max(4_000),
  satisfactionRule: z.string().min(1).max(4_000),
  sourceSelectorIds: z.array(z.string().regex(/^selector_[a-f0-9]{64}$/)).max(32),
  criticality: z.enum(["critical", "standard"]),
  stratum: z.string().min(1).max(200),
}).superRefine((value, ctx) => {
  const expected: Record<z.infer<typeof ObligationTypeSchema>, z.infer<typeof EligiblePlaneSchema>> = {
    direct_semantic: "semantic_record",
    compact_route: "assistant_block",
    operand: "semantic_operand",
    asserted_relation: "semantic_record",
    derived_relation: "none",
    typed_link: "typed_link",
    answer_only: "answer_stage",
  };
  const expectedStage: Record<z.infer<typeof ObligationTypeSchema>, z.infer<typeof EvaluationStageSchema>> = {
    direct_semantic: "semantic_ingestion",
    compact_route: "semantic_ingestion",
    operand: "semantic_ingestion",
    asserted_relation: "semantic_ingestion",
    derived_relation: "answer_stage",
    typed_link: "link_overlay",
    answer_only: "answer_stage",
  };
  const expectedDenominator: Record<z.infer<typeof ObligationTypeSchema>, z.infer<typeof ScoringDenominatorSchema>> = {
    direct_semantic: "direct_semantic",
    compact_route: "compact_route",
    operand: "operand",
    asserted_relation: "asserted_relation",
    derived_relation: "not_scored",
    typed_link: "typed_link",
    answer_only: "not_scored",
  };
  if (value.eligiblePlane !== expected[value.obligationType]) {
    ctx.addIssue({
      code: "custom",
      message: `${value.obligationType} must use ${expected[value.obligationType]} plane`,
    });
  }
  if (value.stage !== expectedStage[value.obligationType]) {
    ctx.addIssue({ code: "custom", message: `${value.obligationType} must use ${expectedStage[value.obligationType]} stage` });
  }
  if (value.denominatorName !== expectedDenominator[value.obligationType]) {
    ctx.addIssue({
      code: "custom",
      message: `${value.obligationType} must declare ${expectedDenominator[value.obligationType]} denominator`,
    });
  }
  if (
    ["direct_semantic", "compact_route", "operand", "asserted_relation"].includes(value.obligationType)
    && value.sourceSelectorIds.length === 0
  ) {
    ctx.addIssue({ code: "custom", message: `${value.obligationType} requires at least one certified source selector` });
  }
});
export type TypedObligation = z.infer<typeof TypedObligationSchema>;

export const ExactGateDenominatorSchema = z.enum([
  "direct_semantic",
  "compact_route",
  "operand",
  "asserted_relation",
  "typed_link",
  "source_occurrence",
  "semantic_story_complete",
  "link_story_complete",
]);

export const ExactGateSchema = z.strictObject({
  denominatorName: ExactGateDenominatorSchema,
  criticality: z.enum(["critical", "standard"]).nullable(),
  stratum: z.string().min(1).max(200).nullable(),
  numeratorRequired: z.number().int().nonnegative(),
  denominator: z.number().int().positive(),
}).superRefine((value, ctx) => {
  if ((value.criticality === null) !== (value.stratum === null)) {
    ctx.addIssue({ code: "custom", message: "exact gate criticality and stratum must both be scoped or both be null" });
  }
  if (value.numeratorRequired > value.denominator) {
    ctx.addIssue({ code: "custom", message: "exact gate numerator cannot exceed its denominator" });
  }
});
export type ExactGate = z.infer<typeof ExactGateSchema>;

export function exactGateKey(value: Pick<ExactGate, "denominatorName" | "criticality" | "stratum">): string {
  return [value.denominatorName, value.criticality ?? "__all__", value.stratum ?? "__all__"].join("|");
}

export const PrecisionPolicySchema = z.strictObject({
  samplingMode: z.literal("bounded_cohort_census"),
  denominatorBasis: z.literal("frozen_active_population"),
  minimumSupportedRatio: z.number().min(0.99).max(1),
  requireAllCriticalSupported: z.literal(true),
});
export type PrecisionPolicy = z.infer<typeof PrecisionPolicySchema>;

export const ObligationManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  role: z.enum(["development_falsification", "custodian_sealed_certification"]),
  cohortHash: Sha256Schema,
  obligations: z.array(TypedObligationSchema).min(1),
  exactGates: z.array(ExactGateSchema).min(1),
  precisionPolicy: PrecisionPolicySchema,
}).superRefine((value, ctx) => {
  const obligationIds = value.obligations.map((obligation) => obligation.obligationId);
  if (new Set(obligationIds).size !== obligationIds.length) {
    ctx.addIssue({ code: "custom", message: "obligation IDs must be unique" });
  }
  const gateKeys = value.exactGates.map(exactGateKey);
  if (new Set(gateKeys).size !== gateKeys.length) {
    ctx.addIssue({ code: "custom", message: "exact gate scopes must be unique" });
  }
  const requiredGlobal = new Set<string>();
  const semanticTypes = new Set(["direct_semantic", "compact_route", "operand", "asserted_relation"]);
  if (value.obligations.some((obligation) => semanticTypes.has(obligation.obligationType))) {
    requiredGlobal.add("semantic_story_complete");
  }
  if (value.obligations.some((obligation) => obligation.obligationType === "typed_link")) {
    requiredGlobal.add("link_story_complete");
  }
  for (const gateName of requiredGlobal) {
    if (!value.exactGates.some((gate) =>
      gate.denominatorName === gateName && gate.criticality === null && gate.stratum === null)) {
      ctx.addIssue({ code: "custom", message: `missing mandatory global exact gate ${gateName}` });
    }
  }
  const declaredTotals = new Map<string, number>();
  for (const obligation of value.obligations) {
    if (obligation.denominatorName === "not_scored") continue;
    const key = exactGateKey(obligation);
    declaredTotals.set(key, (declaredTotals.get(key) ?? 0) + 1);
    if (obligation.sourceSelectorIds.length > 0) {
      const sourceKey = exactGateKey({
        denominatorName: "source_occurrence",
        criticality: obligation.criticality,
        stratum: obligation.stratum,
      });
      declaredTotals.set(sourceKey, (declaredTotals.get(sourceKey) ?? 0) + 1);
    }
  }
  const semanticStories = new Set(value.obligations
    .filter((obligation) => obligation.stage === "semantic_ingestion")
    .map((obligation) => obligation.storyId)).size;
  const linkStories = new Set(value.obligations
    .filter((obligation) => obligation.stage === "link_overlay")
    .map((obligation) => obligation.storyId)).size;
  declaredTotals.set(exactGateKey({ denominatorName: "semantic_story_complete", criticality: null, stratum: null }), semanticStories);
  declaredTotals.set(exactGateKey({ denominatorName: "link_story_complete", criticality: null, stratum: null }), linkStories);
  for (const gate of value.exactGates) {
    const total = declaredTotals.get(exactGateKey(gate));
    if (total !== undefined && total !== gate.denominator) {
      ctx.addIssue({
        code: "custom",
        message: `gate ${gate.denominatorName} denominator ${String(gate.denominator)} does not match ${String(total)} declared obligations/stories`,
      });
    }
    const minimumRequired = gate.criticality === "critical"
      || gate.denominatorName === "operand"
      || gate.denominatorName === "source_occurrence"
      ? gate.denominator
      : gate.denominatorName === "direct_semantic" || gate.denominatorName === "compact_route"
        ? Math.ceil(gate.denominator * 0.95)
        : gate.denominatorName === "semantic_story_complete"
          ? Math.ceil(gate.denominator * 0.85)
          : 0;
    if (gate.numeratorRequired < minimumRequired) {
      ctx.addIssue({
        code: "custom",
        message: `gate ${exactGateKey(gate)} is below the published minimum ${String(minimumRequired)}/${String(gate.denominator)}`,
      });
    }
  }
  for (const [key, total] of declaredTotals) {
    if (total > 0 && !value.exactGates.some((gate) => exactGateKey(gate) === key)) {
      ctx.addIssue({ code: "custom", message: `missing mandatory exact gate cell ${key}` });
    }
  }
});

export const DiscoveryEvidenceSchema = z.strictObject({
  obligationId: z.string().min(1),
  eligibleObjectIds: z.array(z.union([
    RecordIdSchema,
    BlockIdSchema,
    ItemIdSchema,
    LinkIdSchema,
  ])),
  discoveredObjectIds: z.array(z.union([
    RecordIdSchema,
    BlockIdSchema,
    ItemIdSchema,
    LinkIdSchema,
  ])),
  exhaustivelyScannedObjectIds: z.array(z.union([
    RecordIdSchema,
    BlockIdSchema,
    ItemIdSchema,
    LinkIdSchema,
  ])),
  validatedDiscoveryRecallBound: z.number().min(0).max(1).nullable(),
});
export type DiscoveryEvidence = z.infer<typeof DiscoveryEvidenceSchema>;

export const EntailmentJudgmentSchema = z.strictObject({
  obligationId: z.string().min(1),
  entailed: z.boolean(),
  coveringObjectIds: z.array(z.string().min(1)),
  missingDetails: z.array(z.string().min(1)).max(32),
});
export type EntailmentJudgment = z.infer<typeof EntailmentJudgmentSchema>;

/** Rejects invented or nested IDs before a judgment can enter evaluation. */
export function validateEntailmentJudgmentCitations(args: {
  judgment: EntailmentJudgment;
  obligationId: string;
  eligibleObjectIds: ReadonlySet<string>;
}): EntailmentJudgment {
  const judgment = EntailmentJudgmentSchema.parse(args.judgment);
  if (judgment.obligationId !== args.obligationId) {
    throw new Error(`entailment batch omitted ${args.obligationId}`);
  }
  if (judgment.coveringObjectIds.some((id) => !args.eligibleObjectIds.has(id))) {
    throw new Error(`entailment judge cited an object outside its batch for ${args.obligationId}`);
  }
  return judgment;
}

export const SupportJudgmentSchema = z.strictObject({
  objectId: z.string().min(1),
  supported: z.boolean(),
  criticalError: z.boolean(),
  unsupportedFields: z.array(z.string().min(1)).max(64),
  reason: z.string().min(1).max(4_000),
});
export type SupportJudgment = z.infer<typeof SupportJudgmentSchema>;

function isUniqueSingleCharacterCopyError(returnedId: string, expectedId: string): boolean {
  if (returnedId === expectedId || Math.abs(returnedId.length - expectedId.length) > 1) return false;
  if (returnedId.length === expectedId.length) {
    let differences = 0;
    for (let index = 0; index < returnedId.length; index += 1) {
      if (returnedId[index] !== expectedId[index]) differences += 1;
      if (differences > 1) return false;
    }
    return differences === 1;
  }
  const shorter = returnedId.length < expectedId.length ? returnedId : expectedId;
  const longer = returnedId.length < expectedId.length ? expectedId : returnedId;
  let shortIndex = 0;
  let longIndex = 0;
  let skipped = false;
  while (shortIndex < shorter.length && longIndex < longer.length) {
    if (shorter[shortIndex] === longer[longIndex]) {
      shortIndex += 1;
      longIndex += 1;
    } else if (!skipped) {
      skipped = true;
      longIndex += 1;
    } else {
      return false;
    }
  }
  return true;
}

/** Rebinds only a unique one-character model copy error to a host-owned object ID. */
export function bindSupportJudgmentsToExpectedIds(args: {
  judgments: readonly SupportJudgment[];
  expectedObjectIds: readonly string[];
}): SupportJudgment[] {
  const judgments = args.judgments.map((value) => SupportJudgmentSchema.parse(value));
  const expected = new Set(args.expectedObjectIds);
  const exactReturned = new Set(judgments
    .map((value) => value.objectId)
    .filter((objectId) => expected.has(objectId)));
  const bound = new Set(exactReturned);
  return judgments.map((judgment) => {
    if (expected.has(judgment.objectId)) return judgment;
    const candidates = args.expectedObjectIds.filter((candidate) =>
      !bound.has(candidate) && isUniqueSingleCharacterCopyError(judgment.objectId, candidate));
    if (candidates.length !== 1) return judgment;
    const objectId = candidates[0]!;
    bound.add(objectId);
    return SupportJudgmentSchema.parse({ ...judgment, objectId });
  });
}

/** Rejects missing, duplicated, or invented IDs before support judgments can enter evaluation. */
export function validateSupportJudgmentBatchCompleteness(args: {
  judgments: readonly SupportJudgment[];
  expectedObjectIds: readonly string[];
}): SupportJudgment[] {
  const judgments = args.judgments.map((value) => SupportJudgmentSchema.parse(value));
  const expected = new Set(args.expectedObjectIds);
  if (expected.size !== args.expectedObjectIds.length) {
    throw new Error("support judge input contains duplicate object IDs");
  }
  const returnedIds = judgments.map((value) => value.objectId);
  const returned = new Set(returnedIds);
  const missing = args.expectedObjectIds.filter((id) => !returned.has(id));
  const extra = returnedIds.filter((id) => !expected.has(id));
  const duplicated = returnedIds.filter((id, index) => returnedIds.indexOf(id) !== index);
  if (
    judgments.length !== expected.size
    || returned.size !== expected.size
    || missing.length > 0
    || extra.length > 0
    || duplicated.length > 0
  ) {
    throw new Error([
      "support judge did not return exactly one judgment for every requested object",
      `missing=${JSON.stringify(missing)}`,
      `extra=${JSON.stringify(extra)}`,
      `duplicated=${JSON.stringify([...new Set(duplicated)])}`,
    ].join("; "));
  }
  return judgments;
}

/** A positive entailment is usable only when every cited representation passed independent source-support review. */
export function enforceSupportedEntailments(args: {
  judgments: readonly EntailmentJudgment[];
  supportJudgments: readonly SupportJudgment[];
}): EntailmentJudgment[] {
  const supportByObject = new Map(args.supportJudgments.map((value) => {
    const judgment = SupportJudgmentSchema.parse(value);
    return [judgment.objectId, judgment] as const;
  }));
  return args.judgments.map((judgmentValue) => {
    const judgment = EntailmentJudgmentSchema.parse(judgmentValue);
    if (!judgment.entailed) return judgment;
    const supported = judgment.coveringObjectIds.length > 0 && judgment.coveringObjectIds.every((objectId) => {
      const support = supportByObject.get(objectId);
      return support?.supported === true && support.criticalError === false;
    });
    return EntailmentJudgmentSchema.parse({
      ...judgment,
      entailed: supported,
      missingDetails: supported
        ? judgment.missingDetails
        : [...new Set([
          ...judgment.missingDetails,
          "covering representation was not fully supported by its bound source",
        ])].slice(0, 32),
    });
  });
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

/** Negative semantic availability is valid only after an exhaustive eligible-plane scan or frozen bound. */
export function validateDiscoveryNegative(
  obligationValue: TypedObligation,
  discoveryValue: DiscoveryEvidence,
  judgmentValue: EntailmentJudgment,
): void {
  const obligation = TypedObligationSchema.parse(obligationValue);
  const discovery = DiscoveryEvidenceSchema.parse(discoveryValue);
  const judgment = EntailmentJudgmentSchema.parse(judgmentValue);
  if (obligation.obligationId !== discovery.obligationId || obligation.obligationId !== judgment.obligationId) {
    throw new Error("obligation/discovery/judgment ID mismatch");
  }
  if (judgment.entailed) return;
  if (obligation.obligationType === "derived_relation" || obligation.obligationType === "answer_only") return;
  const exhaustive = sameSet(discovery.eligibleObjectIds, discovery.exhaustivelyScannedObjectIds);
  const validatedBound = (discovery.validatedDiscoveryRecallBound ?? 0) >= 0.99;
  if (!exhaustive && !validatedBound) {
    throw new Error(
      `negative ${obligation.obligationId} is not an ingestion loss: eligible plane was not exhaustively scanned`,
    );
  }
}

export type TypedEvaluationSummary = {
  denominators: Record<string, { covered: number; total: number; ratio: number | null }>;
  semanticStories: { complete: number; total: number; completeStoryIds: string[] };
  linkStories: { complete: number; total: number; completeStoryIds: string[] };
  combinedReadyStories: { complete: number; total: number; completeStoryIds: string[] };
};

function denominatorKey(obligation: TypedObligation): string | null {
  return obligation.denominatorName === "not_scored" ? null : obligation.denominatorName;
}

export function summarizeTypedEvaluation(args: {
  obligations: readonly TypedObligation[];
  discoveries: readonly DiscoveryEvidence[];
  judgments: readonly EntailmentJudgment[];
}): TypedEvaluationSummary {
  const obligations = args.obligations.map((value) => TypedObligationSchema.parse(value));
  const discoveries = new Map(args.discoveries.map((value) => {
    const parsed = DiscoveryEvidenceSchema.parse(value);
    return [parsed.obligationId, parsed];
  }));
  const judgments = new Map(args.judgments.map((value) => {
    const parsed = EntailmentJudgmentSchema.parse(value);
    return [parsed.obligationId, parsed];
  }));
  const counts = new Map<string, { covered: number; total: number }>([
    ["direct_semantic", { covered: 0, total: 0 }],
    ["compact_route", { covered: 0, total: 0 }],
    ["operand", { covered: 0, total: 0 }],
    ["asserted_relation", { covered: 0, total: 0 }],
    ["typed_link", { covered: 0, total: 0 }],
  ]);
  const semanticByStory = new Map<string, boolean[]>();
  const linkByStory = new Map<string, boolean[]>();
  for (const obligation of obligations) {
    const judgment = judgments.get(obligation.obligationId);
    if (!judgment) throw new Error(`missing judgment ${obligation.obligationId}`);
    const discovery = discoveries.get(obligation.obligationId);
    if (discovery) validateDiscoveryNegative(obligation, discovery, judgment);
    const key = denominatorKey(obligation);
    if (key) {
      const prior = counts.get(key) ?? { covered: 0, total: 0 };
      prior.total += 1;
      if (judgment.entailed) prior.covered += 1;
      counts.set(key, prior);
    }
    if (["direct_semantic", "compact_route", "operand", "asserted_relation"].includes(obligation.obligationType)) {
      const values = semanticByStory.get(obligation.storyId) ?? [];
      values.push(judgment.entailed);
      semanticByStory.set(obligation.storyId, values);
    }
    if (obligation.obligationType === "typed_link") {
      const values = linkByStory.get(obligation.storyId) ?? [];
      values.push(judgment.entailed);
      linkByStory.set(obligation.storyId, values);
    }
  }
  const completeIds = (map: ReadonlyMap<string, boolean[]>): string[] => [...map]
    .filter(([, values]) => values.length > 0 && values.every(Boolean))
    .map(([storyId]) => storyId)
    .sort();
  const semanticComplete = completeIds(semanticByStory);
  const linkComplete = completeIds(linkByStory);
  const combinedUniverse = [...semanticByStory.keys()]
    .filter((storyId) => linkByStory.has(storyId))
    .sort();
  const combined = combinedUniverse.filter((storyId) => {
    const semantic = semanticByStory.get(storyId);
    const links = linkByStory.get(storyId);
    return semantic !== undefined && links !== undefined && semantic.every(Boolean) && links.every(Boolean);
  });
  return {
    denominators: Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)).map(
      ([key, value]) => [key, {
        ...value,
        ratio: value.total === 0 ? null : value.covered / value.total,
      }],
    )),
    semanticStories: {
      complete: semanticComplete.length,
      total: semanticByStory.size,
      completeStoryIds: semanticComplete,
    },
    linkStories: {
      complete: linkComplete.length,
      total: linkByStory.size,
      completeStoryIds: linkComplete,
    },
    combinedReadyStories: {
      complete: combined.length,
      total: combinedUniverse.length,
      completeStoryIds: combined,
    },
  };
}

export const PrecisionPopulationRowSchema = z.strictObject({
  objectId: z.string().min(1),
  clusterId: z.string().min(1),
  sourceRole: z.enum(["user", "assistant", "mixed"]),
  plane: z.enum(["semantic_record", "assistant_block", "typed_link"]),
  speechAct: z.string().min(1),
  discourseFrame: z.string().min(1),
  usesResolution: z.boolean(),
  confidenceLevels: z.array(z.enum(["high", "medium", "low", "unknown"])).min(1).max(4),
  listLengthBucket: z.enum(["none", "short", "long"]),
  objectKind: z.string().min(1),
  critical: z.boolean(),
});

function sampleRank(seed: string, objectId: string): string {
  return createHash("sha256").update(`${seed}\0${objectId}`).digest("hex");
}

export function precisionStratumKey(rowValue: z.infer<typeof PrecisionPopulationRowSchema>): string {
  const row = PrecisionPopulationRowSchema.parse(rowValue);
  return [
    row.sourceRole,
    row.plane,
    row.speechAct,
    row.discourseFrame,
    String(row.usesResolution),
    [...new Set(row.confidenceLevels)].sort().join(","),
    row.listLengthBucket,
    row.objectKind,
  ].join("|");
}

/** Deterministic question-independent sample; every critical row is always included. */
export function stratifiedPrecisionSample(args: {
  population: Array<z.infer<typeof PrecisionPopulationRowSchema>>;
  seed: string;
  targetNonCritical: number;
}): Array<z.infer<typeof PrecisionPopulationRowSchema>> {
  const population = args.population.map((value) => PrecisionPopulationRowSchema.parse(value));
  const critical = population.filter((row) => row.critical);
  const nonCritical = population.filter((row) => !row.critical);
  const strata = new Map<string, typeof nonCritical>();
  for (const row of nonCritical) {
    const key = precisionStratumKey(row);
    const values = strata.get(key) ?? [];
    values.push(row);
    strata.set(key, values);
  }
  const selected: typeof nonCritical = [];
  const orderedStrata = [...strata.entries()].sort(([left], [right]) => left.localeCompare(right));
  let cursor = 0;
  while (selected.length < Math.min(args.targetNonCritical, nonCritical.length) && orderedStrata.length > 0) {
    const [key, values] = orderedStrata[cursor % orderedStrata.length] ?? ["", []];
    values.sort((left, right) => {
      const leftRank = sampleRank(`${args.seed}\0${key}`, left.objectId);
      const rightRank = sampleRank(`${args.seed}\0${key}`, right.objectId);
      return leftRank < rightRank ? -1 : leftRank > rightRank ? 1 : 0;
    });
    const next = values.shift();
    if (next) selected.push(next);
    if (values.length === 0) {
      const index = orderedStrata.findIndex(([candidate]) => candidate === key);
      if (index >= 0) orderedStrata.splice(index, 1);
    } else cursor += 1;
  }
  return [...new Map([...critical, ...selected].map((row) => [row.objectId, row])).values()]
    .sort((left, right) => Buffer.compare(Buffer.from(left.objectId), Buffer.from(right.objectId)));
}

/** Conservative one-sided 95% binomial lower bound for reporting. */
export function oneSidedPrecisionLowerBound95(successes: number, total: number): number | null {
  if (!Number.isInteger(successes) || !Number.isInteger(total) || successes < 0 || total < 0 || successes > total) {
    throw new Error("precision bound requires valid integer counts");
  }
  if (total === 0) return null;
  if (successes === total) return Math.pow(0.05, 1 / total);
  const z = 1.6448536269514722;
  const proportion = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = proportion + (z * z) / (2 * total);
  const radius = z * Math.sqrt((proportion * (1 - proportion) + (z * z) / (4 * total)) / total);
  return Math.max(0, (centre - radius) / denominator);
}

export function precisionGateDecision(args: {
  role: "development_falsification" | "custodian_sealed_certification";
  supported: number;
  total: number;
  criticalSupported: number;
  criticalTotal: number;
  isCensus: boolean;
  minimumSupportedRatio: number;
  requireAllCriticalSupported: boolean;
}): {
  status: "not_evaluable" | "incomplete_census" | "population_inference_unavailable" | "passed" | "failed";
  populationClaimAllowed: false;
  passed: boolean;
} {
  if (
    !Number.isInteger(args.supported)
    || !Number.isInteger(args.total)
    || !Number.isInteger(args.criticalSupported)
    || !Number.isInteger(args.criticalTotal)
    || args.supported < 0
    || args.total < args.supported
    || args.criticalSupported < 0
    || args.criticalTotal < args.criticalSupported
    || args.criticalTotal > args.total
    || args.criticalSupported > args.supported
    || !Number.isFinite(args.minimumSupportedRatio)
    || args.minimumSupportedRatio < 0.99
    || args.minimumSupportedRatio > 1
    || args.requireAllCriticalSupported !== true
  ) throw new Error("precision gate counts are invalid");
  if (args.total === 0 || args.criticalTotal === 0) {
    return { status: "not_evaluable", populationClaimAllowed: false, passed: false };
  }
  if (!args.isCensus) return { status: "incomplete_census", populationClaimAllowed: false, passed: false };
  if (args.role === "custodian_sealed_certification") {
    return { status: "population_inference_unavailable", populationClaimAllowed: false, passed: false };
  }
  const passed = args.supported / args.total >= args.minimumSupportedRatio
    && (!args.requireAllCriticalSupported || args.criticalSupported === args.criticalTotal);
  return { status: passed ? "passed" : "failed", populationClaimAllowed: false, passed };
}

export const FrozenArtifactSchema = z.strictObject({
  path: z.string().min(1),
  sha256: Sha256Schema,
  byteLength: z.number().int().nonnegative(),
});

export const SemanticFreezeManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.literal("complete"),
  specificationSha256: Sha256Schema,
  codeSha256: Sha256Schema,
  schemaSha256: Sha256Schema,
  configurationSha256: Sha256Schema,
  promptSha256s: z.array(Sha256Schema),
  artifacts: z.array(FrozenArtifactSchema).min(1),
  createdAt: z.string().min(1),
  questionBlind: z.literal(true),
});
export type SemanticFreezeManifest = z.infer<typeof SemanticFreezeManifestSchema>;

export const LinkFreezeManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.literal("complete"),
  semanticFreezeSha256: Sha256Schema,
  linkerPromptSha256: Sha256Schema,
  artifacts: z.array(FrozenArtifactSchema).min(1),
  createdAt: z.string().min(1),
  questionBlind: z.literal(true),
});
export type LinkFreezeManifest = z.infer<typeof LinkFreezeManifestSchema>;

export const CostSnapshotSchema = z.strictObject({
  ceiling_usd: z.number().positive(),
  spent_usd: z.number().nonnegative(),
  reserved_usd: z.number().nonnegative(),
  remaining_usd: z.number().nonnegative(),
});
export type CostSnapshot = z.infer<typeof CostSnapshotSchema>;

function fileHash(path: string): { sha256: string; byteLength: number } {
  const value = readFileSync(path);
  return { sha256: createHash("sha256").update(value).digest("hex"), byteLength: value.length };
}

export function verifyFrozenArtifacts(manifestValue: SemanticFreezeManifest | LinkFreezeManifest): void {
  const manifest = "specificationSha256" in manifestValue
    ? SemanticFreezeManifestSchema.parse(manifestValue)
    : LinkFreezeManifestSchema.parse(manifestValue);
  for (const artifact of manifest.artifacts) {
    const actual = fileHash(artifact.path);
    if (actual.sha256 !== artifact.sha256 || actual.byteLength !== artifact.byteLength) {
      throw new Error(`frozen artifact mismatch ${artifact.path}`);
    }
  }
}

/** Opens cost only from the already-frozen link manifest and requires a fully settled approved ceiling. */
export function readFrozenSettledCost(args: {
  artifactPath: string;
  linkFreeze: LinkFreezeManifest;
  approvedCeilingUsd: number;
}): CostSnapshot {
  const manifest = LinkFreezeManifestSchema.parse(args.linkFreeze);
  const frozen = manifest.artifacts.find((artifact) => artifact.path === args.artifactPath);
  if (!frozen) throw new Error("semantic-plus-link cost artifact is not present in the link freeze");
  const actual = fileHash(args.artifactPath);
  if (actual.sha256 !== frozen.sha256 || actual.byteLength !== frozen.byteLength) {
    throw new Error("frozen semantic-plus-link cost artifact does not match its manifest");
  }
  const rawSnapshot = JSON.parse(readFileSync(args.artifactPath, "utf8")) as Record<string, unknown>;
  // IEEE-754 settlement can leave a signed epsilon after all reservations are
  // released. It is exactly zero for budget purposes, not outstanding spend.
  const rawReserved = rawSnapshot.reserved_usd;
  const snapshot = CostSnapshotSchema.parse({
    ...rawSnapshot,
    reserved_usd: typeof rawReserved === "number" && Math.abs(rawReserved) < 1e-12 ? 0 : rawReserved,
  });
  if (snapshot.ceiling_usd !== args.approvedCeilingUsd || snapshot.reserved_usd !== 0) {
    throw new Error("frozen semantic-plus-link cost does not match the approved settled budget");
  }
  return snapshot;
}

export function semanticProjectionTokenMetrics(args: {
  records: readonly SemanticRecord[];
  semantic: readonly SemanticProjection[];
  blocks: readonly AssistantBlockProjection[];
  rawLexicalPostings: readonly RawLexicalPosting[];
  coverageRows: readonly CoverageRow[];
  rawTokenCount: number;
  rawRecoverableTurnCount: number;
  provenanceStorageByteCount: number;
  quarantineBacklogCount: number;
}): {
  tokenizer: "o200k_base";
  tokenizerImplementation: "js-tiktoken@1.0.21";
  serializationVersion: "beam-semantic-projection-count-v2";
  rawSerializationVersion: "beam-raw-lexical-posting-canonical-jsonl-v1";
  fieldAllowlist: string[];
  semanticProjectionTokens: number;
  rawLexicalIndexTokens: number;
  rawTokenCount: number;
  fractionOfRaw: number | null;
  storage: {
    provenanceStorageByteCount: number;
    rawLexicalPostingCount: number;
  };
  roleDistribution: {
    recordCountsBySourceRole: Record<string, number>;
    semanticProjectionTokensBySourceRole: Record<string, number>;
    semanticProjectionTokensBySpeechAct: Record<string, number>;
    searchableTokensByPlane: Record<string, number>;
  };
  coverage: {
    rawRecoverableTurnCount: number;
    compactBlockCount: number;
    compactDiscoverability: {
      targetCount: number;
      indexedTargetCount: number;
      ratio: number | null;
    };
    rawOnlySegmentCount: number;
    quarantinedSegmentCount: number;
    quarantineBacklogCount: number;
  };
  deduplicationPolicy: string;
} {
  const semanticByRecord = new Map(args.semantic.map((projectionValue) => {
    const projection = SemanticProjectionSchemaForCount.parse(projectionValue);
    return [projection.recordId, projection] as const;
  }));
  const recordRows = args.records.flatMap((record) => {
    const projection = semanticByRecord.get(record.recordId);
    if (!projection) return [];
    return [{ record, tokens: O200K.encode(projection.canonicalText).length }];
  });
  const blockRows = args.blocks.map((projection) => ({
    projection,
    tokens: O200K.encode([
      projection.routingText,
      ...projection.routingTerms,
      ...Object.values(projection.itemRoutingTerms).flat(),
    ].join("\n")).length,
  }));
  const tokens = recordRows.reduce((sum, row) => sum + row.tokens, 0)
    + blockRows.reduce((sum, row) => sum + row.tokens, 0);
  const parsedPostings = args.rawLexicalPostings.map((posting) => RawLexicalPostingSchema.parse(posting));
  const rawLexicalIndexTokens = O200K.encode(parsedPostings
    .map((posting) => canonicalJson(posting as unknown as JsonValue))
    .join("\n")).length;
  const roleRows = [
    ...recordRows.map((row) => ({ sourceRole: row.record.stance.sourceSpeakerRole, tokens: row.tokens })),
    ...blockRows.map((row) => ({ sourceRole: "assistant", tokens: row.tokens })),
  ];
  const compactTargetIds = new Set(args.blocks.flatMap((projection) => [
    projection.blockId,
    ...Object.keys(projection.itemRoutingTerms),
  ]));
  const indexedCompactTargetIds = new Set(parsedPostings
    .map((posting) => posting.targetObjectId)
    .filter((targetId) => compactTargetIds.has(targetId)));
  const counts = <T>(values: readonly T[], key: (value: T) => string): Record<string, number> => {
    const output: Record<string, number> = {};
    for (const value of values) {
      const name = key(value);
      output[name] = (output[name] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(output).sort(([left], [right]) => left.localeCompare(right)));
  };
  const tokenSums = <T>(values: readonly T[], key: (value: T) => string, amount: (value: T) => number): Record<string, number> => {
    const output: Record<string, number> = {};
    for (const value of values) {
      const name = key(value);
      output[name] = (output[name] ?? 0) + amount(value);
    }
    return Object.fromEntries(Object.entries(output).sort(([left], [right]) => left.localeCompare(right)));
  };
  return {
    tokenizer: "o200k_base",
    tokenizerImplementation: "js-tiktoken@1.0.21",
    serializationVersion: "beam-semantic-projection-count-v2",
    rawSerializationVersion: "beam-raw-lexical-posting-canonical-jsonl-v1",
    fieldAllowlist: [
      "semantic_projection.canonicalText",
      "assistant_block_projection.routingText",
      "assistant_block_projection.routingTerms",
      "assistant_block_projection.itemRoutingTerms",
    ],
    semanticProjectionTokens: tokens,
    rawLexicalIndexTokens,
    rawTokenCount: args.rawTokenCount,
    fractionOfRaw: args.rawTokenCount === 0 ? null : tokens / args.rawTokenCount,
    storage: {
      provenanceStorageByteCount: args.provenanceStorageByteCount,
      rawLexicalPostingCount: args.rawLexicalPostings.length,
    },
    roleDistribution: {
      recordCountsBySourceRole: counts(args.records, (record) => record.stance.sourceSpeakerRole),
      semanticProjectionTokensBySourceRole: tokenSums(
        roleRows,
        (row) => row.sourceRole,
        (row) => row.tokens,
      ),
      semanticProjectionTokensBySpeechAct: tokenSums(
        recordRows,
        (row) => row.record.stance.speechAct,
        (row) => row.tokens,
      ),
      searchableTokensByPlane: {
        assistant_block: blockRows.reduce((sum, row) => sum + row.tokens, 0),
        semantic_record: recordRows.reduce((sum, row) => sum + row.tokens, 0),
      },
    },
    coverage: {
      rawRecoverableTurnCount: args.rawRecoverableTurnCount,
      compactBlockCount: args.blocks.length,
      compactDiscoverability: {
        targetCount: compactTargetIds.size,
        indexedTargetCount: indexedCompactTargetIds.size,
        ratio: compactTargetIds.size === 0 ? null : indexedCompactTargetIds.size / compactTargetIds.size,
      },
      rawOnlySegmentCount: args.coverageRows.filter((row) =>
        row.routeType === "no_semantic_content" || row.routeType === "quarantine").length,
      quarantinedSegmentCount: args.coverageRows.filter((row) => row.routeType === "quarantine").length,
      quarantineBacklogCount: args.quarantineBacklogCount,
    },
    deduplicationPolicy: "content-addressed object IDs; one canonical row per ID; raw lexical terms unique within each target posting",
  };
}

const SemanticProjectionSchemaForCount = z.strictObject({
  projectionId: ProjectionIdSchema,
  recordId: RecordIdSchema,
  canonicalText: z.string(),
}).passthrough();
