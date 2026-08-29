export type TraceabilityGroup = {
  requirementIds: string[];
  schemaSymbols: string[];
  productionSymbols: string[];
  automatedTestFiles: string[];
  fixtureMarkers: Array<{ path: string; marker: string }>;
  runtimeArtifacts: string[];
};

function ids(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${String(index + 1).padStart(3, "0")}`);
}

const TEST_ROOT = "src/agents/current/tests";

/**
 * Static, executable traceability. L0 expands every group into individual
 * requirement rows and verifies that every referenced file and symbol exists.
 * Runtime artifact names are contracts here; later rungs retain actual files.
 */
export const STRUCTURED_EVENT_TRACEABILITY_V1: TraceabilityGroup[] = [
  {
    requirementIds: ids("RAW", 3),
    schemaSymbols: ["RawTurnSchema", "SourceSelectorSchema", "StructuralSegmentSchema"],
    productionSymbols: ["materializeRawTurn", "resolveSourceAnchor", "segmentRawTurn", "inputConversation"],
    automatedTestFiles: [`${TEST_ROOT}/structuredEventMaterializerV1.test.ts`],
    fixtureMarkers: [{ path: `${TEST_ROOT}/structuredEventMaterializerV1.test.ts`, marker: "accepts a unique exact quote despite wrong optional context" }],
    runtimeArtifacts: ["raw-archive.json", "transport-artifact-reference.json", "sourceSelectors.jsonl"],
  },
  {
    requirementIds: ids("SEM", 9),
    schemaSymbols: ["SemanticRecordCoreSchema", "DiscourseContextSchema", "ArgumentSchema", "TemporalSchema"],
    productionSymbols: ["materializeMapperPages", "buildSemanticProjections", "defaultProjectionMembership", "assertionTime"],
    automatedTestFiles: [`${TEST_ROOT}/structuredEventMaterializerV1.test.ts`],
    fixtureMarkers: [
      { path: `${TEST_ROOT}/structuredEventMaterializerV1.test.ts`, marker: "keeps an immutable base projection separate from a confirmed-resolution enrichment" },
      { path: `${TEST_ROOT}/structuredEventMaterializerV1.test.ts`, marker: "identifier-shaped source literal must remain in raw custody only" },
    ],
    runtimeArtifacts: ["records.jsonl", "mentions.jsonl", "semanticProjections.jsonl", "defaultProjectionMembership.jsonl"],
  },
  {
    requirementIds: ids("SRC", 6),
    schemaSymbols: ["SourceSelectorSchema", "SupportBindingSchema", "ResolutionAssertionSchema", "MetadataSelectorSchema"],
    productionSymbols: ["resolveAnchorsAtomically", "materializeSupportBindings", "materializeMetadataSelector"],
    automatedTestFiles: [`${TEST_ROOT}/structuredEventMaterializerV1.test.ts`],
    fixtureMarkers: [{ path: `${TEST_ROOT}/structuredEventMaterializerV1.test.ts`, marker: "quarantines an entire multi-span record when one required span fails" }],
    runtimeArtifacts: ["sourceSelectors.jsonl", "metadataSelectors.jsonl", "supportBindings.jsonl", "resolutionAssertions.jsonl"],
  },
  {
    requirementIds: ids("VAL", 6),
    schemaSymbols: ["MaterializationIssueSchema", "QuarantineSchema", "MapperPageOutputSchema", "MapperPagePatchOutputSchema", "ModelJsonValueSchema"],
    productionSymbols: [
      "resolveSourceAnchor",
      "materializeMapperPages",
      "dedupeCanonical",
      "callStructured",
      "assertOpenAiStructuredOutputSchemaCompatible",
      "decodeModelJsonValue",
    ],
    automatedTestFiles: [
      `${TEST_ROOT}/structuredEventMaterializerV1.test.ts`,
      `${TEST_ROOT}/structuredEventOrchestrationV1.test.ts`,
    ],
    fixtureMarkers: [
      { path: `${TEST_ROOT}/structuredEventMaterializerV1.test.ts`, marker: "marks truncated, missing, and duplicate continuation pages incomplete" },
      { path: `${TEST_ROOT}/structuredEventOrchestrationV1.test.ts`, marker: "preflights every ingestion model schema before any API dispatch" },
      { path: `${TEST_ROOT}/structuredEventOrchestrationV1.test.ts`, marker: "losslessly crosses the fixed-entry model JSON boundary" },
    ],
    runtimeArtifacts: ["quarantines.jsonl", "warnings.jsonl", "attemptResults.jsonl"],
  },
  {
    requirementIds: ids("ROLE", 5),
    schemaSymbols: [
      "StanceSchema",
      "AssistantBlockSchema",
      "AssistantBlockItemSchema",
      "AssistantBlockProjectionSchema",
      "RawLexicalPostingSchema",
    ],
    productionSymbols: ["materializeMapperPages", "itemRoutingTerms", "buildAssistantRawLexicalPostings"],
    automatedTestFiles: [`${TEST_ROOT}/structuredEventRoleRoutingV1.test.ts`],
    fixtureMarkers: [{ path: `${TEST_ROOT}/structuredEventRoleRoutingV1.test.ts`, marker: "keeps a long assistant list compact while indexing raw vocabulary separately" }],
    runtimeArtifacts: [
      "assistantBlocks.jsonl",
      "assistantBlockItems.jsonl",
      "assistantBlockProjections.jsonl",
      "rawLexicalPostings.jsonl",
      "coverageRows.jsonl",
    ],
  },
  {
    requirementIds: ids("LINK", 5),
    schemaSymbols: ["TypedLinkCoreSchema", "LinkEndpointSchema", "LinkProvenanceBasisSchema", "LinkGenerationMembershipSchema"],
    productionSymbols: ["linkCandidateBatches", "materializeLinkerOutputs", "linkGeneration", "appendCustodyTransition"],
    automatedTestFiles: [`${TEST_ROOT}/structuredEventLinkV1.test.ts`],
    fixtureMarkers: [{ path: `${TEST_ROOT}/structuredEventLinkV1.test.ts`, marker: "materializes links only inside the frozen endpoint/provenance scope" }],
    runtimeArtifacts: ["typed-links.jsonl", "link-generation.json", "link-freeze-manifest.json", "custody-ledger.jsonl"],
  },
  {
    requirementIds: ids("ID", 4),
    schemaSymbols: ["canonicalJson", "contentAddress", "DerivationOccurrenceSchema"],
    productionSymbols: ["prefixedId", "createDerivationOccurrence", "dedupeCanonical"],
    automatedTestFiles: [`${TEST_ROOT}/structuredEventIdentityV1.test.ts`],
    fixtureMarkers: [{ path: `${TEST_ROOT}/structuredEventIdentityV1.test.ts`, marker: "canonicalizes object keys and ASCII-sorts identifier arrays" }],
    runtimeArtifacts: ["derivations.jsonl", "link-derivations.jsonl"],
  },
  {
    requirementIds: ids("RES", 3),
    schemaSymbols: ["ResolutionAssertionSchema", "SemanticProjectionSchema"],
    productionSymbols: ["buildSemanticProjections", "defaultProjectionMembership", "materializeMapperPages"],
    automatedTestFiles: [`${TEST_ROOT}/structuredEventMaterializerV1.test.ts`],
    fixtureMarkers: [{ path: `${TEST_ROOT}/structuredEventMaterializerV1.test.ts`, marker: "keeps an immutable base projection separate from a confirmed-resolution enrichment" }],
    runtimeArtifacts: ["resolutionAssertions.jsonl", "semanticProjections.jsonl", "defaultProjectionMembership.jsonl"],
  },
  {
    requirementIds: ids("REP", 3),
    schemaSymbols: [
      "AttemptSchema",
      "AttemptMaterializationResultSchema",
      "AttemptSupersessionSchema",
      "QuarantineSchema",
      "LifecycleEventSchema",
    ],
    productionSymbols: [
      "createAttempt",
      "crossTypeProposalKeyCollisions",
      "quarantineRootKey",
      "createAttemptMaterializationResult",
      "createAttemptSupersession",
      "appendMissingAttemptResults",
      "targetedRepairPreservationErrors",
      "repairAffectedProposalRoots",
      "repairedQuarantineLineageErrors",
      "finalizeAttemptResultAfterPostchecks",
      "selectActiveAndHistoricalMaterializationArtifacts",
      "createLifecycleEvent",
      "validateLifecycleLineage",
      "repairPage",
      "applyMapperPagePatch",
    ],
    automatedTestFiles: [
      `${TEST_ROOT}/structuredEventLifecycleV1.test.ts`,
      `${TEST_ROOT}/structuredEventMaterializerV1.test.ts`,
      `${TEST_ROOT}/structuredEventOrchestrationV1.test.ts`,
    ],
    fixtureMarkers: [
      { path: `${TEST_ROOT}/structuredEventLifecycleV1.test.ts`, marker: "requires two judgments plus adjudication and a replacement for semantic invalidation" },
      { path: `${TEST_ROOT}/structuredEventLifecycleV1.test.ts`, marker: "binds both semantic judges and the adjudicator to the exact record projection state" },
      { path: `${TEST_ROOT}/structuredEventLifecycleV1.test.ts`, marker: "rejects re-acceptance after an invalidated terminal state" },
      { path: `${TEST_ROOT}/structuredEventOrchestrationV1.test.ts`, marker: "rejects cross-type proposal keys before quarantine repair can merge their roots" },
      { path: `${TEST_ROOT}/structuredEventMaterializerV1.test.ts`, marker: "cross-type proposal keys are ambiguous" },
      { path: `${TEST_ROOT}/structuredEventMaterializerV1.test.ts`, marker: "keeps an attempt result stable when an unrelated page-level completion error is repaired" },
      { path: `${TEST_ROOT}/structuredEventOrchestrationV1.test.ts`, marker: "allows a quarantined assistant block repair to restore an omitted item child" },
      { path: `${TEST_ROOT}/structuredEventOrchestrationV1.test.ts`, marker: "allows a cross-type collision repair to rename only content-identical objects" },
      { path: `${TEST_ROOT}/structuredEventOrchestrationV1.test.ts`, marker: "cannot erase a repaired quarantine into no-semantic-content" },
      { path: `${TEST_ROOT}/structuredEventOrchestrationV1.test.ts`, marker: "does not let a same-key block satisfy a quarantined record repair root" },
      { path: `${TEST_ROOT}/structuredEventOrchestrationV1.test.ts`, marker: "keeps only active semantic objects while retaining historical repair evidence" },
      { path: `${TEST_ROOT}/structuredEventOrchestrationV1.test.ts`, marker: "preserves materializer completion errors when finalizing repair postchecks" },
      { path: `${TEST_ROOT}/structuredEventOrchestrationV1.test.ts`, marker: "losslessly patches only approved roots and missing coverage rows" },
    ],
    runtimeArtifacts: [
      "attempts.jsonl",
      "attemptResults.jsonl",
      "attemptSupersessions.jsonl",
      "quarantines.jsonl",
      "lifecycleEvents.jsonl",
    ],
  },
  {
    requirementIds: ids("COV", 3),
    schemaSymbols: ["StructuralSegmentSchema", "CoverageRowSchema", "MapperPageOutputSchema"],
    productionSymbols: [
      "segmentRawTurn",
      "pageSessionSegments",
      "nextAdaptivePageSize",
      "runAdaptivePageRounds",
      "materializeMapperPages",
    ],
    automatedTestFiles: [
      `${TEST_ROOT}/structuredEventMaterializerV1.test.ts`,
      `${TEST_ROOT}/structuredEventOrchestrationV1.test.ts`,
    ],
    fixtureMarkers: [{ path: `${TEST_ROOT}/structuredEventMaterializerV1.test.ts`, marker: "uses host-controlled adaptive page reduction without output truncation as a budget tool" }],
    runtimeArtifacts: ["coverageRows.jsonl", "semantic-freeze-manifest.json"],
  },
  {
    requirementIds: ids("INC", 3),
    schemaSymbols: ["RawTurnSchema", "ResolutionAssertionSchema", "LifecycleEventSchema", "LinkGenerationMembershipSchema"],
    productionSymbols: ["assertAppendCompatible", "opaqueSessionHandle", "prepareConversation"],
    automatedTestFiles: [`${TEST_ROOT}/structuredEventIdentityV1.test.ts`],
    fixtureMarkers: [{ path: `${TEST_ROOT}/structuredEventIdentityV1.test.ts`, marker: "keeps earlier turn and selector IDs byte-identical after append" }],
    runtimeArtifacts: ["opaque-session-map.json", "raw-archive.json", "link-generation.json"],
  },
  {
    requirementIds: ids("EVAL", 9),
    schemaSymbols: [
      "TypedObligationSchema",
      "ExactGateSchema",
      "PrecisionPolicySchema",
      "DiscoveryEvidenceSchema",
      "PrecisionPopulationRowSchema",
      "SemanticFreezeManifestSchema",
      "LinkFreezeManifestSchema",
    ],
    productionSymbols: [
      "validateDiscoveryNegative",
      "summarizeTypedEvaluation",
      "stratifiedPrecisionSample",
      "oneSidedPrecisionLowerBound95",
      "semanticProjectionTokenMetrics",
      "enforceSupportedEntailments",
      "precisionGateDecision",
      "readFrozenSettledCost",
      "verifyFrozenArtifacts",
      "latestCustodyState",
    ],
    automatedTestFiles: [`${TEST_ROOT}/structuredEventEvaluationV1.test.ts`],
    fixtureMarkers: [
      { path: `${TEST_ROOT}/structuredEventEvaluationV1.test.ts`, marker: "does not count a negative unless the whole eligible plane was scanned" },
      { path: `${TEST_ROOT}/structuredEventEvaluationV1.test.ts`, marker: "downgrades a positive entailment when its covering object is not source-supported" },
      { path: `${TEST_ROOT}/structuredEventEvaluationV1.test.ts`, marker: "retains multiple confidence occurrences without choosing one optimistic value" },
      { path: `${TEST_ROOT}/structuredEventEvaluationV1.test.ts`, marker: "can produce an exact bounded-cohort precision census" },
      { path: `${TEST_ROOT}/structuredEventEvaluationV1.test.ts`, marker: "blocks non-census development precision and unsupported certification population claims" },
      { path: `${TEST_ROOT}/structuredEventEvaluationV1.test.ts`, marker: "freezes precision policy without guessing the model-created population size" },
      { path: `${TEST_ROOT}/structuredEventEvaluationV1.test.ts`, marker: "requires exact gates for every criticality and stratum cell" },
      { path: `${TEST_ROOT}/structuredEventEvaluationV1.test.ts`, marker: "accounts for serialized lexical postings, compact targets, and active raw-only routes" },
      { path: `${TEST_ROOT}/structuredEventEvaluationV1.test.ts`, marker: "initializes evaluation spend only from the frozen settled semantic-plus-link cost artifact" },
    ],
    runtimeArtifacts: [
      "semantic-freeze-manifest.json",
      "link-freeze-manifest.json",
      "semantic-projection-token-metrics.json",
      "post-link-ingestion-accounting.json",
      "semantic-plus-link-cost.json",
      "typed-evaluation-result.json",
      "precision-sample.json",
    ],
  },
  {
    requirementIds: ids("GOV", 6),
    schemaSymbols: ["SignedApprovalReceiptSchema", "ApprovalExecutionBindingSchema", "ApprovalLedgerRowSchema"],
    productionSymbols: [
      "verifyAndConsumeApproval",
      "verifyRunningApproval",
      "appendApprovalTransition",
      "verifyAcceptedResultChain",
      "verifyAcceptedPrerequisite",
      "verifyCanonicalAcceptedPrerequisite",
      "CostBudget",
    ],
    automatedTestFiles: [`${TEST_ROOT}/structuredEventApprovalV1.test.ts`],
    fixtureMarkers: [
      { path: `${TEST_ROOT}/structuredEventApprovalV1.test.ts`, marker: "consumes a valid nonce once and permits only the same running receipt" },
      { path: `${TEST_ROOT}/structuredEventApprovalV1.test.ts`, marker: "cannot accept a different result hash than the result that passed" },
      { path: `${TEST_ROOT}/structuredEventApprovalV1.test.ts`, marker: "authenticates the receipt and canonical ledger before accepting an L0 prerequisite" },
    ],
    runtimeArtifacts: ["approval-receipt.json", "execution-binding.json", "approval-ledger.jsonl", "typed-evaluation-result.json"],
  },
];

/** Independent catalog: removing a traceability group cannot silently shrink the L0 denominator. */
export const STRUCTURED_EVENT_REQUIREMENT_IDS_V1 = [
  ...ids("RAW", 3),
  ...ids("SEM", 9),
  ...ids("SRC", 6),
  ...ids("VAL", 6),
  ...ids("ROLE", 5),
  ...ids("LINK", 5),
  ...ids("ID", 4),
  ...ids("RES", 3),
  ...ids("REP", 3),
  ...ids("COV", 3),
  ...ids("INC", 3),
  ...ids("EVAL", 9),
  ...ids("GOV", 6),
];
