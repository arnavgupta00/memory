import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import OpenAI from "openai";
import { getEncoding } from "js-tiktoken";
import { z } from "zod";

import {
  CostBudget,
  DispatchGate,
  callStructured,
  mapPool,
  priceTableSha256,
  type ReasoningEffort,
  type StructuredCallAttemptTrace,
  type StructuredCallResult,
} from "../compression/structuredCall.js";
import {
  ApprovalExecutionBindingSchema,
  SignedApprovalReceiptSchema,
  appendApprovalTransition,
  verifyCanonicalAcceptedPrerequisite,
  verifyAndConsumeApproval,
  writeApprovalRequest,
  type ApprovalExecutionBinding,
} from "../ingestion/structuredEventApprovalV1.js";
import {
  LinkAuditOutputSchema,
  LinkerOutputSchema,
  MapperPagePatchOutputSchema,
  MapperPageOutputSchema,
  asciiIdSort,
  canonicalJson,
  type DerivationOccurrence,
  type JsonValue,
  type Attempt,
  type LinkAuditOutput,
  type LinkerOutput,
  type MapperPageOutput,
  type MapperPagePatchOutput,
} from "../ingestion/structuredEventSchemaV1.js";
import {
  createAttempt,
  createAttemptMaterializationResult,
  createAttemptSupersession,
  createDerivationOccurrence,
  buildAssistantRawLexicalPostings,
  defaultProjectionMembership,
  materializeMapperPages,
  quarantineRootKey,
  validateLifecycleLineage,
  type MapperMaterialization,
} from "../ingestion/structuredEventMaterializerV1.js";
import {
  semanticProjectionTokenMetrics,
  verifyFrozenArtifacts,
} from "../ingestion/structuredEventEvaluationV1.js";
import { appendCustodyTransition } from "../ingestion/structuredEventCustodyV1.js";
import {
  StructuredConversationInputSchema,
  applyActiveLinkEvidenceFloor,
  applyLinkAudit,
  createLinkFreezeManifest,
  createSemanticFreezeManifest,
  linkGeneration,
  materializeLinkerOutputs,
  modelPageSession,
  modelSession,
  pageSessionSegments,
  prepareConversation,
  explicitClockMinutes,
  isTerminalProviderFailure,
  repeatedTurnSemanticCountMismatches,
  runAdaptivePageRounds,
  type PreparedSession,
} from "../ingestion/structuredEventWorkflowV1.js";
import { PromptLoader } from "../services/promptLoader.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const SPEC_PATH = resolve(
  PROJECT_ROOT,
  "src/agents/current/architecture/BEAM-1M-STRUCTURED-EVENT-INGESTION-V1-SPEC.md",
);
const SCHEMA_PATH = resolve(PROJECT_ROOT, "src/agents/current/src/ingestion/structuredEventSchemaV1.ts");
const MAPPER_PROMPT_PATH = resolve(PROJECT_ROOT, "src/agents/current/prompts/beam-structured-event-map-v1.yaml");
const REPAIR_PROMPT_PATH = resolve(PROJECT_ROOT, "src/agents/current/prompts/beam-structured-event-repair-v1.yaml");
const LINKER_PROMPT_PATH = resolve(PROJECT_ROOT, "src/agents/current/prompts/beam-structured-event-link-v1.yaml");
const LINK_AUDITOR_PROMPT_PATH = resolve(PROJECT_ROOT, "src/agents/current/prompts/beam-structured-event-link-audit-v1.yaml");
const ENTAILMENT_PROMPT_PATH = resolve(PROJECT_ROOT, "src/agents/current/prompts/beam-structured-event-entailment-judge-v1.yaml");
const SUPPORT_PROMPT_PATH = resolve(PROJECT_ROOT, "src/agents/current/prompts/beam-structured-event-support-judge-v1.yaml");
const IMPLEMENTATION_PATHS = [
  SCHEMA_PATH,
  resolve(PROJECT_ROOT, "src/agents/current/src/ingestion/structuredEventMaterializerV1.ts"),
  resolve(PROJECT_ROOT, "src/agents/current/src/ingestion/structuredEventWorkflowV1.ts"),
  resolve(PROJECT_ROOT, "src/agents/current/src/ingestion/structuredEventEvaluationV1.ts"),
  resolve(PROJECT_ROOT, "src/agents/current/src/ingestion/structuredEventApprovalV1.ts"),
  resolve(PROJECT_ROOT, "src/agents/current/src/ingestion/structuredEventCustodyV1.ts"),
  resolve(PROJECT_ROOT, "src/agents/current/src/compression/structuredCall.ts"),
  resolve(PROJECT_ROOT, "src/agents/current/src/services/promptLoader.ts"),
  resolve(PROJECT_ROOT, "src/agents/current/src/scripts/beamStructuredEventEvaluationV1.ts"),
  fileURLToPath(import.meta.url),
];
const PROMPT_PATHS = [
  MAPPER_PROMPT_PATH,
  REPAIR_PROMPT_PATH,
  LINKER_PROMPT_PATH,
  LINK_AUDITOR_PROMPT_PATH,
  ENTAILMENT_PROMPT_PATH,
  SUPPORT_PROMPT_PATH,
];
const PROMPT_ROLE_PATHS = [
  ["mapper", MAPPER_PROMPT_PATH],
  ["repair", REPAIR_PROMPT_PATH],
  ["linker", LINKER_PROMPT_PATH],
  ["link_auditor", LINK_AUDITOR_PROMPT_PATH],
  ["entailment_judge", ENTAILMENT_PROMPT_PATH],
  ["support_judge", SUPPORT_PROMPT_PATH],
] as const;
const AGGREGATE_ARTIFACT_NAMES = {
  records: "records.jsonl",
  mentions: "mentions.jsonl",
  supportBindings: "supportBindings.jsonl",
  resolutionAssertions: "resolutionAssertions.jsonl",
  semanticProjections: "semanticProjections.jsonl",
  defaultProjectionMembership: "defaultProjectionMembership.jsonl",
  assistantBlocks: "assistantBlocks.jsonl",
  assistantBlockItems: "assistantBlockItems.jsonl",
  assistantBlockProjections: "assistantBlockProjections.jsonl",
  rawLexicalPostings: "rawLexicalPostings.jsonl",
  sourceSelectors: "sourceSelectors.jsonl",
  metadataSelectors: "metadataSelectors.jsonl",
  quarantines: "quarantines.jsonl",
  coverageRows: "coverageRows.jsonl",
  derivations: "derivations.jsonl",
  lifecycleEvents: "lifecycleEvents.jsonl",
  attemptResults: "attemptResults.jsonl",
  attempts: "attempts.jsonl",
  attemptSupersessions: "attemptSupersessions.jsonl",
  warnings: "warnings.jsonl",
} as const;

const DatasetConversationSchema = z.strictObject({
  conversation_id: z.union([z.string(), z.number()]),
  session_ids: z.array(z.string().min(1)),
  session_dates: z.array(z.string()),
  sessions: z.array(z.array(z.strictObject({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
  }))),
});
const DatasetSchema = z.object({ conversations: z.array(DatasetConversationSchema) });

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith("--")) continue;
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) result[argument.slice(2)] = "true";
    else {
      result[argument.slice(2)] = next;
      index += 1;
    }
  }
  return result;
}

function pathValue(value: string | undefined): string {
  if (!value) throw new Error("required path argument is missing");
  return isAbsolute(value) ? value : resolve(PROJECT_ROOT, value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fileSha(path: string): string {
  return sha256(readFileSync(path));
}

function implementationSha(): string {
  return sha256(IMPLEMENTATION_PATHS
    .map((path) => `${path}\0${fileSha(path)}`)
    .sort()
    .join("\n"));
}

function identityManifest(paths: readonly string[]): Array<{ path: string; sha256: string; byteLength: number }> {
  return [...paths].sort().map((path) => ({
    path,
    sha256: fileSha(path),
    byteLength: readFileSync(path).length,
  }));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(path: string, values: readonly unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, values.length === 0 ? "" : `${values.map((value) => JSON.stringify(value)).join("\n")}\n`);
}

function dedupeCanonical<T>(values: readonly T[], id: (value: T) => string): T[] {
  const output = new Map<string, T>();
  for (const value of values) {
    const key = id(value);
    const prior = output.get(key);
    if (
      prior !== undefined
      && canonicalJson(prior as unknown as JsonValue) !== canonicalJson(value as unknown as JsonValue)
    ) throw new Error(`same ID ${key} has different canonical bytes across ingestion partitions`);
    output.set(key, value);
  }
  return [...output.values()].sort((left, right) => Buffer.compare(Buffer.from(id(left)), Buffer.from(id(right))));
}

function dedupeJsonValues(values: readonly unknown[]): JsonValue[] {
  const output = new Map<string, JsonValue>();
  for (const value of values) {
    const parsed = value as JsonValue;
    output.set(canonicalJson(parsed), parsed);
  }
  return [...output.values()];
}

function firstAttemptResults(passes: readonly MapperMaterialization[]): MapperMaterialization["attemptResults"] {
  const byAttempt = new Map<string, MapperMaterialization["attemptResults"][number]>();
  for (const result of passes.flatMap((pass) => pass.attemptResults)) {
    if (!byAttempt.has(result.attemptId)) byAttempt.set(result.attemptId, result);
  }
  return [...byAttempt.values()].sort((left, right) =>
    Buffer.compare(Buffer.from(left.attemptId), Buffer.from(right.attemptId)));
}

/** Keeps searchable state from the final active pass while retaining append-only custody evidence from every pass. */
export function selectActiveAndHistoricalMaterializationArtifacts(args: {
  activePasses: readonly MapperMaterialization[];
  historicalPasses: readonly MapperMaterialization[];
}): Pick<MapperMaterialization,
  | "records"
  | "mentions"
  | "supportBindings"
  | "resolutionAssertions"
  | "semanticProjections"
  | "assistantBlocks"
  | "assistantBlockItems"
  | "assistantBlockProjections"
  | "sourceSelectors"
  | "metadataSelectors"
  | "quarantines"
  | "derivations"
  | "lifecycleEvents"
  | "attemptResults"
  | "warnings"
> {
  return {
    records: dedupeCanonical(args.activePasses.flatMap((item) => item.records), (value) => value.recordId),
    mentions: dedupeCanonical(args.activePasses.flatMap((item) => item.mentions), (value) => value.mentionId),
    supportBindings: dedupeCanonical(
      args.activePasses.flatMap((item) => item.supportBindings),
      (value) => value.supportBindingId,
    ),
    resolutionAssertions: dedupeCanonical(
      args.activePasses.flatMap((item) => item.resolutionAssertions),
      (value) => value.resolutionId,
    ),
    semanticProjections: dedupeCanonical(
      args.activePasses.flatMap((item) => item.semanticProjections),
      (value) => value.projectionId,
    ),
    assistantBlocks: dedupeCanonical(
      args.activePasses.flatMap((item) => item.assistantBlocks),
      (value) => value.blockId,
    ),
    assistantBlockItems: dedupeCanonical(
      args.activePasses.flatMap((item) => item.assistantBlockItems),
      (value) => value.itemId,
    ),
    assistantBlockProjections: dedupeCanonical(
      args.activePasses.flatMap((item) => item.assistantBlockProjections),
      (value) => value.projectionId,
    ),
    sourceSelectors: dedupeCanonical(
      args.historicalPasses.flatMap((item) => item.sourceSelectors),
      (value) => value.selectorId,
    ),
    metadataSelectors: dedupeCanonical(
      args.historicalPasses.flatMap((item) => item.metadataSelectors),
      (value) => value.metadataSelectorId,
    ),
    quarantines: dedupeCanonical(
      args.historicalPasses.flatMap((item) => item.quarantines),
      (value) => value.quarantineId,
    ),
    derivations: dedupeCanonical(
      args.historicalPasses.flatMap((item) => item.derivations),
      (value) => value.derivationId,
    ),
    lifecycleEvents: dedupeCanonical(
      args.historicalPasses.flatMap((item) => item.lifecycleEvents),
      (value) => value.lifecycleEventId,
    ),
    // A later repair can change the global materialization context for an
    // older, still-active attempt. Its result is an immutable snapshot of the
    // first materialization, so retain that first result rather than emitting
    // a second outcome for the same attempt.
    attemptResults: firstAttemptResults(args.historicalPasses),
    warnings: dedupeJsonValues(args.historicalPasses.flatMap((item) => item.warnings)) as MapperMaterialization["warnings"],
  };
}

type LinkCandidateObject = {
  objectType: "record" | "mention" | "block" | "item";
  objectId: string;
  sessionOrdinal: number;
  turnOrdinal: number;
  routingText: string;
  value: JsonValue;
  provenance: JsonValue;
};

function lexicalKeys(value: string): string[] {
  const stop = new Set(["about", "after", "again", "also", "been", "before", "could", "from", "have", "into", "just", "more", "some", "that", "their", "then", "there", "these", "they", "this", "with", "would"]);
  return [...new Set((value.toLocaleLowerCase("und").match(/[\p{L}\p{N}][\p{L}\p{N}_'-]{2,}/gu) ?? [])
    .filter((term) => !stop.has(term)))];
}

function linkCandidateBatches(objectsValue: readonly LinkCandidateObject[], maximum: number): LinkCandidateObject[][] {
  if (!Number.isInteger(maximum) || maximum < 8) throw new Error("link chunk size must be an integer of at least 8");
  const objects = [...objectsValue].sort((left, right) =>
    left.sessionOrdinal - right.sessionOrdinal
    || left.turnOrdinal - right.turnOrdinal
    || Buffer.compare(Buffer.from(left.objectId), Buffer.from(right.objectId)),
  );
  const candidates: LinkCandidateObject[][] = [];
  const stride = Math.max(1, Math.floor(maximum / 2));
  for (let start = 0; start < objects.length; start += stride) {
    candidates.push(objects.slice(start, start + maximum));
    if (start + maximum >= objects.length) break;
  }
  const inverted = new Map<string, LinkCandidateObject[]>();
  for (const object of objects) {
    for (const term of lexicalKeys(object.routingText)) {
      const values = inverted.get(term) ?? [];
      values.push(object);
      inverted.set(term, values);
    }
  }
  const parent = new Map(objects.map((object) => [object.objectId, object.objectId]));
  const find = (id: string): string => {
    const current = parent.get(id);
    if (!current) throw new Error(`link candidate union lost ${id}`);
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  for (const values of inverted.values()) {
    const unique = [...new Map(values.map((value) => [value.objectId, value])).values()];
    if (unique.length < 2 || unique.length > maximum * 4) continue;
    const first = unique[0];
    if (!first) continue;
    for (const object of unique.slice(1)) union(first.objectId, object.objectId);
  }
  const components = new Map<string, LinkCandidateObject[]>();
  for (const object of objects) {
    const root = find(object.objectId);
    const values = components.get(root) ?? [];
    values.push(object);
    components.set(root, values);
  }
  for (const values of components.values()) {
    if (values.length < 2) continue;
    for (let start = 0; start < values.length; start += stride) {
      candidates.push(values.slice(start, start + maximum));
      if (start + maximum >= values.length) break;
    }
  }
  const batches = new Map<string, LinkCandidateObject[]>();
  for (const candidate of candidates) {
    if (candidate.length < 2) continue;
    const key = asciiIdSort(candidate.map((value) => value.objectId)).join("\0");
    batches.set(key, candidate);
  }
  return [...batches.values()];
}

function callArtifact<T>(call: StructuredCallResult<T>): Record<string, unknown> {
  return {
    value: call.value,
    outputText: call.outputText,
    usage: call.usage,
    latencyMs: call.latencyMs,
    requestId: call.requestId,
    retryCount: call.retryCount,
    inputSha256: call.inputSha256,
    promptCacheKey: call.promptCacheKey,
    estimatedCostUsd: call.estimatedCostUsd,
    promptMessages: call.promptMessages,
    responseStatus: call.responseStatus,
    incompleteReason: call.incompleteReason,
  };
}

function requiredNumber(args: Record<string, string>, key: string): number {
  const value = Number(args[key]);
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${key} must be a nonnegative number`);
  return value;
}

function positiveInteger(args: Record<string, string>, key: string): number {
  const value = requiredNumber(args, key);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`--${key} must be a positive integer`);
  return value;
}

function reasoning(value: string | undefined, fallback: ReasoningEffort): ReasoningEffort {
  const resolved = value ?? fallback;
  if (resolved !== "low" && resolved !== "medium" && resolved !== "high") {
    throw new Error(`unsupported reasoning effort ${resolved}`);
  }
  return resolved;
}

function modelBinding(args: Record<string, string>): ApprovalExecutionBinding["models"] {
  const concurrency = positiveInteger(args, "concurrency");
  return [
    {
      role: "mapper",
      model: args["mapper-model"] ?? "gpt-5.4-nano-2026-03-17",
      reasoning: reasoning(args["mapper-reasoning"], "low"),
      concurrency,
    },
    {
      role: "repair",
      model: args["repair-model"] ?? "gpt-5.6-luna",
      reasoning: reasoning(args["repair-reasoning"], "medium"),
      concurrency,
    },
    {
      role: "linker",
      model: args["linker-model"] ?? "gpt-5.6-luna",
      reasoning: reasoning(args["linker-reasoning"], "medium"),
      concurrency,
    },
    {
      role: "entailment_judge",
      model: args["entailment-model"] ?? "gpt-5.6-luna",
      reasoning: reasoning(args["entailment-reasoning"], "medium"),
      concurrency,
    },
    {
      role: "support_judge",
      model: args["support-model"] ?? "gpt-5.6-luna",
      reasoning: reasoning(args["support-reasoning"], "medium"),
      concurrency,
    },
  ];
}

const PRIOR_RUNG = {
  L2: "L1",
  L3: "L2",
  L4: "L3",
  L5: "L4",
  L6: "L5",
  L7: "L6",
} as const;

function acceptedPriorRung(args: Record<string, string>): {
  rung: (typeof PRIOR_RUNG)[keyof typeof PRIOR_RUNG];
  resultSha256: string;
  receiptSha256: string;
  ledgerSha256: string;
} {
  const rung = args.rung as keyof typeof PRIOR_RUNG;
  const priorRung = PRIOR_RUNG[rung];
  if (!priorRung) throw new Error("structured-event ingestion runner supports only L2 through L7");
  const expectedResultSha256 = args["prerequisite-result-hash"];
  if (!expectedResultSha256 || !/^[a-f0-9]{64}$/.test(expectedResultSha256)) {
    throw new Error("--prerequisite-result-hash is required");
  }
  const resultPath = pathValue(args["prerequisite-result"]);
  const receiptPath = pathValue(args["prerequisite-receipt"]);
  const ledgerPath = pathValue(args["prerequisite-ledger"]);
  const encodedKey = process.env.BEAM_TEST_APPROVAL_HMAC_KEY;
  if (!encodedKey) throw new Error("BEAM_TEST_APPROVAL_HMAC_KEY is required to authenticate the prerequisite rung");
  verifyCanonicalAcceptedPrerequisite({
    signedReceipt: JSON.parse(readFileSync(receiptPath, "utf8")),
    verificationKey: Buffer.from(encodedKey, "base64"),
    expectedKeyId: args["approval-key-id"] ?? "beam-test-control-v1",
    expectedRung: priorRung,
    expectedResultSha256,
    ledgerPath,
    resultPath,
    canonicalResultFilename: priorRung === "L1"
      ? "l1-deterministic-fixtures-result.json"
      : "typed-evaluation-result.json",
  });
  return {
    rung: priorRung,
    resultSha256: expectedResultSha256,
    receiptSha256: fileSha(receiptPath),
    ledgerSha256: fileSha(ledgerPath),
  };
}

function executionConfiguration(args: Record<string, string>): Record<string, unknown> {
  const prerequisite = acceptedPriorRung(args);
  return {
    conversationId: args["conversation-id"],
    sourceDatasetSha256: args["source-dataset-hash"],
    evaluationManifestSha256: args["evaluation-manifest-hash"],
    evaluationRole: args["evaluation-role"],
    sessionLimit: args["session-limit"] ?? null,
    contextSessions: Number(args["context-sessions"] ?? 2),
    maximumStructuralSegmentBytes: Number(args["max-structural-segment-bytes"] ?? 2_000),
    maxSegmentsPerPage: Number(args["max-segments-per-page"] ?? 12),
    mapperMaxOutputTokens: Number(args["mapper-max-output"] ?? 64_000),
    repairMaxOutputTokens: Number(args["repair-max-output"] ?? 64_000),
    linkerMaxOutputTokens: Number(args["linker-max-output"] ?? 64_000),
    judgeMaxOutputTokens: Number(args["judge-max-output"] ?? 16_000),
    supportMaxOutputTokens: Number(args["support-max-output"] ?? 16_000),
    linkChunkSize: Number(args["link-chunk-size"] ?? 120),
    judgeBatchSize: Number(args["judge-batch-size"] ?? 120),
    precisionSampleSize: Number(args["precision-sample-size"] ?? 100),
    prerequisiteEvidence: prerequisite,
    tokenBudget: Number(args["token-budget"] ?? 1_900_000),
    promptRoleBindings: PROMPT_ROLE_PATHS.map(([role, path]) => ({ role, sha256: fileSha(path) })),
    models: modelBinding(args),
  };
}

function expectedBinding(args: Record<string, string>): ApprovalExecutionBinding {
  const prerequisite = acceptedPriorRung(args);
  const promptSha256s = PROMPT_PATHS.map(fileSha).sort();
  const configurationSha256 = sha256(canonicalJson(executionConfiguration(args) as JsonValue));
  return ApprovalExecutionBindingSchema.parse({
    rung: args.rung,
    cohortHash: args["cohort-hash"],
    prerequisiteResultHashes: [prerequisite.resultSha256],
    specificationSha256: fileSha(SPEC_PATH),
    codeSha256: implementationSha(),
    promptSha256s,
    schemaSha256: fileSha(SCHEMA_PATH),
    configurationSha256,
    models: modelBinding(args),
    forecastCostUsd: requiredNumber(args, "forecast-cost"),
    hardSpendCeilingUsd: requiredNumber(args, "hard-spend-ceiling"),
    priceTableSha256: priceTableSha256(),
    outputDirectory: pathValue(args.out),
  });
}

async function packet(args: Record<string, string>): Promise<void> {
  const binding = expectedBinding(args);
  const output = pathValue(args["request-out"]);
  writeApprovalRequest(output, binding, {
    objective: "Run one approved structured-event ingestion rung, freeze semantic and query-blind link artifacts, then evaluate only the bound typed obligations.",
    inputs: {
      cohortHash: binding.cohortHash,
      sourceDatasetSha256: args["source-dataset-hash"],
      evaluationManifestSha256: args["evaluation-manifest-hash"],
      conversationId: args["conversation-id"],
      sessionLimit: args["session-limit"] ?? null,
    },
    expectedSpendUsd: { forecast: binding.forecastCostUsd, hardCeiling: binding.hardSpendCeilingUsd },
    expectedWallTime: args["expected-wall-time"],
    passFailGates: JSON.parse(args["gates-json"] ?? "[]") as JsonValue,
    stopConditions: [
      "Any incomplete mapper/repair/linker output blocks freeze or evaluation.",
      "Any artifact/hash/custody mismatch fails the rung.",
      "Any exact typed gate failure blocks escalation.",
      "The cost guard pauses before dispatch that would exceed the approved ceiling.",
    ],
    retainedOutputDirectory: binding.outputDirectory,
  });
  console.log(JSON.stringify({ event: "approval_request_written", output, binding }, null, 2));
}

function inputConversation(args: Record<string, string>, datasetPath: string): z.infer<typeof DatasetConversationSchema> {
  const bytes = readFileSync(datasetPath);
  if (sha256(bytes) !== args["source-dataset-hash"]) throw new Error("opened dataset does not match approved source-dataset hash");
  const dataset = DatasetSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  const value = dataset.conversations.find((conversation) =>
    String(conversation.conversation_id) === String(args["conversation-id"]),
  );
  if (!value) throw new Error("approved conversation not found in dataset");
  return value;
}

function preparedInput(conversation: z.infer<typeof DatasetConversationSchema>): z.infer<typeof StructuredConversationInputSchema> {
  return StructuredConversationInputSchema.parse({
    conversationId: conversation.conversation_id,
    sessionIds: conversation.session_ids,
    sessionDates: conversation.session_dates,
    sessions: conversation.sessions,
  });
}

type SessionRun = {
  session: PreparedSession;
  pages: MapperPageOutput[];
  attempts: Attempt[];
  materialized: MapperMaterialization;
  materializationPasses: MapperMaterialization[];
  repairedPageNumbers: number[];
  callArtifactPaths: string[];
};

type PageCall = {
  output: MapperPageOutput | null;
  attempt: Attempt;
  error: string | null;
  artifactPath: string;
};

export function activePageAfterRepair<
  TPrior extends { output: unknown | null },
  TRepair extends { output: unknown | null },
>(prior: TPrior, repair: TRepair): TPrior | TRepair {
  return repair.output === null ? prior : repair;
}

function objectForDerivation(pass: MapperMaterialization, derivation: DerivationOccurrence): JsonValue | null {
  const collections: Partial<Record<DerivationOccurrence["objectType"], readonly unknown[]>> = {
    mention: pass.mentions,
    record: pass.records,
    support_binding: pass.supportBindings,
    resolution: pass.resolutionAssertions,
    projection: [...pass.semanticProjections, ...pass.assistantBlockProjections],
    block: pass.assistantBlocks,
    item: pass.assistantBlockItems,
  };
  const object = collections[derivation.objectType]?.find((value) =>
    typeof value === "object" && value !== null && Object.values(value).includes(derivation.objectId));
  return object === undefined ? null : object as JsonValue;
}

function proposalIsAffected(proposalLocalKey: string, affectedRoots: ReadonlySet<string>): boolean {
  return [...affectedRoots].some((root) =>
    proposalLocalKey === root || proposalLocalKey.startsWith(`${root}:`));
}

const REPAIR_ROOT_OBJECT_TYPES = new Set<DerivationOccurrence["objectType"]>([
  "mention", "record", "block", "resolution",
]);

function crossTypeCollisionRoots(args: {
  prior: MapperMaterialization;
  repairedParentAttemptIds: ReadonlySet<string>;
}): Set<string> {
  const rootOwners = new Map<string, Set<DerivationOccurrence["objectType"]>>();
  const addOwner = (proposalLocalKey: string, objectType: DerivationOccurrence["objectType"]): void => {
    const owners = rootOwners.get(proposalLocalKey) ?? new Set<DerivationOccurrence["objectType"]>();
    owners.add(objectType);
    rootOwners.set(proposalLocalKey, owners);
  };
  for (const derivation of args.prior.derivations.filter((value) =>
    args.repairedParentAttemptIds.has(value.attemptId) && REPAIR_ROOT_OBJECT_TYPES.has(value.objectType))) {
    addOwner(derivation.proposalLocalKey, derivation.objectType);
  }
  for (const quarantine of args.prior.quarantines.filter((value) =>
    args.repairedParentAttemptIds.has(value.attemptId))) {
    const objectType: DerivationOccurrence["objectType"] | null = quarantine.objectType === "assistant_block"
      ? "block"
      : quarantine.objectType === "coverage"
        ? null
        : quarantine.objectType;
    if (objectType !== null) addOwner(quarantine.localObjectKey, objectType);
  }
  return new Set([...rootOwners]
    .filter(([, owners]) => owners.size > 1)
    .map(([proposalLocalKey]) => proposalLocalKey));
}

/**
 * Expands a quarantined proposal root to every deterministic child proposal
 * that a valid targeted repair is allowed to recreate. The model still owns
 * the replacement content; this only defines the preservation-check boundary.
 */
export function repairAffectedProposalRoots(args: {
  prior: MapperMaterialization;
  current: MapperMaterialization;
  repairedParentAttemptIds: ReadonlySet<string>;
  repairAttemptIds: ReadonlySet<string>;
  repairedRootKeys?: ReadonlySet<string>;
}): Set<string> {
  const roots = new Set<string>();
  for (const quarantine of args.prior.quarantines.filter((value) =>
    args.repairedParentAttemptIds.has(value.attemptId)
    && (args.repairedRootKeys === undefined || args.repairedRootKeys.has(value.localObjectKey)))) {
    roots.add(quarantine.localObjectKey);
    if (typeof quarantine.draft !== "object" || quarantine.draft === null || Array.isArray(quarantine.draft)) continue;
    if (quarantine.objectType === "assistant_block") {
      const items = quarantine.draft.items;
      if (Array.isArray(items)) {
        for (const item of items) {
          if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
          if (typeof item.localItemKey === "string") roots.add(item.localItemKey);
        }
      }
    }
    if (quarantine.objectType === "resolution") {
      const targetRecordLocalKey = quarantine.draft.targetRecordLocalKey;
      if (typeof targetRecordLocalKey === "string") roots.add(`${targetRecordLocalKey}:projection`);
    }
  }
  for (const proposalLocalKey of crossTypeCollisionRoots(args)) roots.add(proposalLocalKey);
  const priorAffectedBlockIds = new Set(args.prior.derivations.filter((value) =>
    args.repairedParentAttemptIds.has(value.attemptId)
    && value.objectType === "block"
    && proposalIsAffected(value.proposalLocalKey, roots))
    .map((value) => value.objectId));
  const repairedBlockIds = new Set(args.current.derivations.filter((value) =>
    args.repairAttemptIds.has(value.attemptId)
    && value.objectType === "block"
    && (proposalIsAffected(value.proposalLocalKey, roots) || priorAffectedBlockIds.has(value.objectId)))
    .map((value) => value.objectId));
  const repairedItemIds = new Set(args.current.assistantBlockItems
    .filter((item) => repairedBlockIds.has(item.blockId))
    .map((item) => item.itemId));
  for (const derivation of args.current.derivations.filter((value) =>
    args.repairAttemptIds.has(value.attemptId)
    && value.objectType === "item"
    && repairedItemIds.has(value.objectId))) {
    roots.add(derivation.proposalLocalKey);
  }
  return roots;
}

/**
 * Full-page model output is accepted only when every unaffected derived object
 * remains byte-identical. This is a losslessness check, not semantic repair.
 */
export function targetedRepairPreservationErrors(args: {
  prior: MapperMaterialization;
  current: MapperMaterialization;
  repairedParentAttemptIds: ReadonlySet<string>;
  repairAttemptIds: ReadonlySet<string>;
  affectedProposalRoots: ReadonlySet<string>;
}): string[] {
  const collisionRoots = crossTypeCollisionRoots(args);
  const priorAffectedObjectIds = new Set(args.prior.derivations
    .filter((value) =>
      args.repairedParentAttemptIds.has(value.attemptId)
      && proposalIsAffected(value.proposalLocalKey, args.affectedProposalRoots))
    .map((value) => value.objectId));
  const priorCandidates = args.prior.derivations.filter((value) =>
    args.repairedParentAttemptIds.has(value.attemptId)
    && value.objectType !== "link"
    && !proposalIsAffected(value.proposalLocalKey, args.affectedProposalRoots));
  const errors: string[] = [];
  for (const prior of args.prior.derivations.filter((value) =>
    args.repairedParentAttemptIds.has(value.attemptId)
    && proposalIsAffected(value.proposalLocalKey, collisionRoots))) {
    const preserved = args.current.derivations.some((value) =>
      value.objectType === prior.objectType && value.objectId === prior.objectId);
    if (!preserved) {
      errors.push(`collision repair changed prior ${prior.objectType}:${prior.proposalLocalKey}`);
    }
  }
  for (const prior of priorCandidates) {
    const current = args.current.derivations.find((value) =>
      value.objectType === prior.objectType
      && value.proposalLocalKey === prior.proposalLocalKey
      && value.objectId === prior.objectId);
    const priorObject = objectForDerivation(args.prior, prior);
    const currentObject = current ? objectForDerivation(args.current, current) : null;
    if (!current || priorObject === null || currentObject === null
      || canonicalJson(priorObject) !== canonicalJson(currentObject)) {
      errors.push(`repair changed unaffected ${prior.objectType}:${prior.proposalLocalKey}`);
    }
  }
  for (const current of args.current.derivations.filter((value) =>
    args.repairAttemptIds.has(value.attemptId)
    && value.objectType !== "link"
    && !proposalIsAffected(value.proposalLocalKey, args.affectedProposalRoots)
    && !priorAffectedObjectIds.has(value.objectId))) {
    const prior = args.prior.derivations.find((value) =>
      args.repairedParentAttemptIds.has(value.attemptId)
      && value.objectType === current.objectType
      && value.proposalLocalKey === current.proposalLocalKey
      && value.objectId === current.objectId);
    if (!prior) errors.push(`repair added unrelated ${current.objectType}:${current.proposalLocalKey}`);
  }
  return [...new Set(errors)].sort();
}

export function repairedQuarantineLineageErrors(args: {
  prior: MapperMaterialization;
  current: MapperMaterialization;
  repairedParentAttemptIds: ReadonlySet<string>;
  repairedRootKeys?: ReadonlySet<string>;
}): string[] {
  const errors: string[] = [];
  const repairedParents = args.prior.quarantines.filter((value) =>
    args.repairedParentAttemptIds.has(value.attemptId)
    && (args.repairedRootKeys === undefined || args.repairedRootKeys.has(value.localObjectKey)));
  for (const parent of repairedParents) {
    const hasChildQuarantine = args.current.quarantines.some((value) =>
      value.objectType === parent.objectType
      && value.localObjectKey === parent.localObjectKey
      && value.parentQuarantineIds.includes(parent.quarantineId));
    const hasMaterializedRoot = args.current.derivations.some((value) =>
      REPAIR_ROOT_OBJECT_TYPES.has(value.objectType)
      && objectForDerivation(args.current, value) !== null
      && (value.proposalLocalKey === parent.localObjectKey
        || value.proposalLocalKey.startsWith(`${parent.localObjectKey}:`)));
    if (!hasChildQuarantine && !hasMaterializedRoot) {
      errors.push(`repair silently dropped quarantined root ${parent.localObjectKey}`);
    }
    const parentSegments = args.prior.coverageRows
      .filter((row) => row.quarantineIds.includes(parent.quarantineId))
      .map((row) => row.segmentId);
    for (const segmentId of parentSegments) {
      const current = args.current.coverageRows.find((row) => row.segmentId === segmentId);
      if (!current || current.routeType === "no_semantic_content") {
        errors.push(`repair erased quarantined segment ${segmentId} as no_semantic_content`);
      }
    }
  }
  return [...new Set(errors)].sort();
}

export function finalizeAttemptResultAfterPostchecks(args: {
  materialized: MapperMaterialization;
  attempt: Attempt;
  postcheckErrors: readonly string[];
}): void {
  const priorResults = args.materialized.attemptResults
    .filter((value) => value.attemptId === args.attempt.attemptId);
  const objectIds = asciiIdSort(args.materialized.derivations
    .filter((value) => value.attemptId === args.attempt.attemptId)
    .map((value) => value.objectId));
  const quarantineIds = asciiIdSort(args.materialized.quarantines
    .filter((value) => value.attemptId === args.attempt.attemptId)
    .map((value) => value.quarantineId));
  const completionErrors = [...new Set([
    ...priorResults.flatMap((value) => value.completionErrors),
    ...args.postcheckErrors,
  ])].sort();
  const warnings = [...new Map([
    ...priorResults.flatMap((value) => value.warnings),
    ...args.attempt.warnings,
  ].map((value) => [canonicalJson(value as unknown as JsonValue), value])).values()];
  const priorWasIncomplete = priorResults.some((value) =>
    value.status === "incomplete" || value.status === "failed");
  const status = !args.attempt.outputComplete || priorWasIncomplete || completionErrors.length > 0
    ? "incomplete"
    : quarantineIds.length > 0
      ? "quarantined"
      : "accepted";
  const finalResult = createAttemptMaterializationResult({
    attemptId: args.attempt.attemptId,
    status,
    materializedObjectIds: objectIds,
    quarantineIds,
    completionErrors,
    warnings,
  });
  args.materialized.attemptResults = [
    ...args.materialized.attemptResults.filter((value) => value.attemptId !== args.attempt.attemptId),
    finalResult,
  ];
}

export function appendMissingAttemptResults(args: {
  attempts: readonly Attempt[];
  materializationPasses: readonly MapperMaterialization[];
  destination: MapperMaterialization;
}): void {
  const resultByAttempt = new Map<string, ReturnType<typeof createAttemptMaterializationResult>>();
  for (const result of args.materializationPasses.flatMap((pass) => pass.attemptResults)) {
    if (!resultByAttempt.has(result.attemptId)) resultByAttempt.set(result.attemptId, result);
  }
  const allQuarantines = args.materializationPasses.flatMap((pass) => pass.quarantines);
  for (const attempt of args.attempts) {
    if (resultByAttempt.has(attempt.attemptId)) continue;
    const result = createAttemptMaterializationResult({
      attemptId: attempt.attemptId,
      status: "incomplete",
      materializedObjectIds: [],
      quarantineIds: allQuarantines
        .filter((item) => item.attemptId === attempt.attemptId)
        .map((item) => item.quarantineId),
      completionErrors: [attempt.outputComplete
        ? "attempt was superseded before materialization"
        : "provider output was incomplete"],
      warnings: attempt.warnings,
    });
    args.destination.attemptResults.push(result);
    resultByAttempt.set(attempt.attemptId, result);
  }
  args.destination.attemptResults = [...resultByAttempt.values()].sort((left, right) =>
    Buffer.compare(Buffer.from(left.attemptId), Buffer.from(right.attemptId)));
}

function lastTrace(traces: readonly StructuredCallAttemptTrace[]): StructuredCallAttemptTrace | null {
  return traces[traces.length - 1] ?? null;
}

export function bindMapperPageToHostManifest(
  output: MapperPageOutput,
  expected: {
    targetSessionOpaqueId: string;
    pageNumber: number;
    pageCount: number;
    expectedSegmentIds: readonly string[];
  },
): MapperPageOutput {
  const expectedSegmentIds = new Set(expected.expectedSegmentIds);
  const reconcileSegmentId = (segmentId: string): string | null => {
    if (expectedSegmentIds.has(segmentId)) return segmentId;
    if (!segmentId.startsWith("segment_")) return null;
    const candidates = expected.expectedSegmentIds.filter((candidate) => {
      if (candidate.length !== segmentId.length) return false;
      let differences = 0;
      for (let index = 0; index < candidate.length; index += 1) {
        if (candidate[index] !== segmentId[index]) differences += 1;
        if (differences > 1) return false;
      }
      return differences === 1;
    });
    return candidates.length === 1 ? candidates[0]! : null;
  };
  return MapperPageOutputSchema.parse({
    ...output,
    targetSessionOpaqueId: expected.targetSessionOpaqueId,
    pageNumber: expected.pageNumber,
    pageCount: expected.pageCount,
    expectedSegmentIds: [...expected.expectedSegmentIds],
    // Coverage identity is host-owned just like the page manifest. A model row
    // for an undeclared segment cannot add evidence and must not poison an
    // otherwise complete page.
    assistantBlocks: output.assistantBlocks.map((block) => ({
      ...block,
      sourceSegmentIds: block.sourceSegmentIds.map((segmentId) =>
        reconcileSegmentId(segmentId) ?? segmentId),
    })),
    coverageRows: output.coverageRows.flatMap((row) => {
      const segmentId = reconcileSegmentId(row.segmentId);
      return segmentId === null ? [] : [{ ...row, segmentId }];
    }),
  });
}

type RepairObjectType = "mention" | "record" | "assistant_block" | "resolution";
type TargetedRepairScope = {
  mode: "targeted_patch";
  allowedObjects: Array<{ objectType: RepairObjectType; localObjectKey: string }>;
  allowedCoverageSegmentIds: string[];
};
type RepairScope = TargetedRepairScope | {
  mode: "replace_page";
  allowedObjects: [];
  allowedCoverageSegmentIds: [];
};

function uniquePatchKeys(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`repair patch contains duplicate ${label} keys`);
}

function requiredPatchValue<T>(values: ReadonlyMap<string, T>, key: string): T {
  const value = values.get(key);
  if (value === undefined) throw new Error(`repair patch lost replacement ${key}`);
  return value;
}

/** Lossless host assembly: only predeclared quarantined roots/coverage rows may change. */
export function applyMapperPagePatch(args: {
  prior: MapperPageOutput;
  patch: MapperPagePatchOutput;
  scope: TargetedRepairScope;
}): MapperPageOutput {
  const prior = MapperPageOutputSchema.parse(args.prior);
  const patch = MapperPagePatchOutputSchema.parse(args.patch);
  const priorRoots = new Set([
    ...prior.mentions.map((value) => `mention\0${value.localMentionKey}`),
    ...prior.records.map((value) => `record\0${value.localRecordKey}`),
    ...prior.assistantBlocks.map((value) => `assistant_block\0${value.localBlockKey}`),
    ...prior.resolutionAssertions.map((value) => `resolution\0${value.localResolutionKey}`),
  ]);
  const allowedKeys = new Set(args.scope.allowedObjects
    .filter((value) => priorRoots.has(`${value.objectType}\0${value.localObjectKey}`))
    .map((value) => value.localObjectKey));
  uniquePatchKeys(patch.mentions.map((value) => value.localMentionKey), "mention");
  uniquePatchKeys(patch.records.map((value) => value.localRecordKey), "record");
  uniquePatchKeys(patch.assistantBlocks.map((value) => value.localBlockKey), "assistant block");
  uniquePatchKeys(patch.resolutionAssertions.map((value) => value.localResolutionKey), "resolution");
  uniquePatchKeys([
    ...patch.mentions.map((value) => value.localMentionKey),
    ...patch.records.map((value) => value.localRecordKey),
    ...patch.assistantBlocks.map((value) => value.localBlockKey),
    ...patch.resolutionAssertions.map((value) => value.localResolutionKey),
  ], "cross-type object");
  uniquePatchKeys(patch.coverageRows.map((value) => value.segmentId), "coverage segment");
  const mentions = new Map(patch.mentions
    .filter((value) => allowedKeys.has(value.localMentionKey))
    .map((value) => [value.localMentionKey, value] as const));
  const records = new Map(patch.records
    .filter((value) => allowedKeys.has(value.localRecordKey))
    .map((value) => [value.localRecordKey, value] as const));
  const blocks = new Map(patch.assistantBlocks
    .filter((value) => allowedKeys.has(value.localBlockKey))
    .map((value) => [value.localBlockKey, value] as const));
  const resolutions = new Map(patch.resolutionAssertions
    .filter((value) => allowedKeys.has(value.localResolutionKey))
    .map((value) => [value.localResolutionKey, value] as const));
  const replacementTypes = new Map<string, RepairObjectType>([
    ...[...mentions].map(([key]) => [key, "mention"] as const),
    ...[...records].map(([key]) => [key, "record"] as const),
    ...[...blocks].map(([key]) => [key, "assistant_block"] as const),
    ...[...resolutions].map(([key]) => [key, "resolution"] as const),
  ]);
  const allowedCoverage = new Set(args.scope.allowedCoverageSegmentIds);
  const coveragePatch = new Map(patch.coverageRows
    .filter((value) => allowedCoverage.has(value.segmentId))
    .map((value) => [value.segmentId, value] as const));
  const priorCoverageIds = new Set(prior.coverageRows.map((value) => value.segmentId));
  const coverageRows = prior.coverageRows.map((value) => coveragePatch.get(value.segmentId) ?? value);
  for (const segmentId of prior.expectedSegmentIds) {
    const replacement = coveragePatch.get(segmentId);
    if (replacement && !priorCoverageIds.has(segmentId)) coverageRows.push(replacement);
  }
  return MapperPageOutputSchema.parse({
    ...prior,
    mentions: [
      ...prior.mentions.flatMap((value) => {
        const replacementType = replacementTypes.get(value.localMentionKey);
        return replacementType === undefined ? [value] : replacementType === "mention"
          ? [requiredPatchValue(mentions, value.localMentionKey)] : [];
      }),
      ...[...mentions.values()].filter((value) => !prior.mentions.some((priorValue) => priorValue.localMentionKey === value.localMentionKey)),
    ],
    records: [
      ...prior.records.flatMap((value) => {
        const replacementType = replacementTypes.get(value.localRecordKey);
        return replacementType === undefined ? [value] : replacementType === "record"
          ? [requiredPatchValue(records, value.localRecordKey)] : [];
      }),
      ...[...records.values()].filter((value) => !prior.records.some((priorValue) => priorValue.localRecordKey === value.localRecordKey)),
    ],
    assistantBlocks: [
      ...prior.assistantBlocks.flatMap((value) => {
        const replacementType = replacementTypes.get(value.localBlockKey);
        return replacementType === undefined ? [value] : replacementType === "assistant_block"
          ? [requiredPatchValue(blocks, value.localBlockKey)] : [];
      }),
      ...[...blocks.values()].filter((value) => !prior.assistantBlocks.some((priorValue) => priorValue.localBlockKey === value.localBlockKey)),
    ],
    resolutionAssertions: [
      ...prior.resolutionAssertions.flatMap((value) => {
        const replacementType = replacementTypes.get(value.localResolutionKey);
        return replacementType === undefined ? [value] : replacementType === "resolution"
          ? [requiredPatchValue(resolutions, value.localResolutionKey)] : [];
      }),
      ...[...resolutions.values()].filter((value) => !prior.resolutionAssertions.some((priorValue) => priorValue.localResolutionKey === value.localResolutionKey)),
    ],
    coverageRows,
  });
}

export function mapperPagePatchScopeViolations(args: {
  prior: MapperPageOutput;
  patch: MapperPagePatchOutput;
  scope: TargetedRepairScope;
}): string[] {
  const allowedRootByKey = new Map(args.scope.allowedObjects.map((value) => [
    value.localObjectKey,
    `${value.objectType}\0${value.localObjectKey}`,
  ]));
  const priorRoots = new Set([
    ...args.prior.mentions.map((value) => `mention\0${value.localMentionKey}`),
    ...args.prior.records.map((value) => `record\0${value.localRecordKey}`),
    ...args.prior.assistantBlocks.map((value) => `assistant_block\0${value.localBlockKey}`),
    ...args.prior.resolutionAssertions.map((value) => `resolution\0${value.localResolutionKey}`),
  ]);
  const proposedRoots = [
    ...args.patch.mentions.map((value) => `mention\0${value.localMentionKey}`),
    ...args.patch.records.map((value) => `record\0${value.localRecordKey}`),
    ...args.patch.assistantBlocks.map((value) => `assistant_block\0${value.localBlockKey}`),
    ...args.patch.resolutionAssertions.map((value) => `resolution\0${value.localResolutionKey}`),
  ];
  return [...new Set([
    ...proposedRoots.filter((root) => {
      const localKey = root.slice(root.indexOf("\0") + 1);
      const allowedRoot = allowedRootByKey.get(localKey);
      return allowedRoot === undefined || !priorRoots.has(allowedRoot);
    })
      .map((root) => `ignored out-of-scope repair object ${root.replace("\0", ":")}`),
    ...args.patch.coverageRows
      .filter((value) => !args.scope.allowedCoverageSegmentIds.includes(value.segmentId))
      .map((value) => `ignored out-of-scope coverage row ${value.segmentId}`),
  ])].sort();
}

function repairScopeObjects(prior: MapperPageOutput, scope: TargetedRepairScope): Record<string, unknown> {
  const allowed = new Set(scope.allowedObjects.map((value) => `${value.objectType}\0${value.localObjectKey}`));
  return {
    mentions: prior.mentions.filter((value) => allowed.has(`mention\0${value.localMentionKey}`)),
    records: prior.records.filter((value) => allowed.has(`record\0${value.localRecordKey}`)),
    assistantBlocks: prior.assistantBlocks.filter((value) => allowed.has(`assistant_block\0${value.localBlockKey}`)),
    resolutionAssertions: prior.resolutionAssertions.filter((value) => allowed.has(`resolution\0${value.localResolutionKey}`)),
    coverageRows: prior.coverageRows.filter((value) => scope.allowedCoverageSegmentIds.includes(value.segmentId)),
  };
}

function pageContainsRepairObject(
  page: MapperPageOutput,
  object: TargetedRepairScope["allowedObjects"][number],
): boolean {
  return object.objectType === "mention"
    ? page.mentions.some((value) => value.localMentionKey === object.localObjectKey)
    : object.objectType === "record"
      ? page.records.some((value) => value.localRecordKey === object.localObjectKey)
      : object.objectType === "assistant_block"
        ? page.assistantBlocks.some((value) => value.localBlockKey === object.localObjectKey)
        : page.resolutionAssertions.some((value) => value.localResolutionKey === object.localObjectKey);
}

/** Limits a targeted repair call to the failed object's source plus one neighbour. */
export function relevantRepairPage(args: {
  page: ReturnType<typeof pageSessionSegments>[number];
  priorOutput: MapperPageOutput | null;
  repairScope: RepairScope;
}): ReturnType<typeof pageSessionSegments>[number] {
  if (!args.priorOutput || args.repairScope.mode !== "targeted_patch") return args.page;
  const segmentIds = new Set(args.repairScope.allowedCoverageSegmentIds);
  const rawTurnIds = new Set<string>();
  for (const object of args.repairScope.allowedObjects) {
    if (object.objectType === "assistant_block") {
      const block = args.priorOutput.assistantBlocks.find((value) => value.localBlockKey === object.localObjectKey);
      block?.sourceSegmentIds.forEach((value) => segmentIds.add(value));
      if (block?.sourceAnchor) rawTurnIds.add(block.sourceAnchor.rawTurnId);
    } else if (object.objectType === "record") {
      const record = args.priorOutput.records.find((value) => value.localRecordKey === object.localObjectKey);
      record?.claimAnchors.forEach((value) => rawTurnIds.add(value.rawTurnId));
    } else if (object.objectType === "mention") {
      const mention = args.priorOutput.mentions.find((value) => value.localMentionKey === object.localObjectKey);
      if (mention) rawTurnIds.add(mention.anchor.rawTurnId);
    } else {
      const resolution = args.priorOutput.resolutionAssertions.find(
        (value) => value.localResolutionKey === object.localObjectKey,
      );
      resolution?.evidenceAnchors.forEach((value) => rawTurnIds.add(value.rawTurnId));
    }
  }
  const indexes = args.page.segments.flatMap((segment, index) =>
    segmentIds.has(segment.segmentId) || rawTurnIds.has(segment.rawTurnId) ? [index] : []);
  if (indexes.length === 0) return args.page;
  const selectedIndexes = new Set(indexes);
  for (const index of indexes) {
    if (index > 0) selectedIndexes.add(index - 1);
    if (index + 1 < args.page.segments.length) selectedIndexes.add(index + 1);
  }
  const segments = args.page.segments.filter((_, index) => selectedIndexes.has(index));
  return { ...args.page, expectedSegmentIds: segments.map((value) => value.segmentId), segments };
}

async function callMapperPage(args: {
  openai: OpenAI;
  dispatch: DispatchGate;
  costBudget: CostBudget;
  prompts: PromptLoader;
  sessions: readonly PreparedSession[];
  session: PreparedSession;
  page: ReturnType<typeof pageSessionSegments>[number];
  contextSessions: number;
  mapperModel: string;
  mapperReasoning: ReasoningEffort;
  mapperMaxOutput: number;
  parentAttemptIds: readonly string[];
  runId: string;
  outputPath: string;
}): Promise<PageCall> {
  const preceding = args.sessions.slice(
    Math.max(0, args.session.sessionOrdinal - args.contextSessions),
    args.session.sessionOrdinal,
  );
  const pageManifest = {
    targetSessionOpaqueId: args.session.opaqueSessionId,
    pageNumber: args.page.pageNumber,
    pageCount: args.page.pageCount,
    expectedSegmentIds: args.page.expectedSegmentIds,
  };
  const targetPageContext = modelPageSession(args.session, args.page);
  const prompt = await args.prompts.render("beam-structured-event-map-v1", {
    preceding_context_sessions: JSON.stringify(preceding.map(modelSession)),
    target_session: JSON.stringify(targetPageContext),
    page_manifest: JSON.stringify(pageManifest),
    target_segments: JSON.stringify(args.page.segments),
  });
  const inputContextManifest = {
    precedingSessionOpaqueIds: preceding.map((item) => item.opaqueSessionId),
    precedingRawTurns: preceding.flatMap((item) => item.rawTurns.map((turn) => ({
      rawTurnId: turn.rawTurnId,
      contentSha256: turn.contentSha256,
      contentByteLength: turn.contentByteLength,
    }))),
    targetSessionOpaqueId: args.session.opaqueSessionId,
    pageManifest,
    targetPageContextSha256: sha256(JSON.stringify(targetPageContext)),
    adaptiveParentAttemptIds: asciiIdSort(args.parentAttemptIds),
  } satisfies JsonValue;
  const traces: StructuredCallAttemptTrace[] = [];
  try {
    const call = await callStructured({
      openai: args.openai,
      dispatch: args.dispatch,
      costBudget: args.costBudget,
      model: args.mapperModel,
      reasoning: args.mapperReasoning,
      prompt,
      schema: MapperPageOutputSchema,
      schemaName: "beam_structured_event_mapper_v1",
      maxOutputTokens: args.mapperMaxOutput,
      dispatchOutputTokens: args.mapperMaxOutput,
      rawSessionIdsForLeakCheck: args.sessions.map((session) => session.hostSessionId),
      onAttempt: (trace) => { traces.push(trace); },
    });
    const output = bindMapperPageToHostManifest(call.value, pageManifest);
    const attempt = createAttempt({
      runId: args.runId,
      targetId: args.session.opaqueSessionId,
      pageNumber: args.page.pageNumber,
      inputContextManifest,
      inputContextManifestSha256: sha256(canonicalJson(inputContextManifest)),
      parentAttemptIds: [...args.parentAttemptIds],
      trigger: "mapper",
      model: args.mapperModel,
      promptSha256: fileSha(MAPPER_PROMPT_PATH),
      schemaSha256: fileSha(SCHEMA_PATH),
      rawProviderOutput: call.outputText,
      rawOutputSha256: sha256(call.outputText),
      parsedDrafts: output as unknown as JsonValue,
      diagnostics: [],
      warnings: [],
      finishReason: call.responseStatus,
      outputComplete: call.responseStatus === "completed" && call.incompleteReason === null,
      extractionConfidence: null,
    });
    writeJson(args.outputPath, { call: callArtifact(call), traces, attempt });
    return { output, attempt, error: null, artifactPath: args.outputPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const trace = lastTrace(traces);
    const rawProviderOutput = trace?.outputText ?? "";
    const attempt = createAttempt({
      runId: args.runId,
      targetId: args.session.opaqueSessionId,
      pageNumber: args.page.pageNumber,
      inputContextManifest,
      inputContextManifestSha256: sha256(canonicalJson(inputContextManifest)),
      parentAttemptIds: [...args.parentAttemptIds],
      trigger: "mapper",
      model: args.mapperModel,
      promptSha256: fileSha(MAPPER_PROMPT_PATH),
      schemaSha256: fileSha(SCHEMA_PATH),
      rawProviderOutput,
      rawOutputSha256: sha256(rawProviderOutput),
      parsedDrafts: null,
      diagnostics: [{ error: message }],
      warnings: [],
      finishReason: trace?.incompleteReason ?? trace?.status ?? "call_failed",
      outputComplete: false,
      extractionConfidence: null,
    });
    writeJson(args.outputPath, { error: message, traces, attempt, promptMessages: prompt.messages });
    return { output: null, attempt, error: message, artifactPath: args.outputPath };
  }
}

async function repairPage(args: {
  openai: OpenAI;
  dispatch: DispatchGate;
  costBudget: CostBudget;
  prompts: PromptLoader;
  sessions: readonly PreparedSession[];
  session: PreparedSession;
  page: ReturnType<typeof pageSessionSegments>[number];
  contextSessions: number;
  priorOutput: MapperPageOutput | null;
  priorAttempt: Attempt;
  repairScope: RepairScope;
  diagnostics: unknown;
  repairModel: string;
  repairReasoning: ReasoningEffort;
  repairMaxOutput: number;
  runId: string;
  outputPath: string;
}): Promise<PageCall> {
  const pageManifest = {
    targetSessionOpaqueId: args.session.opaqueSessionId,
    pageNumber: args.page.pageNumber,
    pageCount: args.page.pageCount,
    expectedSegmentIds: args.page.expectedSegmentIds,
  };
  const relevantPage = relevantRepairPage({
    page: args.page,
    priorOutput: args.priorOutput,
    repairScope: args.repairScope,
  });
  const targetPageContext = modelPageSession(args.session, relevantPage);
  const preceding = args.sessions.slice(
    Math.max(0, args.session.sessionOrdinal - args.contextSessions),
    args.session.sessionOrdinal,
  );
  const prompt = await args.prompts.render("beam-structured-event-repair-v1", {
    repair_trigger: JSON.stringify(args.diagnostics),
    repair_scope: JSON.stringify(args.repairScope),
    affected_raw_context: JSON.stringify({
      precedingResolutionContext: preceding.map(modelSession),
      session: targetPageContext,
      segments: relevantPage.segments,
    }),
    existing_objects: JSON.stringify(
      args.priorOutput && args.repairScope.mode === "targeted_patch"
        ? repairScopeObjects(args.priorOutput, args.repairScope)
        : args.priorOutput,
    ),
    page_manifest: JSON.stringify(pageManifest),
  });
  const inputContextManifest = {
    targetSessionOpaqueId: args.session.opaqueSessionId,
    pageManifest,
    parentAttemptId: args.priorAttempt.attemptId,
    repairScope: args.repairScope,
    diagnostics: args.diagnostics as JsonValue,
    precedingSessionOpaqueIds: preceding.map((item) => item.opaqueSessionId),
    precedingRawTurns: preceding.flatMap((item) => item.rawTurns.map((turn) => ({
      rawTurnId: turn.rawTurnId,
      contentSha256: turn.contentSha256,
      contentByteLength: turn.contentByteLength,
    }))),
    targetPageContextSha256: sha256(JSON.stringify(targetPageContext)),
  } satisfies JsonValue;
  const traces: StructuredCallAttemptTrace[] = [];
  try {
    const common = {
      openai: args.openai,
      dispatch: args.dispatch,
      costBudget: args.costBudget,
      model: args.repairModel,
      reasoning: args.repairReasoning,
      prompt,
      maxOutputTokens: args.repairMaxOutput,
      dispatchOutputTokens: args.repairMaxOutput,
      rawSessionIdsForLeakCheck: [args.session.hostSessionId],
      onAttempt: (trace: StructuredCallAttemptTrace) => { traces.push(trace); },
    } as const;
    const call = args.priorOutput && args.repairScope.mode === "targeted_patch"
      ? await callStructured({
        ...common,
        schema: MapperPagePatchOutputSchema,
        schemaName: "beam_structured_event_mapper_patch_v1",
      })
      : await callStructured({
        ...common,
        schema: MapperPageOutputSchema,
        schemaName: "beam_structured_event_mapper_v1",
      });
    const repairPatch = args.priorOutput && args.repairScope.mode === "targeted_patch"
      ? MapperPagePatchOutputSchema.parse(call.value)
      : null;
    const patchScopeViolations = args.priorOutput && args.repairScope.mode === "targeted_patch" && repairPatch
      ? mapperPagePatchScopeViolations({ prior: args.priorOutput, patch: repairPatch, scope: args.repairScope })
      : [];
    const output = args.priorOutput && args.repairScope.mode === "targeted_patch" && repairPatch
      ? applyMapperPagePatch({ prior: args.priorOutput, patch: repairPatch, scope: args.repairScope })
      : bindMapperPageToHostManifest(MapperPageOutputSchema.parse(call.value), pageManifest);
    const parsedDrafts = repairPatch === null
      ? output as unknown as JsonValue
      : {
        repairPatch: repairPatch as unknown as JsonValue,
        assembledPageSha256: sha256(canonicalJson(output as unknown as JsonValue)),
        ignoredOutOfScopeEntries: patchScopeViolations,
      } satisfies JsonValue;
    const attempt = createAttempt({
      runId: args.runId,
      targetId: args.session.opaqueSessionId,
      pageNumber: args.page.pageNumber,
      inputContextManifest,
      inputContextManifestSha256: sha256(canonicalJson(inputContextManifest)),
      parentAttemptIds: [args.priorAttempt.attemptId],
      trigger: "repair",
      model: args.repairModel,
      promptSha256: fileSha(REPAIR_PROMPT_PATH),
      schemaSha256: fileSha(SCHEMA_PATH),
      rawProviderOutput: call.outputText,
      rawOutputSha256: sha256(call.outputText),
      parsedDrafts,
      diagnostics: [args.diagnostics as JsonValue, ...patchScopeViolations.map((detail) => ({ detail }))],
      warnings: [],
      finishReason: call.responseStatus,
      outputComplete: call.responseStatus === "completed" && call.incompleteReason === null,
      extractionConfidence: null,
    });
    writeJson(args.outputPath, { call: callArtifact(call), traces, repairPatch, patchScopeViolations, assembledOutput: output, attempt });
    return { output, attempt, error: null, artifactPath: args.outputPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const trace = lastTrace(traces);
    const rawProviderOutput = trace?.outputText ?? "";
    const attempt = createAttempt({
      runId: args.runId,
      targetId: args.session.opaqueSessionId,
      pageNumber: args.page.pageNumber,
      inputContextManifest,
      inputContextManifestSha256: sha256(canonicalJson(inputContextManifest)),
      parentAttemptIds: [args.priorAttempt.attemptId],
      trigger: "repair",
      model: args.repairModel,
      promptSha256: fileSha(REPAIR_PROMPT_PATH),
      schemaSha256: fileSha(SCHEMA_PATH),
      rawProviderOutput,
      rawOutputSha256: sha256(rawProviderOutput),
      parsedDrafts: null,
      diagnostics: [args.diagnostics as JsonValue, { error: message }],
      warnings: [],
      finishReason: trace?.incompleteReason ?? trace?.status ?? "call_failed",
      outputComplete: false,
      extractionConfidence: null,
    });
    writeJson(args.outputPath, { error: message, traces, attempt, promptMessages: prompt.messages });
    return { output: null, attempt, error: message, artifactPath: args.outputPath };
  }
}

function targetedRepairScope(args: {
  page: ReturnType<typeof pageSessionSegments>[number];
  priorOutput: MapperPageOutput;
  materialized: MapperMaterialization;
  priorAttempt: Attempt;
  onlyObject?: { objectType: RepairObjectType; localObjectKey: string };
}): TargetedRepairScope {
  const supportedTypes = new Set<RepairObjectType>(["mention", "record", "assistant_block", "resolution"]);
  const allowedObjects = [...new Map(args.materialized.quarantines
    .filter((value) => value.attemptId === args.priorAttempt.attemptId)
    .filter((value) => args.onlyObject === undefined
      || (value.objectType === args.onlyObject.objectType && value.localObjectKey === args.onlyObject.localObjectKey))
    .flatMap((value) => supportedTypes.has(value.objectType as RepairObjectType)
      ? [[`${value.objectType}\0${value.localObjectKey}`, {
        objectType: value.objectType as RepairObjectType,
        localObjectKey: value.localObjectKey,
      }] as const]
      : [])).values()];
  const allowedKeys = new Set(allowedObjects.map((value) => value.localObjectKey));
  const returned = new Set(args.priorOutput.coverageRows.map((value) => value.segmentId));
  const allowedCoverageSegmentIds = args.page.expectedSegmentIds.filter((segmentId) => {
    if (!returned.has(segmentId)) return true;
    if (args.materialized.completionErrors.some((error) => error.includes(segmentId))) return true;
    const row = args.priorOutput.coverageRows.find((value) => value.segmentId === segmentId);
    return row !== undefined && [
      ...row.localRecordKeys,
      ...row.localBlockKeys,
      ...row.localObjectKeysExpectedInQuarantine,
    ].some((key) => allowedKeys.has(key));
  });
  return {
    mode: "targeted_patch",
    allowedObjects,
    allowedCoverageSegmentIds,
  };
}

export function pagesNeedingCoverageRepair(args: {
  pages: readonly { pageNumber: number; expectedSegmentIds: readonly string[] }[];
  outputsByPage: ReadonlyMap<number, MapperPageOutput>;
  completionErrors: readonly string[];
}): number[] {
  return args.pages.flatMap((page) => {
    const output = args.outputsByPage.get(page.pageNumber);
    if (!output) return [page.pageNumber];
    const returned = output.coverageRows.map((row) => row.segmentId);
    const expected = page.expectedSegmentIds;
    const coverageMismatch = returned.length !== expected.length
      || new Set(returned).size !== returned.length
      || returned.some((segmentId) => !expected.includes(segmentId));
    const segmentError = args.completionErrors.some((error) =>
      expected.some((segmentId) => error.includes(segmentId)));
    return coverageMismatch || segmentError ? [page.pageNumber] : [];
  });
}

async function runSession(args: {
  sessions: readonly PreparedSession[];
  session: PreparedSession;
  openai: OpenAI;
  dispatch: DispatchGate;
  costBudget: CostBudget;
  prompts: PromptLoader;
  runId: string;
  runDir: string;
  contextSessions: number;
  maxSegmentsPerPage: number;
  mapperModel: string;
  mapperReasoning: ReasoningEffort;
  mapperMaxOutput: number;
  repairModel: string;
  repairReasoning: ReasoningEffort;
  repairMaxOutput: number;
  pageConcurrency: number;
}): Promise<SessionRun> {
  const attempts: Attempt[] = [];
  const callArtifactPaths: string[] = [];
  let priorRound: Array<{ page: ReturnType<typeof pageSessionSegments>[number]; call: PageCall }> = [];
  const adaptive = await runAdaptivePageRounds({
    initialPageSize: args.maxSegmentsPerPage,
    buildPages: (pageSize) => pageSessionSegments(args.session, pageSize),
    callRound: async (roundPages, mappingRound) => {
      const roundCalls = await mapPool(
        [...roundPages],
        Math.min(roundPages.length, args.pageConcurrency),
        async (page) => {
          const segmentIds = new Set(page.expectedSegmentIds);
          const parentAttemptIds = priorRound
            .filter((prior) => prior.page.expectedSegmentIds.some((segmentId) => segmentIds.has(segmentId)))
            .map((prior) => prior.call.attempt.attemptId);
          return callMapperPage({
            ...args,
            page,
            parentAttemptIds,
            outputPath: resolve(
              args.runDir,
              "calls",
              args.session.opaqueSessionId,
              `mapper-round-${String(mappingRound)}-page-${String(page.pageNumber)}.json`,
            ),
          });
        },
      );
      attempts.push(...roundCalls.map((item) => item.attempt));
      callArtifactPaths.push(...roundCalls.map((item) => item.artifactPath));
      const terminalFailure = roundCalls.find((item) =>
        item.output === null && isTerminalProviderFailure(item.error));
      if (terminalFailure) {
        throw new Error(`terminal provider failure; adaptive repaging is disabled: ${terminalFailure.error ?? "unknown"}`);
      }
      priorRound = roundPages.map((page, index) => {
        const call = roundCalls[index];
        if (!call) throw new Error("adaptive mapper round lost a page call");
        return { page, call };
      });
      return roundCalls;
    },
    isComplete: (result) => result.output !== null,
  });
  const pages = [...adaptive.pages];
  const pageCalls = [...adaptive.results];
  const activeByPage = new Map(pageCalls.map((item) => [item.attempt.pageNumber, item]));
  const repairedPageNumbers: number[] = [];

  const immediateRepairs = pageCalls.filter((item) => item.output === null);
  const immediateResults = await mapPool(immediateRepairs, Math.min(immediateRepairs.length, args.pageConcurrency), async (failed) => {
    const page = pages.find((item) => item.pageNumber === failed.attempt.pageNumber);
    if (!page) throw new Error("failed mapper call lost its page");
    return repairPage({
      ...args,
      page,
      priorOutput: null,
      priorAttempt: failed.attempt,
      repairScope: { mode: "replace_page", allowedObjects: [], allowedCoverageSegmentIds: [] },
      diagnostics: { callFailure: failed.error, invariant: "complete_parseable_page_output" },
      outputPath: resolve(args.runDir, "calls", args.session.opaqueSessionId, `repair-${String(page.pageNumber)}.json`),
    });
  });
  for (const repair of immediateResults) {
    attempts.push(repair.attempt);
    callArtifactPaths.push(repair.artifactPath);
    activeByPage.set(repair.attempt.pageNumber, repair);
    repairedPageNumbers.push(repair.attempt.pageNumber);
  }

  const materializationPasses: MapperMaterialization[] = [];
  const materialize = (parentQuarantinesByLocalKey?: ReadonlyMap<string, readonly string[]>): MapperMaterialization =>
    materializeMapperPages({
      rawTurns: args.sessions.flatMap((session) => session.rawTurns),
      expectedTargetOpaqueId: args.session.opaqueSessionId,
      targetRawTurnIds: new Set(args.session.rawTurns.map((turn) => turn.rawTurnId)),
      expectedSegments: args.session.segments,
      pages: [...activeByPage.values()].flatMap((item) => item.output ? [item.output] : []),
      attemptsByPage: new Map([...activeByPage].map(([page, item]) => [page, item.attempt])),
      ...(parentQuarantinesByLocalKey === undefined ? {} : { parentQuarantinesByLocalKey }),
    });
  let materialized = materialize();
  materializationPasses.push(materialized);
  const repairTargetMap = new Map<string, { objectType: RepairObjectType; localObjectKey: string }>();
  for (const value of materialized.quarantines) {
    const objectType = value.objectType as RepairObjectType;
    if (new Set<RepairObjectType>(["mention", "record", "assistant_block", "resolution"]).has(objectType)) {
      repairTargetMap.set(`${objectType}\0${value.localObjectKey}`, { objectType, localObjectKey: value.localObjectKey });
    }
  }
  const repairTargets = [...repairTargetMap.values()];
  // Repair one semantic root at a time. Every patch is assembled into the
  // current page and re-materialized before the next root is dispatched. If
  // the same root remains quarantined, give the repairer one final attempt
  // with the validator's new, exact diagnostics.
  let repairCallIndex = 0;
  for (const target of repairTargets) {
    for (let targetAttempt = 1; targetAttempt <= 2; targetAttempt += 1) {
      const currentQuarantine = materialized.quarantines.find((value) =>
        value.objectType === target.objectType && value.localObjectKey === target.localObjectKey);
      if (!currentQuarantine) break;
      const priorEntry = [...activeByPage.entries()].find(([, value]) =>
        value.output !== null && pageContainsRepairObject(value.output, target));
      if (!priorEntry) throw new Error(`targeted repair lost object ${target.objectType}:${target.localObjectKey}`);
      const [pageNumber, prior] = priorEntry;
      const page = pages.find((item) => item.pageNumber === pageNumber);
      if (!page || !prior.output) throw new Error("targeted repair page state is incomplete");
      const repairScope = targetedRepairScope({
        page,
        priorOutput: prior.output,
        materialized,
        priorAttempt: prior.attempt,
        onlyObject: target,
      });
      if (repairScope.allowedObjects.length !== 1) {
        throw new Error(`targeted repair scope is not isolated for ${target.objectType}:${target.localObjectKey}`);
      }
      const priorPass = materialized;
      const affectedCompletionErrors = materialized.completionErrors.filter((error) =>
        error === "quarantine backlog is non-empty"
        || error.includes(target.localObjectKey)
        || repairScope.allowedCoverageSegmentIds.some((segmentId) => error.includes(segmentId)));
      repairCallIndex += 1;
      const repair = await repairPage({
        ...args,
        page,
        priorOutput: prior.output,
        priorAttempt: prior.attempt,
        repairScope,
        diagnostics: {
          repairScope,
          targetAttempt,
          quarantine: currentQuarantine,
          completionErrors: affectedCompletionErrors,
        },
        outputPath: resolve(
          args.runDir,
          "calls",
          args.session.opaqueSessionId,
          `repair-${String(repairCallIndex)}-attempt-${String(targetAttempt)}-page-${String(pageNumber)}-${target.objectType}-${target.localObjectKey}.json`,
        ),
      });
      attempts.push(repair.attempt);
      callArtifactPaths.push(repair.artifactPath);
      activeByPage.set(pageNumber, activePageAfterRepair(prior, repair));
      if (!repairedPageNumbers.includes(pageNumber)) repairedPageNumbers.push(pageNumber);
      const parentQuarantines = new Map<string, string[]>();
      for (const priorQuarantine of materializationPasses.flatMap((pass) => pass.quarantines)) {
        const key = quarantineRootKey(priorQuarantine.objectType, priorQuarantine.localObjectKey);
        const values = parentQuarantines.get(key) ?? [];
        values.push(priorQuarantine.quarantineId);
        parentQuarantines.set(key, values);
      }
      materialized = materialize(parentQuarantines);
      const repairedParentAttempts = new Set(repair.attempt.parentAttemptIds);
      const repairAttemptIds = new Set([repair.attempt.attemptId]);
      const repairedRootKeys = new Set([target.localObjectKey]);
      const affectedProposalRoots = repairAffectedProposalRoots({
        prior: priorPass,
        current: materialized,
        repairedParentAttemptIds: repairedParentAttempts,
        repairAttemptIds,
        repairedRootKeys,
      });
      const preservationErrors = targetedRepairPreservationErrors({
        prior: priorPass,
        current: materialized,
        repairedParentAttemptIds: repairedParentAttempts,
        repairAttemptIds,
        affectedProposalRoots,
      });
      const quarantineLineageErrors = repairedQuarantineLineageErrors({
        prior: priorPass,
        current: materialized,
        repairedParentAttemptIds: repairedParentAttempts,
        repairedRootKeys,
      });
      const postcheckErrors = [...new Set([...preservationErrors, ...quarantineLineageErrors])].sort();
      if (postcheckErrors.length > 0) {
        materialized.completionErrors.push(...postcheckErrors);
        materialized.complete = false;
      }
      finalizeAttemptResultAfterPostchecks({ materialized, attempt: repair.attempt, postcheckErrors });
      materializationPasses.push(materialized);
    }
  }
  // Object-level repairs cannot address a mapper that returned an invalid or
  // incomplete structural coverage ledger without naming a failed object. Give
  // each affected page one bounded Luna remap using its immutable page bytes.
  // This keeps the semantic decision with the model while retaining every
  // original attempt for audit; no deterministic semantic classification is
  // introduced by the host.
  const appendRepeatedOccurrenceErrors = (): void => {
    const mismatches = repeatedTurnSemanticCountMismatches(args.session.rawTurns, materialized.records);
    for (const mismatch of mismatches) {
      const segmentIds = args.session.segments
        .filter((segment) => segment.rawTurnId === mismatch.rawTurnId)
        .map((segment) => segment.segmentId);
      materialized.completionErrors.push([
        "repeated USER turn semantic occurrence mismatch",
        `rawTurnId=${mismatch.rawTurnId}`,
        `peerRawTurnId=${mismatch.peerRawTurnId}`,
        `actualRecords=${String(mismatch.actualRecordCount)}`,
        `requiredRecords=${String(mismatch.requiredRecordCount)}`,
        `segments=${segmentIds.join(",")}`,
        "preserve every proposition at every exact source occurrence",
      ].join(" "));
    }
    if (mismatches.length > 0) materialized.complete = false;
  };
  appendRepeatedOccurrenceErrors();
  const coverageRepairPageNumbers = pagesNeedingCoverageRepair({
    pages,
    outputsByPage: new Map([...activeByPage].flatMap(([pageNumber, value]) =>
      value.output ? [[pageNumber, value.output] as const] : [])),
    completionErrors: materialized.completionErrors,
  });
  const coverageRepairs = await mapPool(
    coverageRepairPageNumbers,
    Math.min(coverageRepairPageNumbers.length, args.pageConcurrency),
    async (pageNumber) => {
      const page = pages.find((candidate) => candidate.pageNumber === pageNumber);
      const prior = activeByPage.get(pageNumber);
      if (!page || !prior?.output) throw new Error(`coverage repair lost mapper page ${String(pageNumber)}`);
      const affectedErrors = materialized.completionErrors.filter((error) =>
        error === "coverage rows do not exactly cover structural segments"
        || page.expectedSegmentIds.some((segmentId) => error.includes(segmentId)));
      return repairPage({
        ...args,
        page,
        priorOutput: prior.output,
        priorAttempt: prior.attempt,
        repairScope: { mode: "replace_page", allowedObjects: [], allowedCoverageSegmentIds: [] },
        diagnostics: {
          invariant: "complete_consistent_structural_coverage",
          completionErrors: affectedErrors,
          instruction: "Remap this complete immutable page; every expected segment must be truthfully routed to a materialized object or no_semantic_content.",
        },
        outputPath: resolve(
          args.runDir,
          "calls",
          args.session.opaqueSessionId,
          `repair-coverage-page-${String(pageNumber)}.json`,
        ),
      });
    },
  );
  for (const repair of coverageRepairs) {
    attempts.push(repair.attempt);
    callArtifactPaths.push(repair.artifactPath);
    if (repair.output) activeByPage.set(repair.attempt.pageNumber, repair);
    if (!repairedPageNumbers.includes(repair.attempt.pageNumber)) repairedPageNumbers.push(repair.attempt.pageNumber);
  }
  if (coverageRepairs.length > 0) {
    materialized = materialize();
    appendRepeatedOccurrenceErrors();
    materializationPasses.push(materialized);
  }
  appendMissingAttemptResults({ attempts, materializationPasses, destination: materialized });
  writeJson(resolve(args.runDir, "sessions", `${args.session.opaqueSessionId}.json`), {
    session: args.session,
    outputs: [...activeByPage.values()].flatMap((item) => item.output ? [item.output] : []),
    attempts,
    materializationPasses,
    materialized,
    repairedPageNumbers,
  });
  return {
    session: args.session,
    pages: [...activeByPage.values()].flatMap((item) => item.output ? [item.output] : []),
    attempts,
    materialized,
    materializationPasses,
    repairedPageNumbers,
    callArtifactPaths,
  };
}

async function executeRun(args: Record<string, string>): Promise<void> {
  const binding = expectedBinding(args);
  const receiptPath = pathValue(args.receipt);
  const ledgerPath = pathValue(args.ledger);
  if (ledgerPath !== resolve(binding.outputDirectory, "approval-ledger.jsonl")) {
    throw new Error("approval ledger must be the canonical ledger inside the bound output directory");
  }
  const receipt = SignedApprovalReceiptSchema.parse(JSON.parse(readFileSync(receiptPath, "utf8")));
  const approvalKey = process.env.BEAM_TEST_APPROVAL_HMAC_KEY;
  const opaqueKey = process.env.BEAM_OPAQUE_HANDLE_KEY;
  if (!approvalKey || !opaqueKey) throw new Error("approval and opaque-handle keys are required");
  verifyAndConsumeApproval({
    signedReceipt: receipt,
    verificationKey: Buffer.from(approvalKey, "base64"),
    expectedKeyId: args["approval-key-id"] ?? "beam-test-control-v1",
    expectedExecution: binding,
    ledgerPath,
  });

  const runDir = binding.outputDirectory;
  mkdirSync(runDir, { recursive: true });
  writeJson(resolve(runDir, "approval-receipt.json"), receipt);
  writeJson(resolve(runDir, "execution-binding.json"), binding);
  writeJson(resolve(runDir, "execution-configuration.json"), executionConfiguration(args));
  writeJson(resolve(runDir, "implementation-identity-manifest.json"), identityManifest(IMPLEMENTATION_PATHS));
  writeJson(resolve(runDir, "prompt-identity-manifest.json"), identityManifest(PROMPT_PATHS));
  const datasetPath = pathValue(args.dataset);
  const conversation = inputConversation(args, datasetPath);
  const input = preparedInput(conversation);
  const sessionsAll = prepareConversation({
    archiveId: `beam:${String(conversation.conversation_id)}`,
    input,
    opaqueHandleKey: Buffer.from(opaqueKey, "base64"),
    transportArtifactSha256: args["source-dataset-hash"],
    maximumStructuralSegmentBytes: Number(args["max-structural-segment-bytes"] ?? 2_000),
  });
  const sessionLimit = Number(args["session-limit"] ?? sessionsAll.length);
  if (!Number.isInteger(sessionLimit) || sessionLimit <= 0 || sessionLimit > sessionsAll.length) {
    throw new Error("approved session limit is invalid");
  }
  const sessions = sessionsAll.slice(0, sessionLimit);
  const rawArchivePath = resolve(runDir, "raw-archive.json");
  const opaqueMapPath = resolve(runDir, "opaque-session-map.json");
  const transportReferencePath = resolve(runDir, "transport-artifact-reference.json");
  writeJson(rawArchivePath, sessions);
  writeJson(opaqueMapPath, sessions.map((session) => ({
    opaqueSessionId: session.opaqueSessionId,
    hostSessionId: session.hostSessionId,
  })));
  writeJson(transportReferencePath, {
    sourcePath: datasetPath,
    sha256: args["source-dataset-hash"],
    byteLength: readFileSync(datasetPath).length,
  });

  const prompts = new PromptLoader();
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const dispatch = new DispatchGate(
    Number(args["token-budget"] ?? 1_900_000),
    60,
    requiredNumber(args, "concurrency"),
  );
  const costBudget = new CostBudget(binding.hardSpendCeilingUsd);
  const runId = `beam-structured-event-v1:${binding.rung}:${receipt.payload.nonce}`;
  const models = Object.fromEntries(binding.models.map((model) => [model.role, model]));
  const mapper = models.mapper;
  const repair = models.repair;
  const linker = models.linker;
  if (!mapper || !repair || !linker) throw new Error("approved model roles are incomplete");
  const sessionRuns = await mapPool(sessions, requiredNumber(args, "concurrency"), async (session) => runSession({
    sessions,
    session,
    openai,
    dispatch,
    costBudget,
    prompts,
    runId,
    runDir,
    contextSessions: Number(args["context-sessions"] ?? 2),
    maxSegmentsPerPage: Number(args["max-segments-per-page"] ?? 12),
    mapperModel: mapper.model,
    mapperReasoning: mapper.reasoning as ReasoningEffort,
    mapperMaxOutput: Number(args["mapper-max-output"] ?? 64_000),
    repairModel: repair.model,
    repairReasoning: repair.reasoning as ReasoningEffort,
    repairMaxOutput: Number(args["repair-max-output"] ?? 64_000),
    pageConcurrency: positiveInteger(args, "concurrency"),
  }));
  const incomplete = sessionRuns.filter((item) => !item.materialized.complete);
  const activePasses = sessionRuns.map((item) => item.materialized);
  const historicalPasses = sessionRuns.flatMap((item) => item.materializationPasses);
  const selected = selectActiveAndHistoricalMaterializationArtifacts({ activePasses, historicalPasses });
  const records = selected.records;
  const semanticProjections = selected.semanticProjections;
  const lifecycleEvents = selected.lifecycleEvents;
  const attempts = dedupeCanonical(sessionRuns.flatMap((item) => item.attempts), (value) => value.attemptId);
  const attemptSupersessions = dedupeCanonical(attempts.flatMap((attempt) =>
    attempt.parentAttemptIds.map((parentAttemptId) => createAttemptSupersession({
      parentAttemptId,
      replacementAttemptId: attempt.attemptId,
      reason: attempt.trigger === "repair" ? "targeted_repair" : "adaptive_repage",
    }))), (value) => value.supersessionId);
  const resolutionAssertions = selected.resolutionAssertions;
  const assistantBlocks = selected.assistantBlocks;
  const assistantBlockItems = selected.assistantBlockItems;
  const assistantBlockProjections = selected.assistantBlockProjections;
  const sourceSelectors = selected.sourceSelectors;
  const historicalRecords = dedupeCanonical(
    historicalPasses.flatMap((item) => item.records),
    (value) => value.recordId,
  );
  const historicalSemanticProjections = dedupeCanonical(
    historicalPasses.flatMap((item) => item.semanticProjections),
    (value) => value.projectionId,
  );
  validateLifecycleLineage({
    events: lifecycleEvents,
    attempts,
    records: historicalRecords,
    projections: historicalSemanticProjections,
  });
  const defaultMembership = defaultProjectionMembership({
    records,
    projections: semanticProjections,
    lifecycleEvents,
    resolutions: resolutionAssertions,
  });
  const rawLexicalPostings = buildAssistantRawLexicalPostings({
    blocks: assistantBlocks,
    items: assistantBlockItems,
    selectors: sourceSelectors,
  });
  const aggregate = {
    records,
    mentions: selected.mentions,
    supportBindings: selected.supportBindings,
    resolutionAssertions,
    semanticProjections,
    defaultProjectionMembership: defaultMembership,
    assistantBlocks,
    assistantBlockItems,
    assistantBlockProjections,
    rawLexicalPostings,
    sourceSelectors,
    metadataSelectors: selected.metadataSelectors,
    quarantines: selected.quarantines,
    coverageRows: dedupeCanonical(sessionRuns.flatMap((item) => item.materialized.coverageRows), (value) => value.segmentId),
    derivations: selected.derivations,
    lifecycleEvents,
    attemptResults: selected.attemptResults,
    attempts,
    attemptSupersessions,
    warnings: selected.warnings,
  };
  const artifactPaths: string[] = [
    rawArchivePath,
    opaqueMapPath,
    transportReferencePath,
    resolve(runDir, "approval-receipt.json"),
    resolve(runDir, "execution-binding.json"),
    resolve(runDir, "execution-configuration.json"),
    resolve(runDir, "implementation-identity-manifest.json"),
    resolve(runDir, "prompt-identity-manifest.json"),
    ...sessionRuns.map((item) => resolve(runDir, "sessions", `${item.session.opaqueSessionId}.json`)),
    ...sessionRuns.flatMap((item) => item.callArtifactPaths),
  ];
  for (const [name, values] of Object.entries(aggregate)) {
    const artifactName = AGGREGATE_ARTIFACT_NAMES[name as keyof typeof AGGREGATE_ARTIFACT_NAMES];
    if (!artifactName) throw new Error(`aggregate artifact name is not frozen for ${name}`);
    const path = resolve(runDir, artifactName);
    writeJsonl(path, values as unknown[]);
    artifactPaths.push(path);
  }
  const rawTokenCount = getEncoding("o200k_base").encode(
    sessions.flatMap((session) => session.rawTurns.map((turn) => turn.content)).join("\n"),
  ).length;
  const provenanceStorageByteCount = ([
    "sourceSelectors",
    "metadataSelectors",
    "supportBindings",
    "resolutionAssertions",
    "derivations",
    "attempts",
    "attemptSupersessions",
    "attemptResults",
    "quarantines",
    "lifecycleEvents",
    "coverageRows",
    "warnings",
  ] as const).reduce((sum, key) =>
    sum + readFileSync(resolve(runDir, AGGREGATE_ARTIFACT_NAMES[key])).length, 0);
  const tokenMetricsPath = resolve(runDir, "semantic-projection-token-metrics.json");
  const semanticTokenMetrics = semanticProjectionTokenMetrics({
    records: aggregate.records,
    semantic: aggregate.defaultProjectionMembership.map((membership) => {
      const projection = aggregate.semanticProjections.find((value) => value.projectionId === membership.projectionId);
      if (!projection) throw new Error(`default semantic projection missing ${membership.projectionId}`);
      return projection;
    }),
    blocks: aggregate.assistantBlockProjections,
    rawLexicalPostings: aggregate.rawLexicalPostings,
    coverageRows: aggregate.coverageRows,
    rawTokenCount,
    rawRecoverableTurnCount: sessions.reduce((sum, session) => sum + session.rawTurns.length, 0),
    provenanceStorageByteCount,
    quarantineBacklogCount: dedupeCanonical(
      activePasses.flatMap((item) => item.quarantines),
      (value) => value.quarantineId,
    ).length,
  });
  writeJson(tokenMetricsPath, semanticTokenMetrics);
  artifactPaths.push(tokenMetricsPath);
  const semanticCostPath = resolve(runDir, "semantic-stage-cost.json");
  writeJson(semanticCostPath, costBudget.snapshot());
  artifactPaths.push(semanticCostPath);
  artifactPaths.push(SPEC_PATH, ...IMPLEMENTATION_PATHS, ...PROMPT_PATHS);
  if (incomplete.length > 0) {
    const resultPath = resolve(runDir, "incomplete-result.json");
    writeJson(resultPath, {
      status: "incomplete",
      sessions: incomplete.map((item) => ({
        sessionId: item.session.opaqueSessionId,
        errors: item.materialized.completionErrors,
      })),
      cost: costBudget.snapshot(),
    });
    appendApprovalTransition({
      ledgerPath,
      nonce: receipt.payload.nonce,
      signatureHex: receipt.signatureHex,
      nextState: "failed",
      resultSha256: fileSha(resultPath),
    });
    throw new Error("semantic materialization is incomplete; freeze and links blocked");
  }
  const semanticFreezePath = resolve(runDir, "semantic-freeze-manifest.json");
  const semanticFreeze = createSemanticFreezeManifest({
    specificationSha256: binding.specificationSha256,
    codeSha256: binding.codeSha256,
    schemaSha256: binding.schemaSha256,
    configurationSha256: binding.configurationSha256,
    promptSha256s: binding.promptSha256s,
    artifactPaths: [...new Set(artifactPaths)],
    createdAt: new Date().toISOString(),
    mapperComplete: true,
  });
  writeJson(semanticFreezePath, semanticFreeze);
  verifyFrozenArtifacts(semanticFreeze);
  const custodyLedgerPath = resolve(runDir, "custody-ledger.jsonl");
  appendCustodyTransition({
    ledgerPath: custodyLedgerPath,
    cohortHash: binding.cohortHash,
    state: "semantic_frozen",
    semanticFreezeSha256: fileSha(semanticFreezePath),
  });

  const rawTurnById = new Map(sessions.flatMap((session) => session.rawTurns).map((turn) => [turn.rawTurnId, turn]));
  const selectorById = new Map(aggregate.sourceSelectors.map((selector) => [selector.selectorId, selector]));
  const semanticProjectionById = new Map(aggregate.semanticProjections.map((value) => [value.projectionId, value]));
  const semanticProjectionByRecord = new Map(aggregate.defaultProjectionMembership.map((membership) => {
    const projection = semanticProjectionById.get(membership.projectionId);
    if (!projection) throw new Error(`default semantic projection missing ${membership.projectionId}`);
    return [membership.recordId, projection] as const;
  }));
  const blockProjectionByBlock = new Map(aggregate.assistantBlockProjections.map((value) => [value.blockId, value]));
  const supportByTarget = new Map<string, typeof aggregate.supportBindings>();
  for (const bindingValue of aggregate.supportBindings) {
    const values = supportByTarget.get(bindingValue.targetObjectId) ?? [];
    values.push(bindingValue);
    supportByTarget.set(bindingValue.targetObjectId, values);
  }
  const safeMetadataById = new Map(aggregate.metadataSelectors
    .filter((value) => ["role", "raw_timestamp", "session_ordinal", "turn_ordinal"].includes(value.field))
    .map((value) => [value.metadataSelectorId, value]));
  const selectorOrder = (selectorId: string): { sessionOrdinal: number; turnOrdinal: number } => {
    const selector = selectorById.get(selectorId);
    const turn = selector ? rawTurnById.get(selector.rawTurnId) : undefined;
    return { sessionOrdinal: turn?.sessionOrdinal ?? Number.MAX_SAFE_INTEGER, turnOrdinal: turn?.turnOrdinal ?? Number.MAX_SAFE_INTEGER };
  };
  const provenanceFor = (objectId: string, selectorIds: readonly string[]): JsonValue => {
    const bindings = supportByTarget.get(objectId) ?? [];
    const allSelectorIds = asciiIdSort([
      ...selectorIds,
      ...bindings.flatMap((value) => value.selectorIds),
    ]);
    const metadataIds = asciiIdSort(bindings.flatMap((value) => value.metadataSelectorIds)
      .filter((id) => safeMetadataById.has(id)));
    return {
      selectors: allSelectorIds.flatMap((id) => selectorById.get(id) ?? []),
      metadataSelectors: metadataIds.flatMap((id) => safeMetadataById.get(id) ?? []),
      supportBindings: bindings,
    } as unknown as JsonValue;
  };
  const chronological: LinkCandidateObject[] = [
    ...aggregate.records.map((value): LinkCandidateObject => ({
      objectType: "record",
      objectId: value.recordId,
      sessionOrdinal: value.temporal.sessionOrdinal,
      turnOrdinal: value.temporal.turnOrdinal,
      routingText: semanticProjectionByRecord.get(value.recordId)?.canonicalText ?? value.predicate.surface,
      value: {
        record: value,
        projection: semanticProjectionByRecord.get(value.recordId) ?? null,
        resolutions: aggregate.resolutionAssertions.filter((item) => item.targetRecordId === value.recordId),
      } as unknown as JsonValue,
      provenance: provenanceFor(value.recordId, value.claimSelectorIds),
    })),
    ...aggregate.mentions.map((value): LinkCandidateObject => {
      const order = selectorOrder(value.selectorId);
      return {
        objectType: "mention",
        objectId: value.mentionId,
        ...order,
        routingText: value.surface,
        value: value as unknown as JsonValue,
        provenance: provenanceFor(value.mentionId, [value.selectorId]),
      };
    }),
    ...aggregate.assistantBlocks.map((value): LinkCandidateObject => {
      const order = selectorOrder(value.sourceSelectorId);
      const projection = blockProjectionByBlock.get(value.blockId);
      return {
        objectType: "block",
        objectId: value.blockId,
        ...order,
        routingText: [projection?.routingText ?? "", ...(projection?.routingTerms ?? [])].join(" "),
        value: { block: value, projection: projection ?? null } as unknown as JsonValue,
        provenance: provenanceFor(value.blockId, [value.sourceSelectorId]),
      };
    }),
    ...aggregate.assistantBlockItems.map((value): LinkCandidateObject => {
      const order = selectorOrder(value.sourceSelectorId);
      const projection = blockProjectionByBlock.get(value.blockId);
      return {
        objectType: "item",
        objectId: value.itemId,
        ...order,
        routingText: (projection?.itemRoutingTerms[value.itemId] ?? []).join(" "),
        value: value as unknown as JsonValue,
        provenance: provenanceFor(value.itemId, [value.sourceSelectorId]),
      };
    }),
  ];
  const endpointClockMinutes = Object.fromEntries(chronological.map((object) => {
    const provenance = object.provenance as unknown as { selectors?: Array<{ exactUtf8?: unknown }> };
    const exactTexts = (provenance.selectors ?? []).flatMap((selector) =>
      typeof selector.exactUtf8 === "string" ? [selector.exactUtf8] : []);
    return [object.objectId, explicitClockMinutes(exactTexts)] as const;
  }));
  const linkChunkSize = Number(args["link-chunk-size"] ?? 120);
  const linkChunks = linkCandidateBatches(chronological, linkChunkSize);
  const linkBatchManifestPath = resolve(runDir, "link-candidate-batches.json");
  writeJson(linkBatchManifestPath, linkChunks.map((chunk, index) => ({
    batchNumber: index + 1,
    objectIds: chunk.map((value) => value.objectId),
    inputSha256: sha256(canonicalJson(chunk as unknown as JsonValue)),
  })));
  const allowedEndpoints = new Set([
    ...aggregate.records.map((value) => value.recordId),
    ...aggregate.mentions.map((value) => value.mentionId),
    ...aggregate.assistantBlocks.map((value) => value.blockId),
    ...aggregate.assistantBlockItems.map((value) => value.itemId),
  ]);
  const allowedSelectors = new Set(aggregate.sourceSelectors.map((value) => value.selectorId));
  const allowedMetadata = new Set(safeMetadataById.keys());
  const linkCalls = await mapPool(linkChunks, positiveInteger(args, "concurrency"), async (chunk, index): Promise<{
    output: LinkerOutput | null;
    attempt: Attempt;
    artifactPath: string;
    error: string | null;
  }> => {
    const artifactPath = resolve(runDir, "calls", "linker", `chunk-${String(index + 1)}.json`);
    const batchEndpointIds = new Set(chunk.map((value) => value.objectId));
    const prompt = await prompts.render("beam-structured-event-link-v1", {
      semantic_freeze_manifest: JSON.stringify(semanticFreeze),
      chronological_objects: JSON.stringify(chunk),
      allowed_endpoints: JSON.stringify({
        endpointIds: [...batchEndpointIds],
        selectorIds: [...allowedSelectors],
        metadataSelectorIds: [...allowedMetadata],
      }),
    });
    const inputContextManifest = {
      semanticFreezeSha256: fileSha(semanticFreezePath),
      batchNumber: index + 1,
      objectIds: asciiIdSort([...batchEndpointIds]),
      batchInputSha256: sha256(canonicalJson(chunk as unknown as JsonValue)),
    } satisfies JsonValue;
    const traces: StructuredCallAttemptTrace[] = [];
    try {
      const invoke = (callPrompt: typeof prompt): Promise<StructuredCallResult<LinkerOutput>> =>
        callStructured({
          openai,
          dispatch,
          costBudget,
          model: linker.model,
          reasoning: linker.reasoning as ReasoningEffort,
          prompt: callPrompt,
          schema: LinkerOutputSchema,
          schemaName: "beam_structured_event_linker_v1",
          maxOutputTokens: Number(args["linker-max-output"] ?? 64_000),
          dispatchOutputTokens: Number(args["linker-max-output"] ?? 64_000),
          rawSessionIdsForLeakCheck: sessions.map((session) => session.hostSessionId),
          onAttempt: (trace) => { traces.push(trace); },
        });
      let call: StructuredCallResult<LinkerOutput>;
      let output: LinkerOutput;
      let schemaRepairDiagnostic: JsonValue | null = null;
      const validatedOutput = (candidate: StructuredCallResult<LinkerOutput>): LinkerOutput => {
        const parsed = LinkerOutputSchema.parse(candidate.value);
        if (parsed.links.some((link) =>
          !batchEndpointIds.has(link.sourceEndpoint.endpointId)
          || !batchEndpointIds.has(link.targetEndpoint.endpointId))) {
          throw new Error("linker cited an endpoint outside its approved candidate batch");
        }
        return parsed;
      };
      try {
        call = await invoke(prompt);
        output = validatedOutput(call);
      } catch (primaryError) {
        const prior = lastTrace(traces);
        const message = primaryError instanceof Error ? primaryError.message : String(primaryError);
        schemaRepairDiagnostic = {
          invariant: "schema_valid_complete_link_output",
          validationError: message,
          priorOutputSha256: prior?.outputText ? sha256(prior.outputText) : null,
        };
        const priorOutputInstruction = prior?.outputText
          ? `Previous output: ${prior.outputText}`
          : "The provider did not expose the rejected JSON. Rebuild the full output from the original frozen inputs above.";
        call = await invoke({
          promptId: `${prompt.promptId}-schema-repair`,
          messages: [
            ...prompt.messages,
            {
              role: "user",
              content: [
                "Your previous complete linker output failed the frozen schema validator.",
                "Return the full corrected output, preserving valid links and changing only what is required by the validation error.",
                `Validation error: ${message}`,
                "For source_span use at least one allowed selector ID. For structural_order or immutable_timestamp use at least one allowed metadata selector ID. For temporal_parse use a non-null tagged parsedValue. Cite only endpoint IDs in this batch.",
                priorOutputInstruction,
              ].join("\n\n"),
            },
          ],
        });
        output = validatedOutput(call);
      }
      const generatedOutput = output;
      const auditTraces: StructuredCallAttemptTrace[] = [];
      let auditCall: StructuredCallResult<LinkAuditOutput> | null = null;
      let auditRepairDiagnostic: JsonValue | null = null;
      if (generatedOutput.links.length > 0) {
        const indexedLinks = generatedOutput.links.map((link, linkIndex) => ({ linkIndex, link }));
        const auditPrompt = await prompts.render("beam-structured-event-link-audit-v1", {
          chronological_objects: JSON.stringify(chunk),
          proposed_links: JSON.stringify(indexedLinks),
        });
        const invokeAudit = (callPrompt: typeof auditPrompt): Promise<StructuredCallResult<LinkAuditOutput>> =>
          callStructured({
            openai,
            dispatch,
            costBudget,
            model: linker.model,
            reasoning: linker.reasoning as ReasoningEffort,
            prompt: callPrompt,
            schema: LinkAuditOutputSchema,
            schemaName: "beam_structured_event_link_audit_v1",
            maxOutputTokens: Number(args["linker-max-output"] ?? 64_000),
            dispatchOutputTokens: Number(args["linker-max-output"] ?? 64_000),
            rawSessionIdsForLeakCheck: sessions.map((session) => session.hostSessionId),
            onAttempt: (trace) => { auditTraces.push(trace); },
          });
        const auditedOutput = (candidate: StructuredCallResult<LinkAuditOutput>): LinkerOutput =>
          applyActiveLinkEvidenceFloor(
            applyLinkAudit(generatedOutput, LinkAuditOutputSchema.parse(candidate.value)),
            endpointClockMinutes,
          );
        try {
          auditCall = await invokeAudit(auditPrompt);
          output = auditedOutput(auditCall);
        } catch (primaryError) {
          const prior = lastTrace(auditTraces);
          const message = primaryError instanceof Error ? primaryError.message : String(primaryError);
          auditRepairDiagnostic = {
            invariant: "one_independent_audit_decision_per_proposed_link",
            validationError: message,
            priorOutputSha256: prior?.outputText ? sha256(prior.outputText) : null,
          };
          auditCall = await invokeAudit({
            promptId: `${auditPrompt.promptId}-completeness-repair`,
            messages: [
              ...auditPrompt.messages,
              {
                role: "user",
                content: [
                  "Your previous audit failed the frozen completeness validator.",
                  `Return exactly one decision for every linkIndex in this list, in order: ${JSON.stringify(indexedLinks.map((value) => value.linkIndex))}`,
                  `Validation error: ${message}`,
                  prior?.outputText ? `Previous output: ${prior.outputText}` : "Rebuild the audit from the original inputs.",
                ].join("\n\n"),
              },
            ],
          });
          output = auditedOutput(auditCall);
        }
      }
      const attempt = createAttempt({
        runId,
        targetId: "query_blind_link_generation",
        pageNumber: index + 1,
        inputContextManifest,
        inputContextManifestSha256: sha256(canonicalJson(inputContextManifest)),
        parentAttemptIds: [],
        trigger: "linker",
        model: linker.model,
        promptSha256: fileSha(LINKER_PROMPT_PATH),
        schemaSha256: fileSha(SCHEMA_PATH),
        rawProviderOutput: call.outputText,
        rawOutputSha256: sha256(call.outputText),
        parsedDrafts: output as unknown as JsonValue,
        diagnostics: [schemaRepairDiagnostic, auditRepairDiagnostic]
          .filter((value) => value !== null) as JsonValue[],
        warnings: [],
        finishReason: call.responseStatus,
        outputComplete: call.responseStatus === "completed" && call.incompleteReason === null,
        extractionConfidence: null,
      });
      writeJson(artifactPath, {
        call: callArtifact(call),
        traces,
        schemaRepairDiagnostic,
        generatedOutput,
        auditCall: auditCall ? callArtifact(auditCall) : null,
        auditTraces,
        auditRepairDiagnostic,
        auditedOutput: output,
        attempt,
      });
      return { output, attempt, artifactPath, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const trace = lastTrace(traces);
      const rawProviderOutput = trace?.outputText ?? "";
      const attempt = createAttempt({
        runId,
        targetId: "query_blind_link_generation",
        pageNumber: index + 1,
        inputContextManifest,
        inputContextManifestSha256: sha256(canonicalJson(inputContextManifest)),
        parentAttemptIds: [],
        trigger: "linker",
        model: linker.model,
        promptSha256: fileSha(LINKER_PROMPT_PATH),
        schemaSha256: fileSha(SCHEMA_PATH),
        rawProviderOutput,
        rawOutputSha256: sha256(rawProviderOutput),
        parsedDrafts: null,
        diagnostics: [{ error: message }],
        warnings: [],
        finishReason: trace?.incompleteReason ?? trace?.status ?? "call_failed",
        outputComplete: false,
        extractionConfidence: null,
      });
      writeJson(artifactPath, { error: message, traces, attempt, promptMessages: prompt.messages });
      return { output: null, attempt, artifactPath, error: message };
    }
  });
  const failedLinkCalls = linkCalls.filter((value) => value.output === null);
  if (failedLinkCalls.length > 0) {
    const resultPath = resolve(runDir, "link-incomplete-result.json");
    writeJson(resultPath, {
      status: "incomplete",
      failedBatches: failedLinkCalls.map((value) => ({ page: value.attempt.pageNumber, error: value.error })),
      attempts: linkCalls.map((value) => value.attempt),
      cost: costBudget.snapshot(),
    });
    appendApprovalTransition({
      ledgerPath,
      nonce: receipt.payload.nonce,
      signatureHex: receipt.signatureHex,
      nextState: "failed",
      resultSha256: fileSha(resultPath),
    });
    throw new Error("query-blind link generation is incomplete");
  }
  const linkOutputs = linkCalls.flatMap((value) => value.output ? [value.output] : []);
  const links = materializeLinkerOutputs({
    outputs: linkOutputs,
    allowedEndpointIds: allowedEndpoints,
    allowedSelectorIds: allowedSelectors,
    allowedMetadataSelectorIds: allowedMetadata,
  });
  const linkDerivations: DerivationOccurrence[] = [];
  const linkAttemptResults = linkCalls.map((value) => {
    if (!value.output) throw new Error("link call completion state changed");
    const occurrenceLinks = materializeLinkerOutputs({
      outputs: [value.output],
      allowedEndpointIds: allowedEndpoints,
      allowedSelectorIds: allowedSelectors,
      allowedMetadataSelectorIds: allowedMetadata,
    });
    for (const link of occurrenceLinks) {
      linkDerivations.push(createDerivationOccurrence({
        attemptId: value.attempt.attemptId,
        objectType: "link",
        objectId: link.linkId,
        proposalLocalKey: `link_${String(value.attempt.pageNumber)}_${link.linkId}`,
        extractionConfidence: link.confidence,
      }));
    }
    return createAttemptMaterializationResult({
      attemptId: value.attempt.attemptId,
      status: "accepted",
      materializedObjectIds: occurrenceLinks.map((link) => link.linkId),
      quarantineIds: [],
      completionErrors: [],
      warnings: [],
    });
  });
  const generation = linkGeneration({
    links,
    mapperFreezeSha256: fileSha(semanticFreezePath),
    linkerPromptSha256: fileSha(LINKER_PROMPT_PATH),
    linkerModel: linker.model,
  });
  const linksPath = resolve(runDir, "typed-links.jsonl");
  const generationPath = resolve(runDir, "link-generation.json");
  const linkAttemptsPath = resolve(runDir, "link-attempts.jsonl");
  const linkAttemptResultsPath = resolve(runDir, "link-attempt-results.jsonl");
  const linkDerivationsPath = resolve(runDir, "link-derivations.jsonl");
  const unresolvedRelationsPath = resolve(runDir, "unresolved-link-relations.jsonl");
  writeJsonl(linksPath, links);
  writeJson(generationPath, generation);
  writeJsonl(linkAttemptsPath, linkCalls.map((value) => value.attempt));
  writeJsonl(linkAttemptResultsPath, linkAttemptResults);
  writeJsonl(linkDerivationsPath, dedupeCanonical(linkDerivations, (value) => value.derivationId));
  writeJsonl(unresolvedRelationsPath, linkOutputs.flatMap((value) => value.unresolvedRelations));
  const linkCostPath = resolve(runDir, "semantic-plus-link-cost.json");
  writeJson(linkCostPath, costBudget.snapshot());
  const linkProvenanceStorageByteCount = [
    linksPath,
    generationPath,
    linkAttemptsPath,
    linkAttemptResultsPath,
    linkDerivationsPath,
    unresolvedRelationsPath,
  ].reduce((sum, path) => sum + readFileSync(path).length, 0);
  const postLinkAccountingPath = resolve(runDir, "post-link-ingestion-accounting.json");
  writeJson(postLinkAccountingPath, {
    ...semanticTokenMetrics,
    accountingStage: "post_link_frozen",
    storage: {
      ...semanticTokenMetrics.storage,
      linkProvenanceStorageByteCount,
      totalProvenanceStorageByteCount:
        semanticTokenMetrics.storage.provenanceStorageByteCount + linkProvenanceStorageByteCount,
    },
  });
  const linkFreeze = createLinkFreezeManifest({
    semanticFreezePath,
    linkerPromptPath: LINKER_PROMPT_PATH,
    artifactPaths: [
      linksPath,
      generationPath,
      linkAttemptsPath,
      linkAttemptResultsPath,
      linkDerivationsPath,
      unresolvedRelationsPath,
      linkCostPath,
      postLinkAccountingPath,
      linkBatchManifestPath,
      ...linkCalls.map((value) => value.artifactPath),
    ],
    createdAt: new Date().toISOString(),
  });
  const linkFreezePath = resolve(runDir, "link-freeze-manifest.json");
  writeJson(linkFreezePath, linkFreeze);
  verifyFrozenArtifacts(linkFreeze);
  appendCustodyTransition({
    ledgerPath: custodyLedgerPath,
    cohortHash: binding.cohortHash,
    state: "link_frozen",
    semanticFreezeSha256: fileSha(semanticFreezePath),
    linkFreezeSha256: fileSha(linkFreezePath),
  });
  writeJson(resolve(runDir, "implementation-run-result.json"), {
    status: "awaiting_rung_evaluation",
    semanticFreeze,
    linkFreeze,
    cost: costBudget.snapshot(),
  });
  console.log(JSON.stringify({
    event: "structured_event_ingestion_complete_awaiting_evaluation",
    runDir,
    cost: costBudget.snapshot(),
  }, null, 2));
}

async function run(args: Record<string, string>): Promise<void> {
  try {
    await executeRun(args);
  } catch (error) {
    try {
      const receipt = SignedApprovalReceiptSchema.parse(JSON.parse(readFileSync(pathValue(args.receipt), "utf8")));
      const runDir = pathValue(args.out);
      const failurePath = resolve(runDir, "implementation-execution-failure.json");
      writeJson(failurePath, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
      });
      appendApprovalTransition({
        ledgerPath: resolve(pathValue(args.out), "approval-ledger.jsonl"),
        nonce: receipt.payload.nonce,
        signatureHex: receipt.signatureHex,
        nextState: "failed",
        resultSha256: fileSha(failurePath),
      });
    } catch {
      // Failure before nonce consumption, or an already-recorded terminal failure.
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.command ?? "packet";
  if (command === "packet") await packet(args);
  else if (command === "run") await run(args);
  else throw new Error("--command must be packet or run");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
