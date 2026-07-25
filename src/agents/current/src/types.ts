import { z } from "zod";

import type {
  RetrievalCandidates,
  RetrievalIndexManifest,
} from "./retrieval/types.js";

export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export const SOURCE_EXCERPT_MAX_LENGTH = 600;

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);
export const JsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), JsonValueSchema);

export const TurnSchema = z
  .looseObject({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
  });

export const TimestampedSessionSchema = z.strictObject({
  session_id: z.string().min(1),
  date: z.string().min(1),
  turns: z.array(TurnSchema),
});
export type TimestampedSession = z.infer<typeof TimestampedSessionSchema>;

export const CaseMetadataSchema = z.strictObject({
  question_id: z.string().min(1),
});
export type CaseMetadata = z.infer<typeof CaseMetadataSchema>;

export const SourceReferenceSchema = z.strictObject({
  sessionId: z.string().min(1),
  turnIndex: z.number().int().nonnegative(),
  sessionDate: z.string().min(1),
  batchId: z.string().min(1),
  excerpt: z.string().max(SOURCE_EXCERPT_MAX_LENGTH).nullable(),
});
export type SourceReference = z.infer<typeof SourceReferenceSchema>;

export const PointerProvenanceSchema = z.strictObject({
  pointer: z.string().startsWith("/context/"),
  sources: z.array(SourceReferenceSchema).min(1),
});
export type PointerProvenance = z.infer<typeof PointerProvenanceSchema>;

export const MasterContextGraphSchema = z.strictObject({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  context: JsonObjectSchema,
  provenanceByPointer: z.record(z.string(), z.array(SourceReferenceSchema)),
});
export type MasterContextGraph = z.infer<typeof MasterContextGraphSchema>;

const PatchBaseSchema = z.strictObject({
  path: z.string().startsWith("/context/"),
  sources: z.array(SourceReferenceSchema).min(1),
  reason: z.string().min(1),
});

export const JsonPatchOperationSchema = z.discriminatedUnion("op", [
  PatchBaseSchema.extend({ op: z.literal("add"), value: JsonValueSchema }),
  PatchBaseSchema.extend({ op: z.literal("replace"), value: JsonValueSchema }),
  PatchBaseSchema.extend({ op: z.literal("remove") }),
  PatchBaseSchema.extend({
    op: z.literal("move"),
    from: z.string().startsWith("/context/"),
  }),
]);
export type JsonPatchOperation = z.infer<typeof JsonPatchOperationSchema>;

export const GraphMigrationRecordSchema = z.strictObject({
  from: z.string().startsWith("/context/"),
  outcome: z.enum(["preserved", "moved", "removed"]),
  to: z.string().startsWith("/context/").nullable(),
  reason: z.string().min(1),
  sources: z.array(SourceReferenceSchema).min(1),
});
export type GraphMigrationRecord = z.infer<typeof GraphMigrationRecordSchema>;

export const MemoryDomainSchema = z.enum([
  "people",
  "relationships",
  "places",
  "health",
  "routines",
  "possessions",
  "preferences",
  "events",
  "plans",
  "projects",
  "accounts",
  "measurements",
  "other",
]);
export type MemoryDomain = z.infer<typeof MemoryDomainSchema>;

export const MemoryTypeSchema = z.enum([
  "fact",
  "relationship",
  "preference",
  "plan",
  "event",
  "measurement",
  "decision",
  "recommendation",
]);
export type MemoryType = z.infer<typeof MemoryTypeSchema>;

export const MemoryUpdateModeSchema = z.enum(["set", "append", "record_observation"]);
export type MemoryUpdateMode = z.infer<typeof MemoryUpdateModeSchema>;

export const SessionSlotSchema = z.enum([
  "session_1",
  "session_2",
  "session_3",
  "session_4",
  "session_5",
  "session_6",
  "session_7",
  "session_8",
  "session_9",
]);
export type SessionSlot = z.infer<typeof SessionSlotSchema>;

const TURN_SLOTS = Array.from({ length: 32 }, (_, index) => `turn_${String(index + 1)}`) as [
  string,
  ...string[],
];
export const TurnSlotSchema = z.enum(TURN_SLOTS);

export const MemorySourceLocatorSchema = z.strictObject({
  sessionSlot: SessionSlotSchema,
  turnSlot: TurnSlotSchema,
  evidenceQuote: z.string().min(1).max(SOURCE_EXCERPT_MAX_LENGTH),
});
export type MemorySourceLocator = z.infer<typeof MemorySourceLocatorSchema>;

export const IgnoredSessionReasonSchema = z.enum([
  "no_durable_memory",
  "generic_knowledge",
  "fiction_or_roleplay",
  "quoted_or_pasted_source",
  "assistant_only",
]);

export const SessionDispositionSchema = z.enum([
  "extract_personal_memory",
  "no_durable_memory",
  "generic_knowledge",
  "fiction_or_roleplay",
  "quoted_or_pasted_source",
  "assistant_only",
]);

const MemoryPathSegmentSchema = z.string().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);

export const SemanticMemoryUpdateSchema = z.strictObject({
  domain: MemoryDomainSchema,
  path: z.array(MemoryPathSegmentSchema).min(2).max(8),
  memoryType: MemoryTypeSchema,
  updateMode: MemoryUpdateModeSchema,
  value: JsonValueSchema,
  effectiveAt: z.string().min(1).nullable(),
  unit: z.string().min(1).nullable(),
  sources: z.array(SourceReferenceSchema).min(1),
  sourceWarnings: z.array(z.string().min(1)).optional(),
  reason: z.string().min(1).max(500),
});
export type SemanticMemoryUpdate = z.infer<typeof SemanticMemoryUpdateSchema>;

export const ContextoSemanticBatchSchema = z.strictObject({
  mode: z.literal("semantic_updates"),
  batchSummary: z.string().min(1),
  updates: z.array(SemanticMemoryUpdateSchema).max(96),
  ignoredSessions: z.array(
    z.strictObject({
      sessionId: z.string().min(1),
      reason: IgnoredSessionReasonSchema,
    }),
  ),
});
export type ContextoSemanticBatch = z.infer<typeof ContextoSemanticBatchSchema>;

export const ContextoMutationSchema = z.discriminatedUnion("mode", [
  ContextoSemanticBatchSchema,
  z.strictObject({
    mode: z.literal("patch"),
    operations: z.array(JsonPatchOperationSchema),
    explanation: z.string().min(1),
  }),
  z.strictObject({
    mode: z.literal("replace_graph"),
    graph: JsonObjectSchema,
    provenance: z.array(PointerProvenanceSchema),
    migration: z.array(GraphMigrationRecordSchema),
    explanation: z.string().min(1),
  }),
]);
export type ContextoMutation = z.infer<typeof ContextoMutationSchema>;

export const ContextoResponseSchema = z.strictObject({ mutation: ContextoMutationSchema });
export type ContextoResponse = z.infer<typeof ContextoResponseSchema>;

export type JsonTreeEntry = { key: string; value: JsonTreeValue };
export type JsonTreeObject = { kind: "object"; entries: JsonTreeEntry[] };
export type JsonTreeValue =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" }
  | { kind: "array"; items: JsonTreeValue[] }
  | JsonTreeObject;

export const JsonTreeValueSchema = z.lazy(() =>
  z.union([
    z.strictObject({ kind: z.literal("string"), value: z.string() }),
    z.strictObject({ kind: z.literal("number"), value: z.number() }),
    z.strictObject({ kind: z.literal("boolean"), value: z.boolean() }),
    z.strictObject({ kind: z.literal("null") }),
    z.strictObject({ kind: z.literal("array"), items: z.array(JsonTreeValueSchema) }),
    JsonTreeObjectSchema,
  ]),
) as unknown as z.ZodType<JsonTreeValue>;

export const JsonTreeObjectSchema: z.ZodType<JsonTreeObject> = z.strictObject({
  kind: z.literal("object"),
  entries: z.array(
    z.strictObject({
      key: z.string().min(1),
      value: JsonTreeValueSchema,
    }),
  ),
});

export const SemanticMemoryWireUpdateSchema = SemanticMemoryUpdateSchema.omit({ value: true, sources: true, sourceWarnings: true }).extend({
  value: JsonTreeValueSchema,
  sources: z.array(MemorySourceLocatorSchema).min(1),
});
export type SemanticMemoryWireUpdate = z.infer<typeof SemanticMemoryWireUpdateSchema>;

const ContextoSignalResolutionBaseSchema = z.strictObject({
  signalId: z.string().min(1),
  rationale: z.string().min(1).max(300),
});

export const ContextoSignalResolutionSchema = z.discriminatedUnion("disposition", [
  ContextoSignalResolutionBaseSchema.extend({
    disposition: z.literal("materialized"),
    updates: z.array(SemanticMemoryWireUpdateSchema).min(1).max(12),
    existingPath: z.null(),
  }),
  ContextoSignalResolutionBaseSchema.extend({
    disposition: z.literal("duplicate"),
    updates: z.array(SemanticMemoryWireUpdateSchema).max(0),
    existingPath: z.string().startsWith("/context/"),
  }),
  ContextoSignalResolutionBaseSchema.extend({
    disposition: z.literal("session_index_fallback"),
    updates: z.array(SemanticMemoryWireUpdateSchema).max(0),
    existingPath: z.null(),
  }),
]);
export type ContextoSignalResolution = z.infer<typeof ContextoSignalResolutionSchema>;

export const ContextoSemanticWireBatchSchema = ContextoSemanticBatchSchema.omit({ updates: true, ignoredSessions: true }).extend({
  requiredSignalResolutions: z.array(ContextoSignalResolutionSchema).max(128),
  additionalUpdates: z.array(SemanticMemoryWireUpdateSchema).max(96),
  sessionAudits: z.array(
    z.strictObject({
      sessionSlot: SessionSlotSchema,
      disposition: SessionDispositionSchema,
      rationale: z.string().min(1).max(300),
    }),
  ).min(1).max(9),
});
export type ContextoSemanticWireBatch = z.infer<typeof ContextoSemanticWireBatchSchema>;

const WirePatchBaseSchema = z.strictObject({
  path: z.string().startsWith("/context/"),
  sources: z.array(SourceReferenceSchema).min(1),
  reason: z.string().min(1),
});

export const ContextoWireMutationSchema = z.discriminatedUnion("mode", [
  ContextoSemanticWireBatchSchema,
  z.strictObject({
    mode: z.literal("patch"),
    operations: z.array(
      z.discriminatedUnion("op", [
        WirePatchBaseSchema.extend({ op: z.literal("add"), value: JsonTreeValueSchema }),
        WirePatchBaseSchema.extend({ op: z.literal("replace"), value: JsonTreeValueSchema }),
        WirePatchBaseSchema.extend({ op: z.literal("remove") }),
        WirePatchBaseSchema.extend({
          op: z.literal("move"),
          from: z.string().startsWith("/context/"),
        }),
      ]),
    ),
    explanation: z.string().min(1),
  }),
  z.strictObject({
    mode: z.literal("replace_graph"),
    graph: JsonTreeObjectSchema,
    provenance: z.array(PointerProvenanceSchema),
    migration: z.array(GraphMigrationRecordSchema),
    explanation: z.string().min(1),
  }),
]);
export type ContextoWireMutation = z.infer<typeof ContextoWireMutationSchema>;

export const ContextoWireResponseSchema = z.strictObject({
  mutation: ContextoWireMutationSchema,
});
export type ContextoWireResponse = z.infer<typeof ContextoWireResponseSchema>;

export const ContextoSemanticWireResponseSchema = z.strictObject({
  mutation: ContextoSemanticWireBatchSchema,
});
export type ContextoSemanticWireResponse = z.infer<typeof ContextoSemanticWireResponseSchema>;

export const ContextoSemanticRejectionSchema = z.strictObject({
  explanation: z.string().min(1),
  reason: z.string().min(1),
});
export type ContextoSemanticRejection = z.infer<typeof ContextoSemanticRejectionSchema>;

export const GraphDiffSchema = z.strictObject({
  op: z.enum(["add", "replace", "remove", "move"]),
  path: z.string(),
  from: z.string().optional(),
  before: JsonValueSchema.optional(),
  after: JsonValueSchema.optional(),
});
export type GraphDiff = z.infer<typeof GraphDiffSchema>;

export const ContextoCoverageStatusSchema = z.enum([
  "graph_covered",
  "duplicate",
  "session_index_fallback",
]);
export type ContextoCoverageStatus = z.infer<typeof ContextoCoverageStatusSchema>;

export const ContextoSignalCoverageSchema = z.strictObject({
  signalId: z.string().min(1),
  sessionId: z.string().min(1),
  turnIndex: z.number().int().nonnegative(),
  text: z.string().min(1),
  status: ContextoCoverageStatusSchema,
  requiredAnchors: z.array(z.string().min(1)),
  matchedAnchors: z.array(z.string().min(1)),
  matchedUpdateIndices: z.array(z.number().int().nonnegative()),
  matchedPointers: z.array(z.string().startsWith("/context/")),
  rationale: z.enum([
    "accepted_update",
    "existing_memory",
    "no_deterministic_match",
  ]),
});
export type ContextoSignalCoverage = z.infer<typeof ContextoSignalCoverageSchema>;

export const ContextoCoverageRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  batchId: z.string().min(1),
  graphRevisionBefore: z.number().int().nonnegative(),
  graphRevisionAfter: z.number().int().nonnegative(),
  graphHash: z.string().min(1),
  highPrioritySignalCount: z.number().int().nonnegative(),
  counts: z.strictObject({
    graphCovered: z.number().int().nonnegative(),
    duplicate: z.number().int().nonnegative(),
    sessionIndexFallback: z.number().int().nonnegative(),
  }),
  signals: z.array(ContextoSignalCoverageSchema),
});
export type ContextoCoverageRecord = z.infer<typeof ContextoCoverageRecordSchema>;

export const GraphMutationRecordSchema = z.strictObject({
  batchId: z.string(),
  sessionIds: z.array(z.string()),
  mode: z.enum(["semantic_updates", "patch", "replace_graph", "rejected"]),
  explanation: z.string(),
  accepted: z.boolean(),
  rejectionReason: z.string().optional(),
  diffs: z.array(GraphDiffSchema),
  graphRevisionBefore: z.number().int().nonnegative(),
  graphRevisionAfter: z.number().int().nonnegative(),
  graphHash: z.string(),
  acceptedUpdateCount: z.number().int().nonnegative().optional(),
  rejectedUpdates: z.array(
    z.strictObject({
      index: z.number().int().nonnegative(),
      reason: z.string().min(1),
    }),
  ).optional(),
  auditWarnings: z.array(z.string().min(1)).optional(),
  coverage: ContextoCoverageRecordSchema.optional(),
  mutation: ContextoMutationSchema.optional(),
});
export type GraphMutationRecord = z.infer<typeof GraphMutationRecordSchema>;

export const ShinoOutputSchema = z.strictObject({ summary: z.string().min(1) });
export type ShinoOutput = z.infer<typeof ShinoOutputSchema>;

export const SessionSummaryRecordSchema = z.strictObject({
  windowId: z.string(),
  sessionIds: z.array(z.string()).min(1),
  graphRevision: z.number().int().nonnegative(),
  summary: z.string().min(1),
});
export type SessionSummaryRecord = z.infer<typeof SessionSummaryRecordSchema>;

export const ReaderAnswerModeSchema = z.enum([
  "direct",
  "knowledge_update",
  "temporal_comparison",
  "multi_session",
  "preference",
  "assistant_answer",
  "abstain",
]);
export const ReaderSessionPurposeSchema = z.enum([
  "direct_answer",
  "operand",
  "older_state",
  "newer_state",
  "context",
]);
export const ReaderPlanSchema = z.strictObject({
  supportStatus: z.enum(["sufficient", "conflicted", "insufficient"]),
  answerMode: ReaderAnswerModeSchema,
  selectedSessions: z.array(z.strictObject({
    sessionId: z.string().min(1),
    turnIndexes: z.array(z.number().int().nonnegative()).min(1).max(32),
    purpose: ReaderSessionPurposeSchema,
  })).max(8),
  selectedGraphPointers: z.array(z.string().startsWith("/context/")).max(12),
  evidenceFacts: z.array(z.strictObject({
    statement: z.string().min(1),
    sessionIds: z.array(z.string().min(1)).max(8),
    graphPointers: z.array(z.string().startsWith("/context/")).max(12),
  })).max(12),
  conflicts: z.array(z.strictObject({
    olderStatement: z.string().min(1),
    newerStatement: z.string().min(1),
    resolution: z.string().min(1),
  })).max(6),
});
export type ReaderPlan = z.infer<typeof ReaderPlanSchema>;

export const CompactEvidenceTurnSchema = z.strictObject({
  turnIndex: z.number().int().nonnegative(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  selection: z.enum(["reader_selected", "adjacent_context"]),
});
export const CompactEvidenceSessionSchema = z.strictObject({
  sessionId: z.string().min(1),
  date: z.string().min(1),
  purposes: z.array(ReaderSessionPurposeSchema),
  turns: z.array(CompactEvidenceTurnSchema),
});
export const CompactGraphEvidenceSchema = z.strictObject({
  pointer: z.string().startsWith("/context/"),
  value: JsonValueSchema,
  sources: z.array(SourceReferenceSchema),
});
export const CompactFinalEvidencePayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  readerDecision: z.strictObject({
    supportStatus: z.enum(["sufficient", "conflicted", "insufficient"]),
    answerMode: ReaderAnswerModeSchema,
  }),
  evidenceFacts: ReaderPlanSchema.shape.evidenceFacts,
  conflicts: ReaderPlanSchema.shape.conflicts,
  graphEvidence: z.array(CompactGraphEvidenceSchema).max(12),
  sessions: z.array(CompactEvidenceSessionSchema).max(8),
});
export type CompactFinalEvidencePayload = z.infer<
  typeof CompactFinalEvidencePayloadSchema
>;
export const CompactFinalEvidencePackageSchema = z.strictObject({
  payload: CompactFinalEvidencePayloadSchema,
  byteBudget: z.number().int().positive(),
  promptByteEstimate: z.number().int().nonnegative(),
  promptTokenEstimate: z.number().int().nonnegative(),
  omittedItems: z.array(z.string()),
});
export type CompactFinalEvidencePackage = z.infer<
  typeof CompactFinalEvidencePackageSchema
>;

export const FinalContextSchema = z.strictObject({
  question: z.string(),
  questionDate: z.string(),
  readerPlan: ReaderPlanSchema,
  evidencePackage: CompactFinalEvidencePackageSchema,
});
export type FinalContext = z.infer<typeof FinalContextSchema>;

export const FinalEvidenceSchema = z.strictObject({
  sessionId: z.string().min(1),
  turnIndex: z.number().int().nonnegative().nullable(),
});
export const FinalAnswerSchema = z.strictObject({
  hypothesis: z.string(),
  evidence: z.array(FinalEvidenceSchema),
  supportStatus: z.enum(["supported", "conflicted", "insufficient"]),
});
export type FinalAnswer = z.infer<typeof FinalAnswerSchema>;

export const NormalizedGenerationSchema = z.strictObject({
  text: z.string(),
  model: z.string(),
  provider: z.enum(["openai", "gemini"]),
  usage: z.strictObject({
    input_tokens: z.number().int().nonnegative().nullable(),
    output_tokens: z.number().int().nonnegative().nullable(),
    total_tokens: z.number().int().nonnegative().nullable(),
  }),
  latency_ms: z.number().nonnegative(),
  request_id: z.string().nullable(),
  retry_count: z.number().int().nonnegative(),
});
export type NormalizedGeneration = z.infer<typeof NormalizedGenerationSchema>;

export const AnswerResultSchema = z.strictObject({
  hypothesis: z.string(),
  evidence: z.array(
    z.strictObject({
      session_id: z.string(),
      turn_index: z.number().int().nonnegative().nullable().optional(),
    }),
  ),
  trace: JsonObjectSchema,
  generation: NormalizedGenerationSchema.optional(),
});
export type AnswerResult = z.infer<typeof AnswerResultSchema>;

export const TokenUsageSchema = z.strictObject({
  input_tokens: z.number().int().nonnegative().nullable(),
  output_tokens: z.number().int().nonnegative().nullable(),
  total_tokens: z.number().int().nonnegative().nullable(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const ModelCallRecordSchema = z.strictObject({
  sequence: z.number().int().positive(),
  role: z.string(),
  kind: z.literal("generation"),
  provider: z.enum(["openai", "gemini"]),
  model: z.string(),
  input_sha256: z.string(),
  item_count: z.literal(1),
  parameters: JsonObjectSchema,
  usage: TokenUsageSchema,
  latency_ms: z.number().nonnegative(),
  request_id: z.string().nullable(),
  retry_count: z.number().int().nonnegative(),
});
export type ModelCallRecord = z.infer<typeof ModelCallRecordSchema>;

export const ProviderRoleConfigSchema = z.strictObject({
  kind: z.literal("generation").default("generation"),
  provider: z.enum(["openai", "gemini"]),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).default(0),
  reasoning_effort: z
    .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
    .nullable()
    .optional(),
  max_output_tokens: z.number().int().positive().default(8000),
  timeout_seconds: z.number().positive().default(300),
  concurrency: z.number().int().positive().max(64).default(1),
  max_retries: z.number().int().nonnegative().max(20).default(5),
  min_request_interval_seconds: z.number().nonnegative().default(0),
  input_price_per_million: z.number().nonnegative().nullable().optional(),
  output_price_per_million: z.number().nonnegative().nullable().optional(),
});
export type ProviderRoleConfig = z.infer<typeof ProviderRoleConfigSchema>;

export const PromptMessageSchema = z.strictObject({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});
export type PromptMessage = z.infer<typeof PromptMessageSchema>;

export type PromptEnvelope = {
  promptId: string;
  messages: PromptMessage[];
};

export type AgentState = {
  action: "ingest" | "answer" | "resume";
  caseId: string;
  questionType: string;
  sessions: TimestampedSession[];
  incomingSession: TimestampedSession | null;
  graph: MasterContextGraph;
  graphTrackedCount: number;
  summaryTrackedCount: number;
  pendingMutation: ContextoMutation | null;
  pendingMutationRejection: ContextoSemanticRejection | null;
  mutationRecords: GraphMutationRecord[];
  pendingSummary: ShinoOutput | null;
  summaries: SessionSummaryRecord[];
  question: string;
  questionDate: string;
  retrievalManifest: RetrievalIndexManifest | null;
  retrievalCandidates: RetrievalCandidates | null;
  readerPlan: ReaderPlan | null;
  readerGeneration: NormalizedGeneration | null;
  finalContext: FinalContext | null;
  finalAnswerOutput: FinalAnswer | null;
  answerGeneration: NormalizedGeneration | null;
  answerResult: AnswerResult | null;
  warnings: string[];
  currentNode: string;
};
