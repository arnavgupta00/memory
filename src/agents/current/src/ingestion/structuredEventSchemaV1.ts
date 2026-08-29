import { createHash } from "node:crypto";

import { z } from "zod";

export const STRUCTURED_EVENT_SCHEMA_VERSION = 2 as const;
export const BASE_RENDERER_VERSION = "beam-structured-event-search-v3" as const;
export const ASSISTANT_ROUTER_VERSION = "beam-assistant-block-router-v3" as const;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(JsonValueSchema),
  z.record(z.string(), JsonValueSchema),
]));

/**
 * OpenAI Structured Outputs cannot express arbitrary JSON object keys. Model
 * calls therefore use a fixed-shape, lossless entry-list encoding at the API
 * boundary. Host code decodes it back to ordinary JSON before identity,
 * materialization, projection, or evaluation logic sees the value.
 */
export type ModelJsonValue =
  | { kind: "null" }
  | { kind: "boolean"; booleanValue: boolean }
  | { kind: "number"; numberValue: number }
  | { kind: "string"; stringValue: string }
  | { kind: "array"; arrayValue: ModelJsonValue[] }
  | { kind: "object"; objectEntries: Array<{ key: string; value: ModelJsonValue }> };

export const ModelJsonValueSchema: z.ZodType<ModelJsonValue> = z.lazy(() => z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("null") }),
  z.strictObject({ kind: z.literal("boolean"), booleanValue: z.boolean() }),
  z.strictObject({ kind: z.literal("number"), numberValue: z.number().finite() }),
  z.strictObject({ kind: z.literal("string"), stringValue: z.string() }),
  z.strictObject({ kind: z.literal("array"), arrayValue: z.array(ModelJsonValueSchema) }),
  z.strictObject({
    kind: z.literal("object"),
    objectEntries: z.array(z.strictObject({ key: z.string(), value: ModelJsonValueSchema })),
  }),
]));

export function decodeModelJsonValue(value: ModelJsonValue): JsonValue {
  const parsed = ModelJsonValueSchema.parse(value);
  switch (parsed.kind) {
    case "null": return null;
    case "boolean": return parsed.booleanValue;
    case "number": return parsed.numberValue;
    case "string": return parsed.stringValue;
    case "array": return parsed.arrayValue.map(decodeModelJsonValue);
    case "object": {
      const keys = parsed.objectEntries.map((entry) => entry.key);
      if (new Set(keys).size !== keys.length) throw new Error("model JSON object contains duplicate keys");
      return Object.fromEntries(parsed.objectEntries.map((entry) => [entry.key, decodeModelJsonValue(entry.value)]));
    }
  }
}

export function encodeModelJsonValue(value: JsonValue): ModelJsonValue {
  const parsed = JsonValueSchema.parse(value);
  if (parsed === null) return { kind: "null" };
  if (typeof parsed === "boolean") return { kind: "boolean", booleanValue: parsed };
  if (typeof parsed === "number") return { kind: "number", numberValue: parsed };
  if (typeof parsed === "string") return { kind: "string", stringValue: parsed };
  if (Array.isArray(parsed)) return { kind: "array", arrayValue: parsed.map(encodeModelJsonValue) };
  return {
    kind: "object",
    objectEntries: Object.entries(parsed).map(([key, child]) => ({ key, value: encodeModelJsonValue(child) })),
  };
}

const SHA256_HEX = /^[a-f0-9]{64}$/;
export const Sha256Schema = z.string().regex(SHA256_HEX);

const id = (prefix: string): z.ZodString => z.string().regex(
  new RegExp(`^${prefix}_[a-f0-9]{64}$`),
);

export const RawTurnIdSchema = id("rawturn");
export const SelectorIdSchema = id("selector");
export const MetadataSelectorIdSchema = id("metadata");
export const SegmentIdSchema = id("segment");
export const MentionIdSchema = id("mention");
export const RecordIdSchema = id("record");
export const SupportBindingIdSchema = id("support");
export const ResolutionIdSchema = id("resolution");
export const ProjectionIdSchema = id("projection");
export const BlockIdSchema = id("block");
export const ItemIdSchema = id("item");
export const RawLexicalPostingIdSchema = id("lexical_posting");
export const LinkIdSchema = id("link");
export const LinkGenerationIdSchema = id("linkgen");
export const AttemptIdSchema = id("attempt");
export const AttemptResultIdSchema = id("attempt_result");
export const AttemptSupersessionIdSchema = id("supersession");
export const DerivationIdSchema = id("derivation");
export const QuarantineIdSchema = id("quarantine");
export const LifecycleEventIdSchema = id("lifecycle");

function canonicalObject(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON rejects non-finite numbers");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalObject).join(",")}]`;
  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalObject(child)}`).join(",")}}`;
}

/** Canonical JSON for the schema's JSON-only payloads. */
export function canonicalJson(value: JsonValue): string {
  return canonicalObject(JsonValueSchema.parse(value));
}

export function asciiIdSort(values: readonly string[]): string[] {
  return [...values].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

export function contentAddress(domain: string, payload: JsonValue): string {
  if (!/^[a-z0-9_.-]+$/.test(domain)) throw new Error(`invalid content-address domain ${domain}`);
  return createHash("sha256")
    .update(`${domain}\0${String(STRUCTURED_EVENT_SCHEMA_VERSION)}\0${canonicalJson(payload)}`)
    .digest("hex");
}

export function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error(`unpaired high surrogate at UTF-16 index ${String(index)}`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`unpaired low surrogate at UTF-16 index ${String(index)}`);
    }
  }
}

export const RawTurnInputSchema = z.strictObject({
  archiveId: z.string().min(1),
  hostConversationId: z.string().min(1),
  hostSessionId: z.string().min(1),
  hostTurnId: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  rawTimestamp: z.string().nullable(),
  sessionOrdinal: z.number().int().nonnegative(),
  turnOrdinal: z.number().int().nonnegative(),
  content: z.string(),
  transportArtifactSha256: Sha256Schema.nullable(),
});
export type RawTurnInput = z.infer<typeof RawTurnInputSchema>;

export const RawTurnSchema = z.strictObject({
  schemaVersion: z.literal(STRUCTURED_EVENT_SCHEMA_VERSION),
  rawTurnId: RawTurnIdSchema,
  archiveId: z.string().min(1),
  hostConversationId: z.string().min(1),
  hostSessionId: z.string().min(1),
  hostTurnId: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  rawTimestamp: z.string().nullable(),
  sessionOrdinal: z.number().int().nonnegative(),
  turnOrdinal: z.number().int().nonnegative(),
  content: z.string(),
  contentByteLength: z.number().int().nonnegative(),
  contentSha256: Sha256Schema,
  transportArtifactSha256: Sha256Schema.nullable(),
});
export type RawTurn = z.infer<typeof RawTurnSchema>;

export const DraftSourceAnchorSchema = z.strictObject({
  rawTurnId: RawTurnIdSchema,
  exactUtf8: z.string().min(1).max(32_000),
  prefixUtf8: z.string().max(1_024),
  suffixUtf8: z.string().max(1_024),
});
export type DraftSourceAnchor = z.infer<typeof DraftSourceAnchorSchema>;

export const SourceSelectorSchema = z.strictObject({
  schemaVersion: z.literal(STRUCTURED_EVENT_SCHEMA_VERSION),
  selectorId: SelectorIdSchema,
  rawTurnId: RawTurnIdSchema,
  contentSha256: Sha256Schema,
  byteStart: z.number().int().nonnegative(),
  byteEnd: z.number().int().positive(),
  spanSha256: Sha256Schema,
  exactUtf8: z.string().min(1),
});
export type SourceSelector = z.infer<typeof SourceSelectorSchema>;

export const MetadataFieldSchema = z.enum([
  "archive_id",
  "host_conversation_id",
  "host_session_id",
  "host_turn_id",
  "role",
  "raw_timestamp",
  "session_ordinal",
  "turn_ordinal",
]);

export const MetadataSelectorSchema = z.strictObject({
  schemaVersion: z.literal(STRUCTURED_EVENT_SCHEMA_VERSION),
  metadataSelectorId: MetadataSelectorIdSchema,
  rawTurnId: RawTurnIdSchema,
  field: MetadataFieldSchema,
  value: JsonValueSchema,
});
export type MetadataSelector = z.infer<typeof MetadataSelectorSchema>;

export const StructuralSegmentSchema = z.strictObject({
  schemaVersion: z.literal(STRUCTURED_EVENT_SCHEMA_VERSION),
  segmentId: SegmentIdSchema,
  rawTurnId: RawTurnIdSchema,
  byteStart: z.number().int().nonnegative(),
  byteEnd: z.number().int().nonnegative(),
  spanSha256: Sha256Schema,
  segmentKind: z.enum(["prose", "list_item", "blank"]),
  ordinal: z.number().int().nonnegative(),
}).superRefine((value, ctx) => {
  if (value.byteEnd < value.byteStart) {
    ctx.addIssue({ code: "custom", message: "segment byteEnd must be at or after byteStart" });
  }
});
export type StructuralSegment = z.infer<typeof StructuralSegmentSchema>;

export const MentionTypeSchema = z.enum([
  "person",
  "organization",
  "place",
  "object",
  "event",
  "time",
  "quantity",
  "concept",
  "unknown",
]);

export const DraftMentionSchema = z.strictObject({
  localMentionKey: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/),
  mentionType: MentionTypeSchema,
  anchor: DraftSourceAnchorSchema,
  // An anchor identifies the mention text. The segment ID binds that text to
  // one immutable occurrence when identical text appears more than once in a
  // raw turn. It is nullable for anchors that are already unique.
  sourceSegmentId: SegmentIdSchema.nullable(),
});
export type DraftMention = z.infer<typeof DraftMentionSchema>;

export const MentionSchema = z.strictObject({
  schemaVersion: z.literal(STRUCTURED_EVENT_SCHEMA_VERSION),
  mentionId: MentionIdSchema,
  selectorId: SelectorIdSchema,
  mentionType: MentionTypeSchema,
  surface: z.string().min(1),
});
export type Mention = z.infer<typeof MentionSchema>;

export const RecordKindSchema = z.enum([
  "claim",
  "event",
  "state",
  "preference",
  "decision",
  "intention",
  "action",
  "outcome",
  "measurement",
  "correction",
  "question",
]);
export const DiscourseFrameSchema = z.enum([
  "actual_report",
  "direct_quote",
  "hypothetical",
  "counterfactual",
  "example",
  "template",
  "script",
  "roleplay",
]);
export const CommitmentSchema = z.enum(["asserted", "suggested", "not_committed", "unknown"]);

export const DiscourseContextSchema = z.strictObject({
  frame: DiscourseFrameSchema,
  commitment: CommitmentSchema,
  parentScopeSelectorId: SelectorIdSchema.nullable(),
});

export const DraftDiscourseContextSchema = z.strictObject({
  frame: DiscourseFrameSchema,
  commitment: CommitmentSchema,
  parentScopeAnchor: DraftSourceAnchorSchema.nullable(),
});

export const PredicateSchema = z.strictObject({
  surface: z.string().min(1).max(1_000),
  normalized: z.string().min(1).max(500).nullable(),
});

export const ArgumentRoleSchema = z.enum([
  "actor",
  "experiencer",
  "subject",
  "object",
  "recipient",
  "location",
  "instrument",
  "topic",
  "value",
  "unit",
  "cause",
  "outcome",
  "condition",
  "alternative",
  "comparison_basis",
  "member",
  "other",
]);
export const ArgumentValueTypeSchema = z.enum([
  "entity_mention",
  "text",
  "number",
  "quantity",
  "money",
  "boolean",
  "time",
  "duration",
  "location",
  "record_ref",
  "collection",
]);

export const DraftArgumentSchema = z.strictObject({
  argumentKey: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/),
  role: ArgumentRoleSchema,
  customRole: z.string().min(1).max(200).nullable(),
  groupKey: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/).nullable(),
  valueType: ArgumentValueTypeSchema,
  surface: z.string().min(1).max(2_000),
  sourceTypedValue: ModelJsonValueSchema.nullable(),
  mentionKey: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/).nullable(),
  recordRefLocalKey: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/).nullable(),
});

export const ArgumentSchema = z.strictObject({
  argumentId: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/),
  role: ArgumentRoleSchema,
  customRole: z.string().min(1).max(200).nullable(),
  groupId: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/).nullable(),
  valueType: ArgumentValueTypeSchema,
  surface: z.string().min(1).max(2_000),
  sourceTypedValue: JsonValueSchema.nullable(),
  mentionId: MentionIdSchema.nullable(),
  recordId: RecordIdSchema.nullable(),
});

export const StanceSchema = z.strictObject({
  sourceSpeakerRole: z.enum(["user", "assistant"]),
  sourceSpeakerSurface: z.string().min(1).max(500).nullable(),
  reportedSpeakerMentionId: MentionIdSchema.nullable(),
  speechAct: z.enum([
    "assertion",
    "report",
    "denial",
    "question",
    "request",
    "instruction",
    "recommendation",
    "intention",
    "plan",
    "hypothetical",
    "counterfactual",
  ]),
  polarity: z.enum(["positive", "negative"]),
  modalForce: z.enum(["actual", "planned", "possible", "required", "permitted", "unknown"]),
  eventStatus: z.enum([
    "proposed",
    "attempted",
    "ongoing",
    "completed",
    "cancelled",
    "failed",
    "unknown",
    "not_applicable",
  ]),
  adoption: z.enum(["proposed", "adopted", "rejected", "not_applicable", "unknown"]),
  speakerCertainty: z.enum(["certain", "probable", "possible", "uncertain", "unknown"]),
});

export const DraftStanceSchema = StanceSchema.omit({ reportedSpeakerMentionId: true }).extend({
  reportedSpeakerMentionKey: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/).nullable(),
});

export const ValidTimeSchema = z.strictObject({
  temporalType: z.enum(["instant", "interval", "recurrence", "duration", "relative"]),
  raw: z.string().min(1).max(1_000).nullable(),
  normalizedStart: z.string().min(1).max(500).nullable(),
  normalizedEnd: z.string().min(1).max(500).nullable(),
  normalizedDuration: z.string().min(1).max(500).nullable(),
  recurrence: JsonValueSchema.nullable(),
  sourcePrecision: z.enum([
    "exact",
    "time",
    "day",
    "week",
    "month",
    "year",
    "interval",
    "relative",
    "unknown",
  ]),
  sourceCertainty: z.enum(["certain", "uncertain", "ambiguous", "absent"]),
  resolutionBasis: z.enum(["source_explicit", "unresolved"]),
}).superRefine((value, ctx) => {
  if (
    value.resolutionBasis === "unresolved"
    && [value.normalizedStart, value.normalizedEnd, value.normalizedDuration, value.recurrence]
      .some((item) => item !== null)
  ) {
    ctx.addIssue({ code: "custom", message: "unresolved source time cannot contain normalized values" });
  }
});

export const DraftValidTimeSchema = z.strictObject({
  temporalType: z.enum(["instant", "interval", "recurrence", "duration", "relative"]),
  raw: z.string().min(1).max(1_000).nullable(),
  normalizedStart: z.string().min(1).max(500).nullable(),
  normalizedEnd: z.string().min(1).max(500).nullable(),
  normalizedDuration: z.string().min(1).max(500).nullable(),
  recurrence: ModelJsonValueSchema.nullable(),
  sourcePrecision: z.enum([
    "exact",
    "time",
    "day",
    "week",
    "month",
    "year",
    "interval",
    "relative",
    "unknown",
  ]),
  sourceCertainty: z.enum(["certain", "uncertain", "ambiguous", "absent"]),
  resolutionBasis: z.enum(["source_explicit", "unresolved"]),
});

export const TemporalSchema = z.strictObject({
  assertionTime: z.strictObject({
    raw: z.string().nullable(),
    precision: z.enum(["exact", "time", "day", "month", "year", "unknown"]),
    source: z.literal("host_metadata"),
  }),
  sessionOrdinal: z.number().int().nonnegative(),
  turnOrdinal: z.number().int().nonnegative(),
  validTimes: z.array(ValidTimeSchema).max(32),
});

export const SemanticRecordCoreSchema = z.strictObject({
  schemaVersion: z.literal(STRUCTURED_EVENT_SCHEMA_VERSION),
  recordKind: RecordKindSchema,
  discourseContext: DiscourseContextSchema,
  predicate: PredicateSchema,
  arguments: z.array(ArgumentSchema).max(64),
  stance: StanceSchema,
  temporal: TemporalSchema,
  claimSelectorIds: z.array(SelectorIdSchema).min(1).max(32),
});
export type SemanticRecordCore = z.infer<typeof SemanticRecordCoreSchema>;

export const SemanticRecordSchema = SemanticRecordCoreSchema.extend({
  recordId: RecordIdSchema,
});
export type SemanticRecord = z.infer<typeof SemanticRecordSchema>;

export const DraftMetadataEvidenceSchema = z.strictObject({
  rawTurnId: RawTurnIdSchema,
  field: MetadataFieldSchema,
});
export type DraftMetadataEvidence = z.infer<typeof DraftMetadataEvidenceSchema>;

export const SupportPurposeSchema = z.enum([
  "semantic_classification",
  "attribution",
  "argument_role",
  "discourse_scope",
  "temporal_type",
  "host_metadata",
  "other",
]);

export const DraftSupportBindingSchema = z.strictObject({
  targetKind: z.enum(["field", "mention"]),
  targetPathOrMentionKey: z.string().min(1).max(500),
  purpose: SupportPurposeSchema,
  method: z.string().min(1).max(500),
  evidenceAnchors: z.array(DraftSourceAnchorSchema).max(16),
  metadataEvidence: z.array(DraftMetadataEvidenceSchema).max(16),
  confidence: z.enum(["high", "medium", "low"]),
});
export type DraftSupportBinding = z.infer<typeof DraftSupportBindingSchema>;

export const DraftSemanticRecordSchema = z.strictObject({
  localRecordKey: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/),
  recordKind: RecordKindSchema,
  discourseContext: DraftDiscourseContextSchema,
  predicate: PredicateSchema,
  arguments: z.array(DraftArgumentSchema).max(64),
  stance: DraftStanceSchema,
  validTimes: z.array(DraftValidTimeSchema).max(32),
  claimAnchors: z.array(DraftSourceAnchorSchema).min(1).max(32),
  supportBindings: z.array(DraftSupportBindingSchema).max(512),
  extractionConfidence: z.enum(["high", "medium", "low"]),
});
export type DraftSemanticRecord = z.infer<typeof DraftSemanticRecordSchema>;

export const SupportBindingSchema = z.strictObject({
  schemaVersion: z.literal(STRUCTURED_EVENT_SCHEMA_VERSION),
  supportBindingId: SupportBindingIdSchema,
  targetObjectType: z.enum(["record", "block"]),
  targetObjectId: z.union([RecordIdSchema, BlockIdSchema]),
  targetFieldPathOrMentionId: z.string().min(1),
  purpose: SupportPurposeSchema,
  method: z.string().min(1),
  selectorIds: z.array(SelectorIdSchema).max(16),
  metadataSelectorIds: z.array(MetadataSelectorIdSchema).max(16),
  confidence: z.enum(["high", "medium", "low"]),
}).superRefine((value, ctx) => {
  if (!value.targetObjectId.startsWith(`${value.targetObjectType}_`)) {
    ctx.addIssue({ code: "custom", message: "support target object type does not match its ID" });
  }
});
export type SupportBinding = z.infer<typeof SupportBindingSchema>;

export const ResolutionKindSchema = z.enum([
  "identity",
  "coreference",
  "omitted_argument",
  "value_normalization",
  "temporal_resolution",
]);

export const DraftResolutionAssertionSchema = z.strictObject({
  localResolutionKey: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/),
  targetRecordLocalKey: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/),
  targetKind: z.enum(["field", "mention"]),
  targetPathOrMentionKey: z.string().min(1).max(500),
  kind: ResolutionKindSchema,
  proposedValue: ModelJsonValueSchema,
  evidenceAnchors: z.array(DraftSourceAnchorSchema).max(16),
  metadataEvidence: z.array(DraftMetadataEvidenceSchema).max(16),
  method: z.string().min(1).max(500),
  confidence: z.enum(["high", "medium", "low"]),
  status: z.enum(["candidate", "confirmed", "rejected"]),
});
export type DraftResolutionAssertion = z.infer<typeof DraftResolutionAssertionSchema>;

export const ResolutionAssertionSchema = z.strictObject({
  schemaVersion: z.literal(STRUCTURED_EVENT_SCHEMA_VERSION),
  resolutionId: ResolutionIdSchema,
  targetRecordId: RecordIdSchema,
  targetFieldPathOrMentionId: z.string().min(1),
  kind: ResolutionKindSchema,
  proposedValue: JsonValueSchema,
  selectorIds: z.array(SelectorIdSchema).max(16),
  metadataSelectorIds: z.array(MetadataSelectorIdSchema).max(16),
  method: z.string().min(1),
  confidence: z.enum(["high", "medium", "low"]),
  status: z.enum(["candidate", "confirmed", "rejected"]),
}).superRefine((value, ctx) => {
  if (!(value.targetFieldPathOrMentionId.startsWith("/") || value.targetFieldPathOrMentionId.startsWith("mention_"))) {
    ctx.addIssue({ code: "custom", message: "resolution target must be a field path or mention ID" });
  }
});
export type ResolutionAssertion = z.infer<typeof ResolutionAssertionSchema>;

export const SemanticProjectionSchema = z.strictObject({
  schemaVersion: z.literal(STRUCTURED_EVENT_SCHEMA_VERSION),
  projectionId: ProjectionIdSchema,
  recordId: RecordIdSchema,
  projectionKind: z.enum(["base", "enriched"]),
  baseProjectionId: ProjectionIdSchema.nullable(),
  rendererVersion: z.string().min(1),
  confirmedResolutionIds: z.array(ResolutionIdSchema),
  canonicalText: z.string().min(1),
}).superRefine((value, ctx) => {
  if (value.projectionKind === "base") {
    if (value.baseProjectionId !== null || value.confirmedResolutionIds.length > 0) {
      ctx.addIssue({ code: "custom", message: "base projection cannot reference resolutions or another base" });
    }
  } else {
    if (value.baseProjectionId === null || value.confirmedResolutionIds.length === 0) {
      ctx.addIssue({ code: "custom", message: "enriched projection requires a base and confirmed resolutions" });
    }
  }
});
export type SemanticProjection = z.infer<typeof SemanticProjectionSchema>;

export const DefaultProjectionMembershipSchema = z.strictObject({
  schemaVersion: z.literal(STRUCTURED_EVENT_SCHEMA_VERSION),
  recordId: RecordIdSchema,
  projectionId: ProjectionIdSchema,
  projectionKind: z.enum(["base", "enriched"]),
  lifecycleEventId: LifecycleEventIdSchema,
});
export type DefaultProjectionMembership = z.infer<typeof DefaultProjectionMembershipSchema>;

export const BlockKindSchema = z.enum([
  "advice",
  "explanation",
  "template",
  "procedure",
  "generated_content",
  "other",
]);

export const DraftAssistantBlockItemSchema = z.strictObject({
  localItemKey: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/),
  ordinal: z.number().int().nonnegative(),
  heading: z.string().min(1).max(500).nullable(),
  sourceAnchor: DraftSourceAnchorSchema.nullable(),
  sourceSegmentId: SegmentIdSchema.nullable(),
});

export const DraftAssistantBlockSchema = z.strictObject({
  localBlockKey: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/),
  blockKind: BlockKindSchema,
  discourseContext: DraftDiscourseContextSchema,
  sourceAnchor: DraftSourceAnchorSchema.nullable(),
  sourceSegmentIds: z.array(SegmentIdSchema).max(128),
  items: z.array(DraftAssistantBlockItemSchema).max(256),
  supportBindings: z.array(DraftSupportBindingSchema).max(64),
  routingText: z.string().min(1).max(4_000),
  routingTerms: z.array(z.string().min(1).max(500)).max(256),
});
export type DraftAssistantBlock = z.infer<typeof DraftAssistantBlockSchema>;

export const AssistantBlockSchema = z.strictObject({
  schemaVersion: z.literal(STRUCTURED_EVENT_SCHEMA_VERSION),
  blockId: BlockIdSchema,
  blockKind: BlockKindSchema,
  discourseContext: DiscourseContextSchema,
  sourceSelectorId: SelectorIdSchema,
});
export type AssistantBlock = z.infer<typeof AssistantBlockSchema>;

export const AssistantBlockItemSchema = z.strictObject({
  schemaVersion: z.literal(STRUCTURED_EVENT_SCHEMA_VERSION),
  itemId: ItemIdSchema,
  blockId: BlockIdSchema,
  ordinal: z.number().int().nonnegative(),
  heading: z.string().min(1).max(500).nullable(),
  sourceSelectorId: SelectorIdSchema,
});
export type AssistantBlockItem = z.infer<typeof AssistantBlockItemSchema>;

export const AssistantBlockProjectionSchema = z.strictObject({
  schemaVersion: z.literal(STRUCTURED_EVENT_SCHEMA_VERSION),
  projectionId: ProjectionIdSchema,
  blockId: BlockIdSchema,
  rendererVersion: z.string().min(1),
  routingText: z.string().min(1),
  routingTerms: z.array(z.string().min(1)),
  itemRoutingTerms: z.record(ItemIdSchema, z.array(z.string().min(1))),
});
export type AssistantBlockProjection = z.infer<typeof AssistantBlockProjectionSchema>;

/**
 * Lossless deterministic lexical postings are deliberately kept outside the
 * semantic projection. They preserve raw discoverability without pretending
 * that copied source vocabulary is semantic compression.
 */
export const RawLexicalPostingSchema = z.strictObject({
  schemaVersion: z.literal(STRUCTURED_EVENT_SCHEMA_VERSION),
  postingId: RawLexicalPostingIdSchema,
  targetObjectType: z.enum(["block", "item"]),
  targetObjectId: z.union([BlockIdSchema, ItemIdSchema]),
  sourceSelectorId: SelectorIdSchema,
  normalizedTerms: z.array(z.string().min(1)),
}).superRefine((value, ctx) => {
  if (!value.targetObjectId.startsWith(`${value.targetObjectType}_`)) {
    ctx.addIssue({ code: "custom", message: "lexical posting target type does not match its ID" });
  }
});
export type RawLexicalPosting = z.infer<typeof RawLexicalPostingSchema>;

export const DraftCoverageRowSchema = z.strictObject({
  segmentId: SegmentIdSchema,
  routeType: z.enum(["semantic", "assistant_block", "quarantine", "no_semantic_content"]),
  localRecordKeys: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,127}$/)).max(128),
  localBlockKeys: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,127}$/)).max(128),
  localObjectKeysExpectedInQuarantine: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,127}$/)).max(128),
  reason: z.string().min(1).max(2_000),
});

export const CoverageRowSchema = z.strictObject({
  schemaVersion: z.literal(STRUCTURED_EVENT_SCHEMA_VERSION),
  segmentId: SegmentIdSchema,
  routeType: DraftCoverageRowSchema.shape.routeType,
  recordIds: z.array(RecordIdSchema),
  blockIds: z.array(BlockIdSchema),
  quarantineIds: z.array(QuarantineIdSchema),
  reason: z.string().min(1),
});
export type CoverageRow = z.infer<typeof CoverageRowSchema>;

export const MapperPageOutputSchema = z.strictObject({
  targetSessionOpaqueId: z.string().regex(/^memory_[0-9]{6,18}$/),
  pageNumber: z.number().int().positive(),
  pageCount: z.number().int().positive(),
  expectedSegmentIds: z.array(SegmentIdSchema).min(1).max(128),
  mentions: z.array(DraftMentionSchema).max(256),
  records: z.array(DraftSemanticRecordSchema).max(256),
  assistantBlocks: z.array(DraftAssistantBlockSchema).max(128),
  resolutionAssertions: z.array(DraftResolutionAssertionSchema).max(256),
  coverageRows: z.array(DraftCoverageRowSchema).max(128),
});
export type MapperPageOutput = z.infer<typeof MapperPageOutputSchema>;

/** Model-facing targeted replacements; immutable page identity stays host-owned. */
export const MapperPagePatchOutputSchema = z.strictObject({
  mentions: z.array(DraftMentionSchema).max(256),
  records: z.array(DraftSemanticRecordSchema).max(256),
  assistantBlocks: z.array(DraftAssistantBlockSchema).max(128),
  resolutionAssertions: z.array(DraftResolutionAssertionSchema).max(256),
  coverageRows: z.array(DraftCoverageRowSchema).max(128),
});
export type MapperPagePatchOutput = z.infer<typeof MapperPagePatchOutputSchema>;

export const AttemptSchema = z.strictObject({
  schemaVersion: z.literal(STRUCTURED_EVENT_SCHEMA_VERSION),
  attemptId: AttemptIdSchema,
  runId: z.string().min(1),
  targetId: z.string().min(1),
  pageNumber: z.number().int().positive(),
  inputContextManifest: JsonValueSchema,
  inputContextManifestSha256: Sha256Schema,
  parentAttemptIds: z.array(AttemptIdSchema),
  trigger: z.enum([
    "mapper",
    "repair",
    "linker",
    "semantic_judge",
    "adjudicator",
    "deterministic_import",
  ]),
  model: z.string().min(1),
  promptSha256: Sha256Schema,
  schemaSha256: Sha256Schema,
  rawProviderOutput: z.string(),
  rawOutputSha256: Sha256Schema,
  parsedDrafts: JsonValueSchema.nullable(),
  diagnostics: z.array(JsonValueSchema),
  warnings: z.array(z.lazy(() => MaterializationIssueSchema)),
  finishReason: z.string().min(1),
  outputComplete: z.boolean(),
  extractionConfidence: z.enum(["high", "medium", "low"]).nullable(),
});
export type Attempt = z.infer<typeof AttemptSchema>;

export const AttemptMaterializationResultSchema = z.strictObject({
  schemaVersion: z.literal(STRUCTURED_EVENT_SCHEMA_VERSION),
  attemptResultId: AttemptResultIdSchema,
  attemptId: AttemptIdSchema,
  status: z.enum(["accepted", "quarantined", "incomplete", "failed"]),
  materializedObjectIds: z.array(z.string().min(1)),
  quarantineIds: z.array(QuarantineIdSchema),
  completionErrors: z.array(z.string().min(1)),
  warnings: z.array(z.lazy(() => MaterializationIssueSchema)),
});
export type AttemptMaterializationResult = z.infer<typeof AttemptMaterializationResultSchema>;

export const AttemptSupersessionSchema = z.strictObject({
  schemaVersion: z.literal(STRUCTURED_EVENT_SCHEMA_VERSION),
  supersessionId: AttemptSupersessionIdSchema,
  parentAttemptId: AttemptIdSchema,
  replacementAttemptId: AttemptIdSchema,
  reason: z.enum(["adaptive_repage", "targeted_repair"]),
}).superRefine((value, ctx) => {
  if (value.parentAttemptId === value.replacementAttemptId) {
    ctx.addIssue({ code: "custom", message: "an attempt cannot supersede itself" });
  }
});
export type AttemptSupersession = z.infer<typeof AttemptSupersessionSchema>;

export const DerivationOccurrenceSchema = z.strictObject({
  schemaVersion: z.literal(STRUCTURED_EVENT_SCHEMA_VERSION),
  derivationId: DerivationIdSchema,
  attemptId: AttemptIdSchema,
  objectType: z.enum(["mention", "record", "support_binding", "resolution", "projection", "block", "item", "link"]),
  objectId: z.string().min(1),
  proposalLocalKey: z.string().min(1),
  extractionConfidence: z.enum(["high", "medium", "low"]).nullable(),
});
export type DerivationOccurrence = z.infer<typeof DerivationOccurrenceSchema>;

export const MaterializationIssueSchema = z.strictObject({
  code: z.enum([
    "unknown_turn",
    "quote_not_found",
    "unresolved_ambiguity",
    "invalid_utf8_boundary",
    "claim_outside_target",
    "unknown_mention",
    "unknown_record_ref",
    "missing_support_binding",
    "support_binding_failed",
    "optional_context_mismatch",
    "resolution_failed",
    "invalid_page_set",
    "invalid_coverage",
    "output_incomplete",
    "schema_invalid",
  ]),
  detail: z.string().min(1),
  candidateByteOffsets: z.array(z.number().int().nonnegative()),
});
export type MaterializationIssue = z.infer<typeof MaterializationIssueSchema>;

export const QuarantineSchema = z.strictObject({
  schemaVersion: z.literal(STRUCTURED_EVENT_SCHEMA_VERSION),
  quarantineId: QuarantineIdSchema,
  attemptId: AttemptIdSchema,
  objectType: z.enum(["mention", "record", "assistant_block", "resolution", "coverage"]),
  localObjectKey: z.string().min(1),
  draft: JsonValueSchema,
  resolvedSelectorIds: z.array(SelectorIdSchema),
  issues: z.array(MaterializationIssueSchema).min(1),
  parentQuarantineIds: z.array(QuarantineIdSchema),
});
export type Quarantine = z.infer<typeof QuarantineSchema>;

export const LifecycleEventSchema = z.strictObject({
  schemaVersion: z.literal(STRUCTURED_EVENT_SCHEMA_VERSION),
  lifecycleEventId: LifecycleEventIdSchema,
  recordId: RecordIdSchema,
  judgedProjectionId: ProjectionIdSchema,
  state: z.enum(["accepted", "challenged", "invalidated", "projection_gap"]),
  basis: z.enum(["materialization", "model_challenge", "deterministic_invalidity", "dual_judge_adjudication"]),
  semanticJudgeAttemptIds: z.array(AttemptIdSchema).max(2),
  adjudicatorAttemptId: AttemptIdSchema.nullable(),
  replacementRecordIds: z.array(RecordIdSchema),
  priorLifecycleEventIds: z.array(LifecycleEventIdSchema),
  detail: z.string().min(1),
});
export type LifecycleEvent = z.infer<typeof LifecycleEventSchema>;

export const LinkEndpointSchema = z.strictObject({
  endpointType: z.enum(["record", "mention", "block", "item"]),
  endpointId: z.union([RecordIdSchema, MentionIdSchema, BlockIdSchema, ItemIdSchema]),
}).superRefine((value, ctx) => {
  if (!value.endpointId.startsWith(`${value.endpointType}_`)) {
    ctx.addIssue({ code: "custom", message: "link endpoint type does not match its ID" });
  }
});

export const LinkTypeSchema = z.enum([
  "UPDATES",
  "SUPERSEDES",
  "CORRECTS",
  "CONTRADICTS",
  "DUPLICATE_REPORT_OF",
  "BEFORE",
  "AFTER",
  "SAME_EVENT_CANDIDATE",
  "SAME_EVENT",
  "SAME_ENTITY_CANDIDATE",
  "SAME_ENTITY",
  "REFERS_TO",
  "ADOPTS",
  "REJECTS",
  "IMPLEMENTS",
  "EMBEDDED_IN",
  "CONDITION_OF",
  "ALTERNATIVE_TO",
  "COMPARES",
  "CAUSES",
]);

export const LinkEffectiveTimeSchema = z.strictObject({
  status: z.enum(["known", "unknown"]),
  value: JsonValueSchema.nullable(),
});

export const LinkProvenanceBasisSchema = z.strictObject({
  basisKind: z.enum(["source_span", "structural_order", "immutable_timestamp", "temporal_parse"]),
  selectorIds: z.array(SelectorIdSchema),
  metadataSelectorIds: z.array(MetadataSelectorIdSchema),
  parsedValue: JsonValueSchema.nullable(),
  methodVersion: z.string().min(1),
}).superRefine((value, ctx) => {
  if (value.basisKind === "source_span" && value.selectorIds.length === 0) {
    ctx.addIssue({ code: "custom", message: "source_span basis requires a selector" });
  }
  if (
    (value.basisKind === "structural_order" || value.basisKind === "immutable_timestamp")
    && value.metadataSelectorIds.length === 0
  ) {
    ctx.addIssue({ code: "custom", message: `${value.basisKind} basis requires metadata` });
  }
  if (
    value.basisKind === "temporal_parse"
    && value.parsedValue === null
  ) {
    ctx.addIssue({ code: "custom", message: "temporal_parse basis requires parsedValue" });
  }
});

const TypedLinkCoreShape = {
  schemaVersion: z.literal(STRUCTURED_EVENT_SCHEMA_VERSION),
  type: LinkTypeSchema,
  sourceEndpoint: LinkEndpointSchema,
  targetEndpoint: LinkEndpointSchema,
  direction: z.enum(["source_to_target", "symmetric"]),
  affectedFieldPath: z.string().min(1).nullable(),
  effectiveTime: LinkEffectiveTimeSchema,
  assertion: z.enum(["explicit", "inferred"]),
  status: z.enum(["candidate", "confirmed"]),
  confidence: z.enum(["high", "medium", "low"]),
  provenanceBasis: z.array(LinkProvenanceBasisSchema).min(1),
} as const;

function refineTypedLinkCore(
  value: { type: z.infer<typeof LinkTypeSchema>; affectedFieldPath: string | null; direction: "source_to_target" | "symmetric" },
  ctx: z.RefinementCtx,
): void {
  if (value.type === "UPDATES" && value.affectedFieldPath === null) {
    ctx.addIssue({ code: "custom", message: "UPDATES requires affectedFieldPath" });
  }
  if (value.type === "UPDATES" && value.direction !== "source_to_target") {
    ctx.addIssue({ code: "custom", message: "UPDATES must be directional" });
  }
}

export const TypedLinkCoreSchema = z.strictObject(TypedLinkCoreShape).superRefine(refineTypedLinkCore);
export const TypedLinkSchema = z.strictObject({
  ...TypedLinkCoreShape,
  linkId: LinkIdSchema,
}).superRefine(refineTypedLinkCore);
export type TypedLink = z.infer<typeof TypedLinkSchema>;

export const DraftLinkEffectiveTimeSchema = z.strictObject({
  status: z.enum(["known", "unknown"]),
  value: ModelJsonValueSchema.nullable(),
});

export const DraftLinkProvenanceBasisSchema = z.strictObject({
  basisKind: z.enum(["source_span", "structural_order", "immutable_timestamp", "temporal_parse"]),
  selectorIds: z.array(SelectorIdSchema),
  metadataSelectorIds: z.array(MetadataSelectorIdSchema),
  parsedValue: ModelJsonValueSchema.nullable(),
  methodVersion: z.string().min(1),
}).superRefine((value, ctx) => {
  if (value.basisKind === "source_span" && value.selectorIds.length === 0) {
    ctx.addIssue({ code: "custom", message: "source_span basis requires a selector" });
  }
  if (
    (value.basisKind === "structural_order" || value.basisKind === "immutable_timestamp")
    && value.metadataSelectorIds.length === 0
  ) {
    ctx.addIssue({ code: "custom", message: `${value.basisKind} basis requires metadata` });
  }
  if (value.basisKind === "temporal_parse" && value.parsedValue === null) {
    ctx.addIssue({ code: "custom", message: "temporal_parse basis requires parsedValue" });
  }
});

export const DraftTypedLinkSchema = z.strictObject({
  type: LinkTypeSchema,
  sourceEndpoint: LinkEndpointSchema,
  targetEndpoint: LinkEndpointSchema,
  direction: z.enum(["source_to_target", "symmetric"]),
  affectedFieldPath: z.string().min(1).nullable(),
  effectiveTime: DraftLinkEffectiveTimeSchema,
  assertion: z.enum(["explicit", "inferred"]),
  status: z.enum(["candidate", "confirmed"]),
  confidence: z.enum(["high", "medium", "low"]),
  provenanceBasis: z.array(DraftLinkProvenanceBasisSchema).min(1),
}).superRefine(refineTypedLinkCore);
export const LinkerOutputSchema = z.strictObject({
  links: z.array(DraftTypedLinkSchema).max(512),
  unresolvedRelations: z.array(z.strictObject({
    sourceEndpoint: LinkEndpointSchema,
    targetEndpoint: LinkEndpointSchema,
    attemptedType: LinkTypeSchema,
    reason: z.string().min(1).max(2_000),
  })).max(512),
});
export type LinkerOutput = z.infer<typeof LinkerOutputSchema>;

export const LinkAuditDecisionSchema = z.strictObject({
  linkIndex: z.number().int().nonnegative(),
  accepted: z.boolean(),
  reason: z.string().min(1).max(2_000),
});
export const LinkAuditOutputSchema = z.strictObject({
  decisions: z.array(LinkAuditDecisionSchema).max(512),
});
export type LinkAuditOutput = z.infer<typeof LinkAuditOutputSchema>;

export const LinkGenerationMembershipSchema = z.strictObject({
  schemaVersion: z.literal(STRUCTURED_EVENT_SCHEMA_VERSION),
  generationId: LinkGenerationIdSchema,
  linkIds: z.array(LinkIdSchema),
  mapperFreezeSha256: Sha256Schema,
  linkerPromptSha256: Sha256Schema,
  linkerModel: z.string().min(1),
});
export type LinkGenerationMembership = z.infer<typeof LinkGenerationMembershipSchema>;
