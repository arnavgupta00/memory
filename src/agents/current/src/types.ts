import { z } from "zod";

export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

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

export type TurnRole = "user" | "assistant";

export type Turn = {
  role: TurnRole;
  content: string;
};

export const TurnSchema = z.looseObject({
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

export const TokenUsageSchema = z.strictObject({
  input_tokens: z.number().int().nonnegative().nullable(),
  output_tokens: z.number().int().nonnegative().nullable(),
  total_tokens: z.number().int().nonnegative().nullable(),
  /** OpenAI Responses API: tokens spent inside reasoning, billed as output. */
  reasoning_tokens: z.number().int().nonnegative().nullable().optional(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const NormalizedGenerationSchema = z.strictObject({
  text: z.string(),
  model: z.string(),
  provider: z.enum(["openai", "gemini"]),
  usage: TokenUsageSchema,
  latency_ms: z.number().nonnegative(),
  request_id: z.string().nullable(),
  retry_count: z.number().int().nonnegative(),
});
export type NormalizedGeneration = z.infer<typeof NormalizedGenerationSchema>;

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

export const AnswerEvidenceSchema = z.strictObject({
  sessionId: z.string().min(1),
  turnIndex: z.number().int().nonnegative().nullable(),
});

/** Dated fact pulled from memory before committing to a hypothesis. */
export const EvidenceTableEntrySchema = z.strictObject({
  date: z.string(),
  fact: z.string().min(1),
  // OpenAI structured outputs require every key; use null when unknown.
  sessionId: z.string().min(1).nullable(),
  turnIndex: z.number().int().nonnegative().nullable(),
});

export const AnswerOutputSchema = z.strictObject({
  evidenceTable: z.array(EvidenceTableEntrySchema).max(32),
  hypothesis: z.string(),
  evidence: z.array(AnswerEvidenceSchema).max(16),
  supportStatus: z.enum(["supported", "insufficient"]),
});
export type AnswerOutput = z.infer<typeof AnswerOutputSchema>;

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

export const UNAVAILABLE_MEMORY_HYPOTHESIS =
  "The available memory does not contain this information.";
