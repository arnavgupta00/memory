import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import OpenAI from "openai";
import { z } from "zod";

import {
  CostBudget,
  DispatchGate,
  callStructured,
  mapPool,
  type ReasoningEffort,
  type StructuredCallAttemptTrace,
  type StructuredCallResult,
} from "../compression/structuredCall.js";
import {
  ApprovalExecutionBindingSchema,
  SignedApprovalReceiptSchema,
  appendApprovalTransition,
  verifyRunningApproval,
} from "../ingestion/structuredEventApprovalV1.js";
import {
  DiscoveryEvidenceSchema,
  EntailmentJudgmentSchema,
  LinkFreezeManifestSchema,
  ObligationManifestSchema,
  PrecisionPopulationRowSchema,
  SemanticFreezeManifestSchema,
  SupportJudgmentSchema,
  bindSupportJudgmentsToExpectedIds,
  enforceSupportedEntailments,
  exactGateKey,
  oneSidedPrecisionLowerBound95,
  precisionGateDecision,
  precisionStratumKey,
  recordProvenanceSelectorIds,
  readFrozenSettledCost,
  summarizeTypedEvaluation,
  validateEntailmentJudgmentCitations,
  validateSupportJudgmentBatchCompleteness,
  validateDiscoveryNegative,
  verifyFrozenArtifacts,
  type DiscoveryEvidence,
  type EntailmentJudgment,
  type SupportJudgment,
  type TypedObligation,
} from "../ingestion/structuredEventEvaluationV1.js";
import {
  appendCustodyTransition,
  latestCustodyState,
} from "../ingestion/structuredEventCustodyV1.js";
import {
  AssistantBlockItemSchema,
  AssistantBlockProjectionSchema,
  AssistantBlockSchema,
  DefaultProjectionMembershipSchema,
  DerivationOccurrenceSchema,
  MetadataSelectorSchema,
  MentionSchema,
  ResolutionAssertionSchema,
  RawLexicalPostingSchema,
  SemanticProjectionSchema,
  SemanticRecordSchema,
  SourceSelectorSchema,
  SupportBindingSchema,
  TypedLinkSchema,
  canonicalJson,
  type JsonValue,
} from "../ingestion/structuredEventSchemaV1.js";
import { PromptLoader } from "../services/promptLoader.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const EntailmentBatchSchema = z.strictObject({ judgments: z.array(EntailmentJudgmentSchema) });
const SupportBatchSchema = z.strictObject({ judgments: z.array(SupportJudgmentSchema) });
const AccountingMetricsSchema = z.object({
  fractionOfRaw: z.number().nonnegative().nullable(),
  rawLexicalIndexTokens: z.number().int().nonnegative(),
  storage: z.object({
    provenanceStorageByteCount: z.number().int().nonnegative(),
    linkProvenanceStorageByteCount: z.number().int().nonnegative(),
    totalProvenanceStorageByteCount: z.number().int().nonnegative(),
  }).passthrough(),
  roleDistribution: z.object({}).passthrough(),
  coverage: z.object({}).passthrough(),
  deduplicationPolicy: z.string().min(1),
}).passthrough();

function parseArgs(argv: string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value?.startsWith("--")) continue;
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) output[value.slice(2)] = "true";
    else {
      output[value.slice(2)] = next;
      index += 1;
    }
  }
  return output;
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

function readJson<T>(path: string, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function readJsonl<T>(path: string, schema: z.ZodType<T>): T[] {
  return readFileSync(path, "utf8").split("\n").filter(Boolean)
    .map((line) => schema.parse(JSON.parse(line)));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function callArtifact<T>(call: StructuredCallResult<T>, traces: StructuredCallAttemptTrace[]): Record<string, JsonValue> {
  return {
    value: call.value as unknown as JsonValue,
    outputText: call.outputText,
    usage: call.usage as unknown as JsonValue,
    latencyMs: call.latencyMs,
    requestId: call.requestId,
    retryCount: call.retryCount,
    inputSha256: call.inputSha256,
    promptCacheKey: call.promptCacheKey,
    estimatedCostUsd: call.estimatedCostUsd,
    promptMessages: call.promptMessages as unknown as JsonValue,
    responseStatus: call.responseStatus,
    incompleteReason: call.incompleteReason,
    traces: traces as unknown as JsonValue,
  };
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) throw new Error("chunk size must be positive");
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

type Candidate = {
  objectId: string;
  plane: "semantic_record" | "semantic_operand" | "assistant_block" | "typed_link";
  representation: JsonValue;
  selectorIds: string[];
};

function candidatePlane(obligation: TypedObligation): Candidate["plane"] | null {
  if (obligation.eligiblePlane === "semantic_record") return "semantic_record";
  if (obligation.eligiblePlane === "semantic_operand") return "semantic_operand";
  if (obligation.eligiblePlane === "assistant_block") return "assistant_block";
  if (obligation.eligiblePlane === "typed_link") return "typed_link";
  return null;
}

function reasoning(value: string): ReasoningEffort {
  if (value !== "low" && value !== "medium" && value !== "high") throw new Error(`unsupported reasoning ${value}`);
  return value;
}

async function run(args: Record<string, string>): Promise<void> {
  const runDir = pathValue(args.out);
  const receipt = readJson(pathValue(args.receipt), SignedApprovalReceiptSchema);
  const binding = readJson(resolve(runDir, "execution-binding.json"), ApprovalExecutionBindingSchema);
  const ledgerPath = pathValue(args.ledger);
  if (ledgerPath !== resolve(binding.outputDirectory, "approval-ledger.jsonl")) {
    throw new Error("approval ledger must be the canonical ledger inside the bound output directory");
  }
  const approvalKey = process.env.BEAM_TEST_APPROVAL_HMAC_KEY;
  if (!approvalKey) throw new Error("BEAM_TEST_APPROVAL_HMAC_KEY is required");
  verifyRunningApproval({
    signedReceipt: receipt,
    verificationKey: Buffer.from(approvalKey, "base64"),
    expectedKeyId: args["approval-key-id"] ?? "beam-test-control-v1",
    expectedExecution: binding,
    ledgerPath,
  });

  try {
    const semanticFreezePath = resolve(runDir, "semantic-freeze-manifest.json");
    const linkFreezePath = resolve(runDir, "link-freeze-manifest.json");
    const semanticFreeze = readJson(semanticFreezePath, SemanticFreezeManifestSchema);
    const linkFreeze = readJson(linkFreezePath, LinkFreezeManifestSchema);
    verifyFrozenArtifacts(semanticFreeze);
    verifyFrozenArtifacts(linkFreeze);
    if (linkFreeze.semanticFreezeSha256 !== fileSha(semanticFreezePath)) throw new Error("link freeze is not bound to semantic freeze");
    if (
      semanticFreeze.specificationSha256 !== binding.specificationSha256
      || semanticFreeze.codeSha256 !== binding.codeSha256
      || semanticFreeze.schemaSha256 !== binding.schemaSha256
      || semanticFreeze.configurationSha256 !== binding.configurationSha256
    ) throw new Error("semantic freeze identity differs from approved execution");
    const configuration = JSON.parse(readFileSync(resolve(runDir, "execution-configuration.json"), "utf8")) as JsonValue;
    if (sha256(canonicalJson(configuration)) !== binding.configurationSha256) throw new Error("execution configuration mutated");

    // Certification/development obligations are opened only after both freezes pass.
    const manifestPath = pathValue(args.manifest);
    const expectedManifestSha = (configuration as unknown as { evaluationManifestSha256?: unknown }).evaluationManifestSha256;
    if (typeof expectedManifestSha !== "string") throw new Error("approved evaluation manifest hash is missing");
    const custodyLedgerPath = resolve(runDir, "custody-ledger.jsonl");
    const custody = latestCustodyState(custodyLedgerPath, binding.cohortHash);
    if (
      custody?.state !== "link_frozen"
      || custody.semanticFreezeSha256 !== fileSha(semanticFreezePath)
      || custody.linkFreezeSha256 !== fileSha(linkFreezePath)
    ) throw new Error("custody ledger does not prove query-blind link freeze ordering");
    appendCustodyTransition({
      ledgerPath: custodyLedgerPath,
      cohortHash: binding.cohortHash,
      state: "evaluation_unsealed",
      semanticFreezeSha256: fileSha(semanticFreezePath),
      linkFreezeSha256: fileSha(linkFreezePath),
      evaluationManifestSha256: expectedManifestSha,
    });
    if (fileSha(manifestPath) !== expectedManifestSha) {
      throw new Error("evaluation manifest does not match the approved sealed hash");
    }
    const manifest = readJson(manifestPath, ObligationManifestSchema);
    if (manifest.cohortHash !== binding.cohortHash) throw new Error("obligation cohort hash differs from approval");
    const expectedRole = (configuration as unknown as { evaluationRole?: unknown }).evaluationRole;
    if (manifest.role !== expectedRole) throw new Error("obligation manifest role differs from approved evaluation role");

    const records = readJsonl(resolve(runDir, "records.jsonl"), SemanticRecordSchema);
    const semanticProjections = readJsonl(resolve(runDir, "semanticProjections.jsonl"), SemanticProjectionSchema);
    const defaultMembership = readJsonl(
      resolve(runDir, "defaultProjectionMembership.jsonl"),
      DefaultProjectionMembershipSchema,
    );
    const blocks = readJsonl(resolve(runDir, "assistantBlocks.jsonl"), AssistantBlockSchema);
    const items = readJsonl(resolve(runDir, "assistantBlockItems.jsonl"), AssistantBlockItemSchema);
    const blockProjections = readJsonl(resolve(runDir, "assistantBlockProjections.jsonl"), AssistantBlockProjectionSchema);
    const links = readJsonl(resolve(runDir, "typed-links.jsonl"), TypedLinkSchema);
    const mentions = readJsonl(resolve(runDir, "mentions.jsonl"), MentionSchema);
    const selectors = readJsonl(resolve(runDir, "sourceSelectors.jsonl"), SourceSelectorSchema);
    const metadata = readJsonl(resolve(runDir, "metadataSelectors.jsonl"), MetadataSelectorSchema);
    const support = readJsonl(resolve(runDir, "supportBindings.jsonl"), SupportBindingSchema);
    const resolutions = readJsonl(resolve(runDir, "resolutionAssertions.jsonl"), ResolutionAssertionSchema);
    const derivations = readJsonl(resolve(runDir, "derivations.jsonl"), DerivationOccurrenceSchema);
    const rawLexicalPostings = readJsonl(resolve(runDir, "rawLexicalPostings.jsonl"), RawLexicalPostingSchema);
    const projectionById = new Map(semanticProjections.map((value) => [value.projectionId, value]));
    const projectionByRecord = new Map(defaultMembership.map((membership) => {
      const projection = projectionById.get(membership.projectionId);
      if (!projection || projection.recordId !== membership.recordId) {
        throw new Error(`default projection membership is invalid for ${membership.recordId}`);
      }
      return [membership.recordId, projection] as const;
    }));
    const activeRecords = records.filter((record) => projectionByRecord.has(record.recordId));
    if (activeRecords.length !== defaultMembership.length) {
      throw new Error("default projection membership does not match the active record population exactly");
    }
    const recordSelectorIds = new Map(activeRecords.map((record) => [
      record.recordId,
      recordProvenanceSelectorIds(record, support),
    ]));
    const projectionByBlock = new Map(blockProjections.map((value) => [value.blockId, value]));
    const itemByBlock = new Map<string, typeof items>();
    for (const item of items) {
      const values = itemByBlock.get(item.blockId) ?? [];
      values.push(item);
      itemByBlock.set(item.blockId, values);
    }
    const candidates: Candidate[] = [
      ...activeRecords.map((record): Candidate => ({
        objectId: record.recordId,
        plane: "semantic_record",
        representation: {
          record,
          projection: projectionByRecord.get(record.recordId) ?? null,
          confirmedResolutions: resolutions.filter((value) => value.targetRecordId === record.recordId && value.status === "confirmed"),
        } as unknown as JsonValue,
        selectorIds: recordSelectorIds.get(record.recordId) ?? record.claimSelectorIds,
      })),
      ...activeRecords.map((record): Candidate => ({
        objectId: record.recordId,
        plane: "semantic_operand",
        representation: {
          record,
          projection: projectionByRecord.get(record.recordId) ?? null,
          confirmedResolutions: resolutions.filter((value) => value.targetRecordId === record.recordId && value.status === "confirmed"),
        } as unknown as JsonValue,
        selectorIds: recordSelectorIds.get(record.recordId) ?? record.claimSelectorIds,
      })),
      ...items.map((item): Candidate => ({
        objectId: item.itemId,
        plane: "semantic_operand",
        representation: {
          item,
          parentBlock: blocks.find((block) => block.blockId === item.blockId) ?? null,
          blockProjection: projectionByBlock.get(item.blockId) ?? null,
          rawLexicalPostings: rawLexicalPostings.filter((posting) => posting.targetObjectId === item.itemId),
        } as unknown as JsonValue,
        selectorIds: [item.sourceSelectorId],
      })),
      ...blocks.map((block): Candidate => ({
        objectId: block.blockId,
        plane: "assistant_block",
        representation: {
          block,
          projection: projectionByBlock.get(block.blockId) ?? null,
          items: itemByBlock.get(block.blockId) ?? [],
          rawLexicalPostings: rawLexicalPostings.filter((posting) =>
            posting.targetObjectId === block.blockId
            || (itemByBlock.get(block.blockId) ?? []).some((item) => item.itemId === posting.targetObjectId)),
        } as unknown as JsonValue,
        selectorIds: [block.sourceSelectorId, ...(itemByBlock.get(block.blockId) ?? []).map((item) => item.sourceSelectorId)],
      })),
      ...links.map((link): Candidate => ({
        objectId: link.linkId,
        plane: "typed_link",
        representation: link as unknown as JsonValue,
        selectorIds: link.provenanceBasis.flatMap((basis) => basis.selectorIds),
      })),
    ];

    const prompts = new PromptLoader();
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const concurrency = binding.models[0]?.concurrency ?? 1;
    const dispatch = new DispatchGate(Number((configuration as unknown as { tokenBudget?: unknown }).tokenBudget ?? 1_900_000), 60, concurrency);
    const priorCost = readFrozenSettledCost({
      artifactPath: resolve(runDir, "semantic-plus-link-cost.json"),
      linkFreeze,
      approvedCeilingUsd: binding.hardSpendCeilingUsd,
    });
    const costBudget = new CostBudget(binding.hardSpendCeilingUsd, priorCost.spent_usd);
    const entailmentModel = binding.models.find((value) => value.role === "entailment_judge");
    const supportModel = binding.models.find((value) => value.role === "support_judge");
    if (!entailmentModel || !supportModel) throw new Error("approved judge model roles are missing");
    const judgeBatchSize = Number((configuration as unknown as { judgeBatchSize?: unknown }).judgeBatchSize ?? 120);
    const judgeMaxOutput = Number(
      (configuration as unknown as { judgeMaxOutputTokens?: unknown }).judgeMaxOutputTokens ?? 16_000,
    );
    const supportMaxOutput = Number(
      (configuration as unknown as { supportMaxOutputTokens?: unknown }).supportMaxOutputTokens ?? 16_000,
    );
    const judgments = new Map<string, EntailmentJudgment>();
    const discoveries: DiscoveryEvidence[] = [];
    const entailmentCallArtifacts: string[] = [];
    const judgedObligations = manifest.obligations.filter((obligation) => candidatePlane(obligation) !== null);
    await mapPool(judgedObligations, concurrency, async (obligation) => {
      const plane = candidatePlane(obligation);
      if (!plane) return;
      const eligible = candidates.filter((candidate) => candidate.plane === plane);
      const chunkJudgments: EntailmentJudgment[] = [];
      for (const [chunkIndex, candidateChunk] of chunks(eligible, judgeBatchSize).entries()) {
        const prompt = await prompts.render("beam-structured-event-entailment-judge-v1", {
          typed_obligations: JSON.stringify([obligation]),
          candidate_representations: JSON.stringify(candidateChunk.map((candidate) => ({
            objectId: candidate.objectId,
            plane: candidate.plane,
            representation: candidate.representation,
          }))),
        });
        const artifactPath = resolve(runDir, "calls", "entailment", obligation.obligationId, `chunk-${String(chunkIndex + 1)}.json`);
        entailmentCallArtifacts.push(artifactPath);
        const traces: StructuredCallAttemptTrace[] = [];
        const eligibleIds = new Set(candidateChunk.map((candidate) => candidate.objectId));
        const invoke = (callPrompt: typeof prompt): Promise<StructuredCallResult<z.infer<typeof EntailmentBatchSchema>>> =>
          callStructured({
            openai,
            dispatch,
            costBudget,
            model: entailmentModel.model,
            reasoning: reasoning(entailmentModel.reasoning),
            prompt: callPrompt,
            schema: EntailmentBatchSchema,
            schemaName: "beam_structured_event_entailment_batch_v1",
            maxOutputTokens: judgeMaxOutput,
            dispatchOutputTokens: judgeMaxOutput,
            onAttempt: (trace) => { traces.push(trace); },
          });
        const validatedJudgment = (candidate: StructuredCallResult<z.infer<typeof EntailmentBatchSchema>>): EntailmentJudgment => {
          const result = EntailmentBatchSchema.parse(candidate.value);
          const judgment = result.judgments.find((value) => value.obligationId === obligation.obligationId);
          if (!judgment) throw new Error(`entailment batch omitted ${obligation.obligationId}`);
          return validateEntailmentJudgmentCitations({
            judgment,
            obligationId: obligation.obligationId,
            eligibleObjectIds: eligibleIds,
          });
        };
        let call: StructuredCallResult<z.infer<typeof EntailmentBatchSchema>>;
        let judgment: EntailmentJudgment;
        let citationRepairDiagnostic: JsonValue | null = null;
        try {
          call = await invoke(prompt);
          judgment = validatedJudgment(call);
        } catch (primaryError) {
          const prior = traces[traces.length - 1];
          const message = primaryError instanceof Error ? primaryError.message : String(primaryError);
          citationRepairDiagnostic = {
            invariant: "covering_ids_are_top_level_batch_candidates",
            validationError: message,
            priorOutputSha256: prior?.outputText ? sha256(prior.outputText) : null,
          };
          call = await invoke({
            promptId: `${prompt.promptId}-citation-repair`,
            messages: [
              ...prompt.messages,
              {
                role: "user",
                content: [
                  "Your previous judgment failed the frozen citation validator.",
                  "Return the full corrected judgment. Preserve the entailment decision unless the evidence requires changing it.",
                  `Validation error: ${message}`,
                  "coveringObjectIds may contain only a top-level objectId from this exact list; never construct an ID and never cite a nested blockId, itemId, selectorId, projectionId, or postingId:",
                  JSON.stringify([...eligibleIds]),
                  prior?.outputText
                    ? `Previous output: ${prior.outputText}`
                    : "The rejected JSON was unavailable; rebuild the judgment from the original inputs.",
                ].join("\n\n"),
              },
            ],
          });
          judgment = validatedJudgment(call);
        }
        writeJson(artifactPath, { ...callArtifact(call, traces), citationRepairDiagnostic });
        chunkJudgments.push(judgment);
      }
      const combined = EntailmentJudgmentSchema.parse({
        obligationId: obligation.obligationId,
        entailed: chunkJudgments.some((value) => value.entailed),
        coveringObjectIds: [...new Set(chunkJudgments.flatMap((value) => value.coveringObjectIds))],
        missingDetails: [...new Set(chunkJudgments.flatMap((value) => value.missingDetails))].slice(0, 32),
      });
      judgments.set(obligation.obligationId, combined);
      const discovery = DiscoveryEvidenceSchema.parse({
        obligationId: obligation.obligationId,
        eligibleObjectIds: eligible.map((candidate) => candidate.objectId),
        discoveredObjectIds: eligible.map((candidate) => candidate.objectId),
        exhaustivelyScannedObjectIds: eligible.map((candidate) => candidate.objectId),
        validatedDiscoveryRecallBound: null,
      });
      validateDiscoveryNegative(obligation, discovery, combined);
      discoveries.push(discovery);
    });
    for (const obligation of manifest.obligations) {
      if (!judgments.has(obligation.obligationId)) judgments.set(obligation.obligationId, {
        obligationId: obligation.obligationId,
        entailed: false,
        coveringObjectIds: [],
        missingDetails: ["excluded from ingestion/link denominators"],
      });
    }

    const selectorById = new Map(selectors.map((value) => [value.selectorId, value]));
    const metadataById = new Map(metadata.map((value) => [value.metadataSelectorId, value]));
    const supportByTarget = new Map<string, typeof support>();
    for (const bindingValue of support) {
      const values = supportByTarget.get(bindingValue.targetObjectId) ?? [];
      values.push(bindingValue);
      supportByTarget.set(bindingValue.targetObjectId, values);
    }
    const candidateById = new Map<string, Candidate>();
    for (const candidate of candidates) if (!candidateById.has(candidate.objectId)) candidateById.set(candidate.objectId, candidate);
    const clusterIdFor = (objectId: string): string => {
      const candidate = candidateById.get(objectId);
      const rawTurnIds = [...new Set((candidate?.selectorIds ?? []).flatMap((selectorId) => {
        const selector = selectorById.get(selectorId);
        return selector ? [selector.rawTurnId] : [];
      }))].sort();
      return rawTurnIds.length > 0 ? rawTurnIds.join("+") : `conversation:${binding.cohortHash}`;
    };
    const extractionConfidenceByObject = new Map<string, Set<"high" | "medium" | "low">>();
    for (const derivation of derivations) {
      if (derivation.extractionConfidence === null) continue;
      const values = extractionConfidenceByObject.get(derivation.objectId) ?? new Set<"high" | "medium" | "low">();
      values.add(derivation.extractionConfidence);
      extractionConfidenceByObject.set(derivation.objectId, values);
    }
    const confidenceLevels = (objectId: string): Array<"high" | "medium" | "low" | "unknown"> => {
      const values = extractionConfidenceByObject.get(objectId);
      return values && values.size > 0 ? [...values].sort() : ["unknown"];
    };
    const population = [
      ...activeRecords.map((record) => PrecisionPopulationRowSchema.parse({
        objectId: record.recordId,
        clusterId: clusterIdFor(record.recordId),
        sourceRole: record.stance.sourceSpeakerRole,
        plane: "semantic_record",
        speechAct: record.stance.speechAct,
        discourseFrame: record.discourseContext.frame,
        usesResolution: resolutions.some((value) => value.targetRecordId === record.recordId && value.status === "confirmed"),
        confidenceLevels: confidenceLevels(record.recordId),
        listLengthBucket: "none",
        objectKind: record.recordKind,
        critical: record.discourseContext.frame !== "actual_report" || record.stance.modalForce !== "actual",
      })),
      ...blocks.map((block) => PrecisionPopulationRowSchema.parse({
        objectId: block.blockId,
        clusterId: clusterIdFor(block.blockId),
        sourceRole: "assistant",
        plane: "assistant_block",
        speechAct: "recommendation",
        discourseFrame: block.discourseContext.frame,
        usesResolution: false,
        confidenceLevels: confidenceLevels(block.blockId),
        listLengthBucket: (itemByBlock.get(block.blockId)?.length ?? 0) >= 10 ? "long" : "short",
        objectKind: block.blockKind,
        critical: block.discourseContext.frame !== "actual_report" || (itemByBlock.get(block.blockId)?.length ?? 0) >= 10,
      })),
      ...links.map((link) => PrecisionPopulationRowSchema.parse({
        objectId: link.linkId,
        clusterId: clusterIdFor(link.linkId),
        sourceRole: "mixed",
        plane: "typed_link",
        speechAct: link.assertion,
        discourseFrame: "link_overlay",
        usesResolution: link.type.includes("ENTITY") || link.type.includes("EVENT"),
        confidenceLevels: [link.confidence],
        listLengthBucket: "none",
        objectKind: link.type,
        critical: link.confidence === "low" || link.status === "confirmed",
      })),
    ];
    const precisionSample = [...population];
    const precisionSampleIds = new Set(precisionSample.map((value) => value.objectId));
    const stratumKeys = [...new Set(population.map(precisionStratumKey))].sort();
    const precisionSamplingDesign = {
      populationSize: population.length,
      sampleSize: precisionSample.length,
      isCensus: precisionSample.length === population.length,
      samplingMode: manifest.precisionPolicy.samplingMode,
      denominatorBasis: manifest.precisionPolicy.denominatorBasis,
      clusterCount: new Set(population.map((value) => value.clusterId)).size,
      populationClaimMethod: "none",
      strata: stratumKeys.map((stratum) => {
        const populationCount = population.filter((value) => precisionStratumKey(value) === stratum).length;
        const sampleCount = precisionSample.filter((value) => precisionStratumKey(value) === stratum).length;
        return {
          stratum,
          populationCount,
          sampleCount,
          inclusionFraction: populationCount === 0 ? null : sampleCount / populationCount,
        };
      }),
    };
    // Link-support judges need endpoint-bound source text, not an unordered
    // union of link provenance. Package each endpoint with its own immutable
    // selector(s) so source/target evidence cannot be accidentally reversed.
    const endpointRepresentationById = new Map<string, JsonValue>([
      ...activeRecords.map((record) => [record.recordId, {
        record,
        claimSelectors: recordProvenanceSelectorIds(
          record,
          supportByTarget.get(record.recordId) ?? [],
        ).map((selectorId) => selectorById.get(selectorId) ?? null),
      } as unknown as JsonValue] as const),
      ...mentions.map((mention) => [mention.mentionId, {
        mention,
        sourceSelector: selectorById.get(mention.selectorId) ?? null,
      } as unknown as JsonValue] as const),
      ...blocks.map((block) => [block.blockId, {
        block,
        sourceSelector: selectorById.get(block.sourceSelectorId) ?? null,
        items: itemByBlock.get(block.blockId) ?? [],
      } as unknown as JsonValue] as const),
      ...items.map((item) => [item.itemId, {
        item,
        sourceSelector: selectorById.get(item.sourceSelectorId) ?? null,
        parentBlock: blocks.find((block) => block.blockId === item.blockId) ?? null,
      } as unknown as JsonValue] as const),
    ]);
    const positiveObjectIds = [...new Set([...judgments.values()]
      .filter((judgment) => judgment.entailed)
      .flatMap((judgment) => judgment.coveringObjectIds))];
    const supportObjectIds = [...new Set([
      ...precisionSample.map((row) => row.objectId),
      ...positiveObjectIds,
    ])].sort();
    const supportPackages = supportObjectIds.map((objectId) => {
      const candidate = candidateById.get(objectId);
      if (!candidate) throw new Error(`support object missing ${objectId}`);
      const bindings = supportByTarget.get(objectId) ?? [];
      const confirmedResolutions = resolutions.filter(
        (value) => value.targetRecordId === objectId && value.status === "confirmed",
      );
      const link = links.find((value) => value.linkId === objectId);
      const selectorIds = [...new Set([
        ...candidate.selectorIds,
        ...bindings.flatMap((value) => value.selectorIds),
        ...confirmedResolutions.flatMap((value) => value.selectorIds),
        ...(link?.provenanceBasis.flatMap((basis) => basis.selectorIds) ?? []),
      ])];
      const metadataIds = [...new Set([
        ...bindings.flatMap((value) => value.metadataSelectorIds),
        ...confirmedResolutions.flatMap((value) => value.metadataSelectorIds),
        ...(link?.provenanceBasis.flatMap((basis) => basis.metadataSelectorIds) ?? []),
      ])];
      const sourceSelectors = selectorIds.map((id) => {
        const selector = selectorById.get(id);
        if (!selector) throw new Error(`support package lost selector ${id}`);
        return selector;
      });
      const metadataSelectors = metadataIds.map((id) => {
        const selector = metadataById.get(id);
        if (!selector) throw new Error(`support package lost metadata selector ${id}`);
        return selector;
      });
      return {
        objectId,
        representation: candidate.representation,
        supportBindings: bindings,
        resolutionAssertions: confirmedResolutions,
        linkProvenanceBasis: link?.provenanceBasis ?? [],
        endpointRepresentations: link ? [link.sourceEndpoint, link.targetEndpoint].map((endpoint) => ({
          endpoint,
          representation: endpointRepresentationById.get(endpoint.endpointId) ?? null,
        })) : [],
        sourceSelectors,
        metadataSelectors,
      };
    });
    const supportCallArtifacts: string[] = [];
    const supportJudgments: SupportJudgment[] = [];
    await mapPool(chunks(supportPackages, Math.min(judgeBatchSize, 50)), concurrency, async (batch, batchIndex) => {
      const prompt = await prompts.render("beam-structured-event-support-judge-v1", {
        representations_with_provenance: JSON.stringify(batch),
      });
      const traces: StructuredCallAttemptTrace[] = [];
      const artifactPath = resolve(runDir, "calls", "support", `batch-${String(batchIndex + 1)}.json`);
      supportCallArtifacts.push(artifactPath);
      const expectedObjectIds = batch.map((value) => value.objectId);
      let hostIdentityBindings: JsonValue = [];
      const invoke = (callPrompt: typeof prompt): Promise<StructuredCallResult<z.infer<typeof SupportBatchSchema>>> =>
        callStructured({
          openai,
          dispatch,
          costBudget,
          model: supportModel.model,
          reasoning: reasoning(supportModel.reasoning),
          prompt: callPrompt,
          schema: SupportBatchSchema,
          schemaName: "beam_structured_event_support_batch_v1",
          maxOutputTokens: supportMaxOutput,
          dispatchOutputTokens: supportMaxOutput,
          onAttempt: (trace) => { traces.push(trace); },
        });
      const validatedJudgments = (candidate: StructuredCallResult<z.infer<typeof SupportBatchSchema>>): SupportJudgment[] => {
        const result = SupportBatchSchema.parse(candidate.value);
        const boundJudgments = bindSupportJudgmentsToExpectedIds({
          judgments: result.judgments,
          expectedObjectIds,
        });
        hostIdentityBindings = result.judgments.flatMap((judgment, index) => {
          const bound = boundJudgments[index];
          return bound && bound.objectId !== judgment.objectId
            ? [{ returnedObjectId: judgment.objectId, boundObjectId: bound.objectId }]
            : [];
        });
        return validateSupportJudgmentBatchCompleteness({
          judgments: boundJudgments,
          expectedObjectIds,
        });
      };
      let call: StructuredCallResult<z.infer<typeof SupportBatchSchema>>;
      let batchJudgments: SupportJudgment[];
      let completenessRepairDiagnostic: JsonValue | null = null;
      try {
        call = await invoke(prompt);
        batchJudgments = validatedJudgments(call);
      } catch (primaryError) {
        const prior = traces[traces.length - 1];
        const message = primaryError instanceof Error ? primaryError.message : String(primaryError);
        completenessRepairDiagnostic = {
          invariant: "one_support_judgment_per_exact_top_level_object_id",
          validationError: message,
          priorOutputSha256: prior?.outputText ? sha256(prior.outputText) : null,
        };
        call = await invoke({
          promptId: `${prompt.promptId}-completeness-repair`,
          messages: [
            ...prompt.messages,
            {
              role: "user",
              content: [
                "Your previous output failed the frozen object-ID completeness validator.",
                "Return the full corrected batch with exactly one judgment for every object ID in the following list, in the same order.",
                "Copy every object ID verbatim. Never shorten, extend, reconstruct, omit, duplicate, or invent an ID.",
                `Validation error: ${message}`,
                `Exact object IDs: ${JSON.stringify(expectedObjectIds)}`,
                prior?.outputText
                  ? `Previous output: ${prior.outputText}`
                  : "The rejected JSON was unavailable; rebuild the judgments from the original inputs.",
              ].join("\n\n"),
            },
          ],
        });
        batchJudgments = validatedJudgments(call);
      }
      writeJson(artifactPath, {
        ...callArtifact(call, traces),
        completenessRepairDiagnostic,
        hostIdentityBindings,
      });
      supportJudgments.push(...batchJudgments);
    });

    const rawOrderedJudgments = manifest.obligations.map((obligation) => {
      const value = judgments.get(obligation.obligationId);
      if (!value) throw new Error(`missing final judgment ${obligation.obligationId}`);
      return value;
    });
    const orderedJudgments = enforceSupportedEntailments({
      judgments: rawOrderedJudgments,
      supportJudgments,
    });
    const supportedJudgmentByObligation = new Map(orderedJudgments.map((value) => [value.obligationId, value]));
    const summary = summarizeTypedEvaluation({
      obligations: manifest.obligations,
      discoveries,
      judgments: orderedJudgments,
    });
    const sourceOccurrence = manifest.obligations
      .filter((obligation) => obligation.sourceSelectorIds.length > 0 && candidatePlane(obligation) !== null)
      .map((obligation) => {
        const judgment = supportedJudgmentByObligation.get(obligation.obligationId);
        const coveredSelectors = new Set((judgment?.coveringObjectIds ?? [])
          .flatMap((id) => candidateById.get(id)?.selectorIds ?? []));
        return {
          obligationId: obligation.obligationId,
          criticality: obligation.criticality,
          stratum: obligation.stratum,
          extractedAtPreferredOccurrence: obligation.sourceSelectorIds.every((id) => coveredSelectors.has(id)),
        };
      });
    const clusteredByStratum = Object.fromEntries([...new Set(manifest.obligations.map((value) => value.stratum))]
      .sort()
      .map((stratum) => {
        const values = manifest.obligations.filter((value) => value.stratum === stratum && candidatePlane(value) !== null);
        return [stratum, {
          coveredObligations: values.filter((value) => supportedJudgmentByObligation.get(value.obligationId)?.entailed).length,
          totalObligations: values.length,
          storyIds: [...new Set(values.map((value) => value.storyId))].sort(),
        }];
      }));
    const precisionSupportJudgments = supportJudgments.filter((value) => precisionSampleIds.has(value.objectId));
    const gateValues = new Map<string, { covered: number; total: number }>();
    const addGateValue = (key: string, covered: boolean): void => {
      const value = gateValues.get(key) ?? { covered: 0, total: 0 };
      value.total += 1;
      if (covered) value.covered += 1;
      gateValues.set(key, value);
    };
    for (const obligation of manifest.obligations) {
      if (obligation.denominatorName === "not_scored") continue;
      addGateValue(
        exactGateKey(obligation),
        supportedJudgmentByObligation.get(obligation.obligationId)?.entailed === true,
      );
    }
    for (const occurrence of sourceOccurrence) {
      addGateValue(exactGateKey({
        denominatorName: "source_occurrence",
        criticality: occurrence.criticality,
        stratum: occurrence.stratum,
      }), occurrence.extractedAtPreferredOccurrence);
    }
    gateValues.set(exactGateKey({ denominatorName: "semantic_story_complete", criticality: null, stratum: null }), {
      covered: summary.semanticStories.complete,
      total: summary.semanticStories.total,
    });
    gateValues.set(exactGateKey({ denominatorName: "link_story_complete", criticality: null, stratum: null }), {
      covered: summary.linkStories.complete,
      total: summary.linkStories.total,
    });
    const gateResults = manifest.exactGates.map((gate) => {
      const actual = gateValues.get(exactGateKey(gate));
      const passed = actual !== undefined && actual.total === gate.denominator && actual.covered >= gate.numeratorRequired;
      return { ...gate, actual: actual ?? null, passed };
    });
    const criticalErrors = supportJudgments.filter((value) => value.criticalError);
    const criticalSampleIds = new Set(precisionSample.filter((value) => value.critical).map((value) => value.objectId));
    const criticalSupport = precisionSupportJudgments.filter((value) => criticalSampleIds.has(value.objectId));
    const precisionSupported = precisionSupportJudgments.filter((value) => value.supported && !value.criticalError).length;
    const overallLowerBound95 = oneSidedPrecisionLowerBound95(precisionSupported, precisionSupportJudgments.length);
    const criticalSupported = criticalSupport.filter((value) => value.supported && !value.criticalError).length;
    const precisionDecision = precisionGateDecision({
      role: manifest.role,
      supported: precisionSupported,
      total: precisionSupportJudgments.length,
      criticalSupported,
      criticalTotal: criticalSupport.length,
      isCensus: precisionSamplingDesign.isCensus,
      minimumSupportedRatio: manifest.precisionPolicy.minimumSupportedRatio,
      requireAllCriticalSupported: manifest.precisionPolicy.requireAllCriticalSupported,
    });
    const precisionGate = {
      status: precisionDecision.status,
      policy: manifest.precisionPolicy,
      supported: precisionSupported,
      total: precisionSupportJudgments.length,
      criticalSupported,
      criticalTotal: criticalSupport.length,
      oneSidedConfidenceLevel: 0.95,
      oneSidedLowerBound: overallLowerBound95,
      confidenceMethod: precisionSupported === precisionSupportJudgments.length
        ? "exact_zero_failure_binomial"
        : "wilson_one_sided",
      populationClaimAllowed: precisionDecision.populationClaimAllowed,
      populationClaimReason: "cluster/design-aware population inference is not implemented; this is bounded-cohort census evidence only",
      passed: precisionDecision.passed,
    };
    const tokenMetrics = readJson(resolve(runDir, "post-link-ingestion-accounting.json"), AccountingMetricsSchema);
    const compressionGate = {
      maximumFractionOfRaw: 0.25,
      actualFractionOfRaw: tokenMetrics.fractionOfRaw ?? null,
      passed: tokenMetrics.fractionOfRaw !== null && tokenMetrics.fractionOfRaw <= 0.25,
    };
    const passed = gateResults.every((value) => value.passed)
      && criticalErrors.length === 0
      && precisionGate.passed
      && compressionGate.passed;
    const resultPath = resolve(runDir, "typed-evaluation-result.json");
    const precisionSamplePath = resolve(runDir, "precision-sample.json");
    writeJson(precisionSamplePath, precisionSample);
    const evaluationArtifacts = [...entailmentCallArtifacts, ...supportCallArtifacts, precisionSamplePath]
      .map((path) => ({ path, sha256: fileSha(path), byteLength: readFileSync(path).length }));
    writeJson(resultPath, {
      schemaVersion: 1,
      status: passed ? "passed" : "failed",
      cohortHash: binding.cohortHash,
      semanticFreezeSha256: fileSha(semanticFreezePath),
      linkFreezeSha256: fileSha(linkFreezePath),
      manifestSha256: fileSha(manifestPath),
      summary,
      sourceOccurrence,
      clusteredReporting: {
        conversationCount: 1,
        storyCount: new Set(manifest.obligations.map((value) => value.storyId)).size,
        byStratum: clusteredByStratum,
        note: "Obligation rows are not treated as independent population samples.",
      },
      discoveries,
      judgments: orderedJudgments,
      rawEntailmentJudgments: manifest.obligations.map((obligation) => judgments.get(obligation.obligationId)),
      positiveSupportObjectIds: positiveObjectIds,
      supportJudgments,
      criticalErrors,
      precisionGate,
      precisionSamplingDesign,
      compressionGate,
      accountingMetrics: tokenMetrics,
      gateResults,
      evaluationArtifacts,
      cost: costBudget.snapshot(),
    });
    appendApprovalTransition({
      ledgerPath,
      nonce: receipt.payload.nonce,
      signatureHex: receipt.signatureHex,
      nextState: passed ? "passed" : "failed",
      resultSha256: fileSha(resultPath),
    });
    if (!passed) throw new Error("typed ingestion evaluation failed; next rung is blocked");
    console.log(JSON.stringify({ event: "typed_evaluation_passed_awaiting_user_acceptance", resultPath }, null, 2));
  } catch (error) {
    const failurePath = resolve(runDir, "evaluation-execution-failure.json");
    writeJson(failurePath, { status: "failed", error: error instanceof Error ? error.message : String(error) });
    try {
      appendApprovalTransition({
        ledgerPath,
        nonce: receipt.payload.nonce,
        signatureHex: receipt.signatureHex,
        nextState: "failed",
        resultSha256: fileSha(failurePath),
      });
    } catch {
      // A gate failure may already have transitioned running -> failed above.
    }
    throw error;
  }
}

await run(parseArgs(process.argv.slice(2)));
