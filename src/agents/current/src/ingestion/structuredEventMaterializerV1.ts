import { createHash } from "node:crypto";

import { z } from "zod";

import {
  ASSISTANT_ROUTER_VERSION,
  AssistantBlockItemSchema,
  AssistantBlockProjectionSchema,
  AssistantBlockSchema,
  AttemptMaterializationResultSchema,
  AttemptSchema,
  AttemptSupersessionSchema,
  BASE_RENDERER_VERSION,
  CoverageRowSchema,
  DefaultProjectionMembershipSchema,
  DerivationOccurrenceSchema,
  DraftAssistantBlockSchema,
  DraftCoverageRowSchema,
  DraftResolutionAssertionSchema,
  DraftSemanticRecordSchema,
  DraftSourceAnchorSchema,
  JsonValueSchema,
  LifecycleEventSchema,
  LinkGenerationMembershipSchema,
  MapperPageOutputSchema,
  MentionSchema,
  MetadataSelectorSchema,
  QuarantineSchema,
  RawLexicalPostingSchema,
  RawTurnInputSchema,
  RawTurnSchema,
  ResolutionAssertionSchema,
  SemanticProjectionSchema,
  SemanticRecordCoreSchema,
  SemanticRecordSchema,
  SourceSelectorSchema,
  StructuralSegmentSchema,
  SupportBindingSchema,
  TypedLinkCoreSchema,
  TypedLinkSchema,
  asciiIdSort,
  assertUnicodeScalarString,
  canonicalJson,
  contentAddress,
  decodeModelJsonValue,
  type AssistantBlock,
  type AssistantBlockItem,
  type AssistantBlockProjection,
  type Attempt,
  type AttemptMaterializationResult,
  type AttemptSupersession,
  type CoverageRow,
  type DefaultProjectionMembership,
  type DerivationOccurrence,
  type DraftAssistantBlock,
  type DraftMetadataEvidence,
  type DraftSourceAnchor,
  type DraftSupportBinding,
  type JsonValue,
  type LinkGenerationMembership,
  type LifecycleEvent,
  type MapperPageOutput,
  type MaterializationIssue,
  type Mention,
  type MetadataSelector,
  type Quarantine,
  type RawLexicalPosting,
  type RawTurn,
  type RawTurnInput,
  type ResolutionAssertion,
  type SemanticProjection,
  type SemanticRecord,
  type SourceSelector,
  type StructuralSegment,
  type SupportBinding,
  type TypedLink,
} from "./structuredEventSchemaV1.js";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonValue(value: unknown): JsonValue {
  return JsonValueSchema.parse(value);
}

const INTERNAL_ID_PATTERN = /\b(?:rawturn|selector|metadata|segment|mention|record|support|resolution|projection|block|item|attempt|derivation|quarantine|lifecycle|link)_[a-f0-9]{64}\b|\bmemory_[0-9]{6,18}\b/;

function containsInternalIdentifier(value: JsonValue | string): boolean {
  return INTERNAL_ID_PATTERN.test(typeof value === "string" ? value : canonicalJson(value));
}

function prefixedId(prefix: string, domain: string, payload: JsonValue): string {
  return `${prefix}_${contentAddress(domain, payload)}`;
}

export function materializeRawTurn(inputValue: RawTurnInput): RawTurn {
  const input = RawTurnInputSchema.parse(inputValue);
  assertUnicodeScalarString(input.content);
  const bytes = Buffer.from(input.content, "utf8");
  const contentSha256 = sha256(bytes);
  const identity = {
    archiveId: input.archiveId,
    hostConversationId: input.hostConversationId,
    hostSessionId: input.hostSessionId,
    hostTurnId: input.hostTurnId,
    role: input.role,
    rawTimestamp: input.rawTimestamp,
    sessionOrdinal: input.sessionOrdinal,
    turnOrdinal: input.turnOrdinal,
    contentSha256,
  } satisfies JsonValue;
  return RawTurnSchema.parse({
    schemaVersion: 2,
    rawTurnId: prefixedId("rawturn", "beam.raw_turn.v1", identity),
    ...input,
    contentByteLength: bytes.length,
    contentSha256,
  });
}

function byteOffsetForChar(content: string, charOffset: number): number {
  return Buffer.byteLength(content.slice(0, charOffset), "utf8");
}

function segmentKind(text: string): StructuralSegment["segmentKind"] {
  if (text.trim().length === 0) return "blank";
  return /^\s*(?:[-*+]\s+|\d+[.)]\s+)/u.test(text) ? "list_item" : "prose";
}

const MAX_STRUCTURAL_SEGMENT_BYTES = 8_000;

function safeChunkEnd(content: string, charStart: number, maximumBytes: number): number {
  let charEnd = charStart;
  let bytes = 0;
  while (charEnd < content.length) {
    const codePoint = content.codePointAt(charEnd);
    if (codePoint === undefined) break;
    const width = codePoint > 0xffff ? 2 : 1;
    const encoded = Buffer.byteLength(String.fromCodePoint(codePoint), "utf8");
    if (bytes + encoded > maximumBytes && charEnd > charStart) break;
    bytes += encoded;
    charEnd += width;
  }
  return charEnd;
}

/** Produces a stable, non-overlapping line/chunk structural partition. */
export function segmentRawTurn(
  turnValue: RawTurn,
  maximumBytes = MAX_STRUCTURAL_SEGMENT_BYTES,
): StructuralSegment[] {
  const turn = RawTurnSchema.parse(turnValue);
  if (!Number.isInteger(maximumBytes) || maximumBytes < 256 || maximumBytes > MAX_STRUCTURAL_SEGMENT_BYTES) {
    throw new Error(`structural segment byte ceiling must be in [256, ${String(MAX_STRUCTURAL_SEGMENT_BYTES)}]`);
  }
  if (turn.content.length === 0) {
    const payload = {
      rawTurnId: turn.rawTurnId,
      byteStart: 0,
      byteEnd: 0,
      spanSha256: sha256(Buffer.alloc(0)),
      segmentKind: "blank",
      ordinal: 0,
    } satisfies JsonValue;
    return [StructuralSegmentSchema.parse({
      schemaVersion: 2,
      segmentId: prefixedId("segment", "beam.structural_segment.v1", payload),
      ...payload,
    })];
  }
  const segments: StructuralSegment[] = [];
  let charStart = 0;
  let ordinal = 0;
  while (charStart < turn.content.length) {
    const newline = turn.content.indexOf("\n", charStart);
    const lineEnd = newline < 0 ? turn.content.length : newline + 1;
    while (charStart < lineEnd) {
      const charEnd = Math.min(lineEnd, safeChunkEnd(turn.content, charStart, maximumBytes));
      if (charEnd <= charStart) throw new Error("structural segmentation made no progress");
      const text = turn.content.slice(charStart, charEnd);
      const byteStart = byteOffsetForChar(turn.content, charStart);
      const byteEnd = byteOffsetForChar(turn.content, charEnd);
      const bytes = Buffer.from(text, "utf8");
      const payload = {
        rawTurnId: turn.rawTurnId,
        byteStart,
        byteEnd,
        spanSha256: sha256(bytes),
        segmentKind: segmentKind(text),
        ordinal,
      } satisfies JsonValue;
      segments.push(StructuralSegmentSchema.parse({
        schemaVersion: 2,
        segmentId: prefixedId("segment", "beam.structural_segment.v1", payload),
        ...payload,
      }));
      charStart = charEnd;
      ordinal += 1;
    }
  }
  return segments;
}

function isUtf8Boundary(bytes: Buffer, offset: number): boolean {
  return offset === 0 || offset === bytes.length || (bytes[offset] ?? 0) >>> 6 !== 0b10;
}

function overlappingOffsets(haystack: Buffer, needle: Buffer): number[] {
  const offsets: number[] = [];
  for (let cursor = 0; cursor <= haystack.length - needle.length;) {
    const found = haystack.indexOf(needle, cursor);
    if (found < 0) break;
    offsets.push(found);
    cursor = found + 1;
  }
  return offsets;
}

function adjacentContextMatches(
  content: Buffer,
  byteStart: number,
  byteEnd: number,
  prefix: Buffer,
  suffix: Buffer,
): boolean {
  const prefixMatches = prefix.length === 0 || (
    byteStart >= prefix.length
    && content.subarray(byteStart - prefix.length, byteStart).equals(prefix)
  );
  const suffixMatches = suffix.length === 0 || (
    byteEnd + suffix.length <= content.length
    && content.subarray(byteEnd, byteEnd + suffix.length).equals(suffix)
  );
  return prefixMatches && suffixMatches;
}

export type SelectorResolution = {
  selector: SourceSelector | null;
  warnings: MaterializationIssue[];
  issues: MaterializationIssue[];
  candidateByteOffsets: number[];
};

function issue(
  code: MaterializationIssue["code"],
  detail: string,
  candidateByteOffsets: number[] = [],
): MaterializationIssue {
  return { code, detail, candidateByteOffsets };
}

export function resolveSourceAnchor(
  anchorValue: DraftSourceAnchor,
  rawTurns: ReadonlyMap<string, RawTurn>,
  allowedRanges?: readonly Pick<StructuralSegment, "rawTurnId" | "byteStart" | "byteEnd">[],
  nearestPrecedingFocus?: Pick<SourceSelector, "rawTurnId" | "byteStart">,
): SelectorResolution {
  const anchor = DraftSourceAnchorSchema.parse(anchorValue);
  const turn = rawTurns.get(anchor.rawTurnId);
  if (!turn) {
    const recovered = allowedRanges === undefined ? [] : [...new Set(allowedRanges.map((range) => range.rawTurnId))]
      .flatMap((rawTurnId) => {
        const candidate = resolveSourceAnchor(
          { ...anchor, rawTurnId },
          rawTurns,
          allowedRanges.filter((range) => range.rawTurnId === rawTurnId),
          nearestPrecedingFocus,
        );
        return candidate.selector ? [candidate] : [];
      });
    if (recovered.length === 1 && recovered[0]) {
      return {
        ...recovered[0],
        warnings: [
          ...recovered[0].warnings,
          issue(
            "optional_context_mismatch",
            "unknown declared turn was replaced by the only exact source occurrence inside the immutable routed segment",
          ),
        ],
      };
    }
    return {
      selector: null,
      warnings: [],
      issues: [issue("unknown_turn", `unknown raw turn ${anchor.rawTurnId}`)],
      candidateByteOffsets: [],
    };
  }
  for (const value of [anchor.exactUtf8, anchor.prefixUtf8, anchor.suffixUtf8]) {
    try {
      assertUnicodeScalarString(value);
    } catch (error) {
      return {
        selector: null,
        warnings: [],
        issues: [issue("invalid_utf8_boundary", error instanceof Error ? error.message : String(error))],
        candidateByteOffsets: [],
      };
    }
  }
  const content = Buffer.from(turn.content, "utf8");
  const exact = Buffer.from(anchor.exactUtf8, "utf8");
  const prefix = Buffer.from(anchor.prefixUtf8, "utf8");
  const suffix = Buffer.from(anchor.suffixUtf8, "utf8");
  const offsets = overlappingOffsets(content, exact).filter((offset) =>
    isUtf8Boundary(content, offset)
    && isUtf8Boundary(content, offset + exact.length)
    && (allowedRanges === undefined || allowedRanges.some((range) =>
      range.rawTurnId === turn.rawTurnId
      && offset >= range.byteStart
      && offset + exact.length <= range.byteEnd)),
  );
  if (offsets.length === 0) {
    return {
      selector: null,
      warnings: [],
      issues: [issue("quote_not_found", "exact UTF-8 quote is absent from the declared turn")],
      candidateByteOffsets: [],
    };
  }
  let selected: number | undefined;
  const warnings: MaterializationIssue[] = [];
  if (offsets.length === 1) {
    selected = offsets[0];
    if (selected !== undefined && !adjacentContextMatches(
      content,
      selected,
      selected + exact.length,
      prefix,
      suffix,
    )) {
      warnings.push(issue(
        "optional_context_mismatch",
        "unique exact quote accepted; optional adjacent context did not match",
        offsets,
      ));
    }
  } else {
    const survivors = offsets.filter((offset) => adjacentContextMatches(
      content,
      offset,
      offset + exact.length,
      prefix,
      suffix,
    ));
    if (survivors.length === 1) {
      selected = survivors[0];
    } else {
      const prefixSurvivors = prefix.length === 0 ? [] : offsets.filter((offset) =>
        adjacentContextMatches(content, offset, offset + exact.length, prefix, Buffer.alloc(0)));
      const suffixSurvivors = suffix.length === 0 ? [] : offsets.filter((offset) =>
        adjacentContextMatches(content, offset, offset + exact.length, Buffer.alloc(0), suffix));
      const oneSidedUnique = new Set([
        ...(prefixSurvivors.length === 1 ? prefixSurvivors : []),
        ...(suffixSurvivors.length === 1 ? suffixSurvivors : []),
      ]);
      if (oneSidedUnique.size === 1) {
        selected = [...oneSidedUnique][0];
        warnings.push(issue(
          "optional_context_mismatch",
          "repeated exact quote identified by one exact adjacent side; the other optional side did not match",
          offsets,
        ));
      } else {
        const proximityCandidates = nearestPrecedingFocus?.rawTurnId === turn.rawTurnId
          ? (survivors.length > 0 ? survivors : offsets).filter((offset) =>
            offset + exact.length <= nearestPrecedingFocus.byteStart)
          : [];
        const nearest = proximityCandidates.length === 0 ? undefined : Math.max(...proximityCandidates);
        if (nearest !== undefined) {
          selected = nearest;
          warnings.push(issue(
            "optional_context_mismatch",
            "repeated scope anchor was bound to the nearest exact occurrence preceding its immutable child source",
            offsets,
          ));
        } else {
          return {
            selector: null,
            warnings: [],
            issues: [issue(
              "unresolved_ambiguity",
              `exact quote has ${String(offsets.length)} occurrences and ${String(survivors.length)} exact-context survivors`,
              offsets,
            )],
            candidateByteOffsets: offsets,
          };
        }
      }
    }
  }
  if (selected === undefined) throw new Error("selector resolution lost its unique offset");
  const byteEnd = selected + exact.length;
  const spanSha256 = sha256(content.subarray(selected, byteEnd));
  const payload = {
    rawTurnId: turn.rawTurnId,
    contentSha256: turn.contentSha256,
    byteStart: selected,
    byteEnd,
    spanSha256,
  } satisfies JsonValue;
  const selector = SourceSelectorSchema.parse({
    schemaVersion: 2,
    selectorId: prefixedId("selector", "beam.source_selector.v1", payload),
    ...payload,
    exactUtf8: content.subarray(selected, byteEnd).toString("utf8"),
  });
  return { selector, warnings, issues: [], candidateByteOffsets: offsets };
}

function resolveSegmentRange(
  segmentIds: readonly string[],
  structuralSegments: ReadonlyMap<string, StructuralSegment>,
  rawTurns: ReadonlyMap<string, RawTurn>,
): SelectorResolution {
  const selectedSegments = segmentIds.flatMap((id) => structuralSegments.get(id) ?? []);
  if (selectedSegments.length !== segmentIds.length || new Set(segmentIds).size !== segmentIds.length) {
    return { selector: null, warnings: [], issues: [issue("invalid_coverage", "block segment range contains unknown or duplicate segments")], candidateByteOffsets: [] };
  }
  const ordered = [...selectedSegments].sort((left, right) => left.ordinal - right.ordinal);
  const rawTurnId = ordered[0]?.rawTurnId;
  if (!rawTurnId || ordered.some((segment) => segment.rawTurnId !== rawTurnId)) {
    return { selector: null, warnings: [], issues: [issue("schema_invalid", "block segment range must stay inside one raw turn")], candidateByteOffsets: [] };
  }
  for (let index = 1; index < ordered.length; index += 1) {
    const prior = ordered[index - 1];
    const current = ordered[index];
    if (!prior || !current || prior.byteEnd !== current.byteStart || prior.ordinal + 1 !== current.ordinal) {
      return { selector: null, warnings: [], issues: [issue("schema_invalid", "block segment range must be contiguous")], candidateByteOffsets: [] };
    }
  }
  const turn = rawTurns.get(rawTurnId);
  const first = ordered[0];
  const last = ordered.at(-1);
  if (!turn || !first || !last || last.byteEnd <= first.byteStart) {
    return { selector: null, warnings: [], issues: [issue("schema_invalid", "block segment range is empty or lost its raw turn")], candidateByteOffsets: [] };
  }
  const content = Buffer.from(turn.content, "utf8");
  if (!isUtf8Boundary(content, first.byteStart) || !isUtf8Boundary(content, last.byteEnd)) {
    return { selector: null, warnings: [], issues: [issue("invalid_utf8_boundary", "block segment range splits a UTF-8 scalar")], candidateByteOffsets: [] };
  }
  const bytes = content.subarray(first.byteStart, last.byteEnd);
  const spanSha256 = sha256(bytes);
  const payload = {
    rawTurnId,
    contentSha256: turn.contentSha256,
    byteStart: first.byteStart,
    byteEnd: last.byteEnd,
    spanSha256,
  } satisfies JsonValue;
  const selector = SourceSelectorSchema.parse({
    schemaVersion: 2,
    selectorId: prefixedId("selector", "beam.source_selector.v1", payload),
    ...payload,
    exactUtf8: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  });
  return { selector, warnings: [], issues: [], candidateByteOffsets: [first.byteStart] };
}

function metadataValue(turn: RawTurn, field: DraftMetadataEvidence["field"]): JsonValue {
  switch (field) {
    case "archive_id": return turn.archiveId;
    case "host_conversation_id": return turn.hostConversationId;
    case "host_session_id": return turn.hostSessionId;
    case "host_turn_id": return turn.hostTurnId;
    case "role": return turn.role;
    case "raw_timestamp": return turn.rawTimestamp;
    case "session_ordinal": return turn.sessionOrdinal;
    case "turn_ordinal": return turn.turnOrdinal;
  }
}

export function materializeMetadataSelector(
  draft: DraftMetadataEvidence,
  rawTurns: ReadonlyMap<string, RawTurn>,
): MetadataSelector | null {
  const turn = rawTurns.get(draft.rawTurnId);
  if (!turn) return null;
  const value = metadataValue(turn, draft.field);
  const payload = { rawTurnId: turn.rawTurnId, field: draft.field, value } satisfies JsonValue;
  return MetadataSelectorSchema.parse({
    schemaVersion: 2,
    metadataSelectorId: prefixedId("metadata", "beam.metadata_selector.v1", payload),
    ...payload,
  });
}

function quarantine(args: {
  attemptId: string;
  objectType: Quarantine["objectType"];
  localObjectKey: string;
  draft: unknown;
  resolvedSelectorIds?: string[];
  issues: MaterializationIssue[];
  parentQuarantineIds?: string[];
}): Quarantine {
  const payload = {
    attemptId: args.attemptId,
    objectType: args.objectType,
    localObjectKey: args.localObjectKey,
    draft: jsonValue(args.draft),
    resolvedSelectorIds: asciiIdSort(args.resolvedSelectorIds ?? []),
    issues: jsonValue(args.issues),
    parentQuarantineIds: asciiIdSort(args.parentQuarantineIds ?? []),
  } satisfies JsonValue;
  return QuarantineSchema.parse({
    schemaVersion: 2,
    quarantineId: prefixedId("quarantine", "beam.quarantine.v1", payload),
    ...payload,
  });
}

function resolveAnchorsAtomically(
  anchors: readonly DraftSourceAnchor[],
  rawTurns: ReadonlyMap<string, RawTurn>,
  preferredRanges?: readonly Pick<StructuralSegment, "rawTurnId" | "byteStart" | "byteEnd">[],
  fallbackRanges?: readonly Pick<StructuralSegment, "rawTurnId" | "byteStart" | "byteEnd">[],
): { selectors: SourceSelector[]; warnings: MaterializationIssue[]; issues: MaterializationIssue[] } {
  const selectors: SourceSelector[] = [];
  const warnings: MaterializationIssue[] = [];
  const issues: MaterializationIssue[] = [];
  for (const anchor of anchors) {
    let resolved = resolveSourceAnchor(anchor, rawTurns, preferredRanges);
    if (
      !resolved.selector
      && preferredRanges !== undefined
      && fallbackRanges !== undefined
      && resolved.issues.every((entry) => entry.code === "quote_not_found")
    ) resolved = resolveSourceAnchor(anchor, rawTurns, fallbackRanges);
    if (resolved.selector) selectors.push(resolved.selector);
    warnings.push(...resolved.warnings);
    issues.push(...resolved.issues);
  }
  return {
    selectors: [...new Map(selectors.map((selector) => [selector.selectorId, selector])).values()],
    warnings,
    issues,
  };
}

function semanticPaths(draft: z.infer<typeof DraftSemanticRecordSchema>): string[] {
  const paths = [
    "/recordKind",
    "/discourseContext/frame",
    "/discourseContext/commitment",
    "/predicate/surface",
    "/stance/sourceSpeakerRole",
    "/stance/speechAct",
    "/stance/polarity",
    "/stance/modalForce",
    "/stance/eventStatus",
    "/stance/adoption",
    "/stance/speakerCertainty",
  ];
  if (draft.discourseContext.parentScopeAnchor !== null) paths.push("/discourseContext/parentScopeSelectorId");
  if (draft.predicate.normalized !== null) paths.push("/predicate/normalized");
  if (draft.stance.sourceSpeakerSurface !== null) paths.push("/stance/sourceSpeakerSurface");
  if (draft.stance.reportedSpeakerMentionKey !== null) paths.push("/stance/reportedSpeakerMentionId");
  draft.arguments.forEach((argument) => {
    const base = `/arguments/${argument.argumentKey}`;
    paths.push(`${base}/role`, `${base}/valueType`, `${base}/surface`);
    if (argument.customRole !== null) paths.push(`${base}/customRole`);
    if (argument.groupKey !== null) paths.push(`${base}/groupId`);
    if (argument.sourceTypedValue !== null) paths.push(`${base}/sourceTypedValue`);
    if (argument.mentionKey !== null) paths.push(`${base}/mentionId`);
    if (argument.recordRefLocalKey !== null) paths.push(`${base}/recordId`);
  });
  draft.validTimes.forEach((time, index) => {
    const base = `/temporal/validTimes/${String(index)}`;
    paths.push(
      `${base}/temporalType`,
      `${base}/sourcePrecision`,
      `${base}/sourceCertainty`,
      `${base}/resolutionBasis`,
    );
    if (time.raw !== null) paths.push(`${base}/raw`);
    if (time.normalizedStart !== null) paths.push(`${base}/normalizedStart`);
    if (time.normalizedEnd !== null) paths.push(`${base}/normalizedEnd`);
    if (time.normalizedDuration !== null) paths.push(`${base}/normalizedDuration`);
    if (time.recurrence !== null) paths.push(`${base}/recurrence`);
  });
  return paths;
}

function materializeSupportBindings(args: {
  draftBindings: readonly DraftSupportBinding[];
  targetObjectType: "record" | "block";
  targetObjectId: string;
  requiredPaths: readonly string[];
  mentionIds: ReadonlyMap<string, string>;
  mentionFieldPaths?: ReadonlyMap<string, readonly string[]>;
  rawTurns: ReadonlyMap<string, RawTurn>;
  allowedEvidenceRawTurnIds: ReadonlySet<string>;
  preferredEvidenceRanges?: readonly Pick<StructuralSegment, "rawTurnId" | "byteStart" | "byteEnd">[];
  fallbackEvidenceRanges?: readonly Pick<StructuralSegment, "rawTurnId" | "byteStart" | "byteEnd">[];
  fallbackClaimSelectors?: readonly SourceSelector[];
}): {
  bindings: SupportBinding[];
  selectors: SourceSelector[];
  metadataSelectors: MetadataSelector[];
  warnings: MaterializationIssue[];
  issues: MaterializationIssue[];
} {
  const bindings: SupportBinding[] = [];
  const selectors: SourceSelector[] = [];
  const metadataSelectors: MetadataSelector[] = [];
  const warnings: MaterializationIssue[] = [];
  const issues: MaterializationIssue[] = [];
  const coveredPaths = new Set<string>();
  const allowedFieldPaths = new Set(args.requiredPaths);
  for (const draft of args.draftBindings) {
    if (draft.evidenceAnchors.length + draft.metadataEvidence.length === 0) {
      issues.push(issue("support_binding_failed", "support binding has no source or metadata evidence"));
      continue;
    }
    if (draft.targetKind === "field" && !draft.targetPathOrMentionKey.startsWith("/")) {
      issues.push(issue("support_binding_failed", "field support target is not an absolute field path"));
      continue;
    }
    if (
      draft.targetKind === "mention"
      && !/^[a-z][a-z0-9_]{0,127}$/.test(draft.targetPathOrMentionKey)
    ) {
      issues.push(issue("support_binding_failed", "mention support target is not a valid local mention key"));
      continue;
    }
    if (draft.evidenceAnchors.some((anchor) =>
      args.rawTurns.has(anchor.rawTurnId) && !args.allowedEvidenceRawTurnIds.has(anchor.rawTurnId))) {
      issues.push(issue(
        "support_binding_failed",
        "immutable semantic-core support must come from the target session; cross-session context belongs in a resolution assertion",
      ));
      continue;
    }
    let resolved = resolveAnchorsAtomically(
      draft.evidenceAnchors,
      args.rawTurns,
      args.preferredEvidenceRanges,
      args.fallbackEvidenceRanges,
    );
    let bindingMethod = draft.method;
    if (resolved.issues.length > 0 && (args.fallbackClaimSelectors?.length ?? 0) > 0) {
      const fallbackSelectors = args.fallbackClaimSelectors?.filter((selector) =>
        args.allowedEvidenceRawTurnIds.has(selector.rawTurnId)) ?? [];
      if (fallbackSelectors.length > 0) {
        warnings.push(...resolved.issues.map((entry) => issue(
          "support_binding_failed",
          `malformed field span replaced by validated immutable claim provenance: ${entry.detail}`,
          entry.candidateByteOffsets,
        )));
        resolved = { selectors: fallbackSelectors, warnings: resolved.warnings, issues: [], candidateByteOffsets: [] };
        bindingMethod = `host-claim-fallback-v1:${draft.method}`;
      }
    }
    warnings.push(...resolved.warnings);
    selectors.push(...resolved.selectors);
    if (resolved.issues.length > 0) {
      issues.push(...resolved.issues.map((entry) => issue(
        "support_binding_failed",
        entry.detail,
        entry.candidateByteOffsets,
      )));
      continue;
    }
    if (resolved.selectors.some((selector) => !args.allowedEvidenceRawTurnIds.has(selector.rawTurnId))) {
      issues.push(issue(
        "support_binding_failed",
        "immutable semantic-core support must come from the target session; cross-session context belongs in a resolution assertion",
      ));
      continue;
    }
    const metadata = draft.metadataEvidence.map((entry) => materializeMetadataSelector(entry, args.rawTurns));
    if (metadata.some((entry) => entry === null)) {
      issues.push(issue("support_binding_failed", "support binding references unknown metadata turn"));
      continue;
    }
    if (draft.metadataEvidence.some((entry) => !args.allowedEvidenceRawTurnIds.has(entry.rawTurnId))) {
      issues.push(issue(
        "support_binding_failed",
        "cross-session metadata cannot support an immutable semantic-core field; use a resolution assertion",
      ));
      continue;
    }
    if (draft.targetKind === "field" && !allowedFieldPaths.has(draft.targetPathOrMentionKey)) {
      issues.push(issue("support_binding_failed", `support binding targets a nonexistent core field ${draft.targetPathOrMentionKey}`));
      continue;
    }
    const target = draft.targetKind === "mention"
      ? args.mentionIds.get(draft.targetPathOrMentionKey)
      : draft.targetPathOrMentionKey;
    if (!target) {
      issues.push(issue("unknown_mention", `unknown support target ${draft.targetPathOrMentionKey}`));
      continue;
    }
    const selectorIds = asciiIdSort(resolved.selectors.map((entry) => entry.selectorId));
    const metadataIds = asciiIdSort(metadata.flatMap((entry) => entry ? [entry.metadataSelectorId] : []));
    const payload = {
      targetObjectType: args.targetObjectType,
      targetObjectId: args.targetObjectId,
      targetFieldPathOrMentionId: target,
      purpose: draft.purpose,
      method: bindingMethod,
      selectorIds,
      metadataSelectorIds: metadataIds,
      confidence: draft.confidence,
    } satisfies JsonValue;
    const binding = SupportBindingSchema.parse({
      schemaVersion: 2,
      supportBindingId: prefixedId("support", "beam.support_binding.v1", payload),
      ...payload,
    });
    bindings.push(binding);
    metadataSelectors.push(...metadata.flatMap((entry) => entry ? [entry] : []));
    if (draft.targetKind === "field") {
      coveredPaths.add(draft.targetPathOrMentionKey);
    } else {
      // The model chose the mention relationship and supplied its evidence.
      // The host only propagates that same evidence onto the deterministic
      // mentionId field generated from that relationship; it does not infer a
      // new semantic link.
      for (const fieldPath of args.mentionFieldPaths?.get(draft.targetPathOrMentionKey) ?? []) {
        const fieldPayload = {
          targetObjectType: args.targetObjectType,
          targetObjectId: args.targetObjectId,
          targetFieldPathOrMentionId: fieldPath,
          purpose: draft.purpose,
          method: "host-bound-mention-link-v1",
          selectorIds,
          metadataSelectorIds: metadataIds,
          confidence: draft.confidence,
        } satisfies JsonValue;
        bindings.push(SupportBindingSchema.parse({
          schemaVersion: 2,
          supportBindingId: prefixedId("support", "beam.support_binding.v1", fieldPayload),
          ...fieldPayload,
        }));
        coveredPaths.add(fieldPath);
      }
    }
  }
  for (const path of args.requiredPaths) {
    if (coveredPaths.has(path) || !path.endsWith("/mentionId")) continue;
    const surfacePath = `${path.slice(0, -"mentionId".length)}surface`;
    const surfaceBinding = bindings.find((binding) => binding.targetFieldPathOrMentionId === surfacePath);
    if (!surfaceBinding) continue;
    const payload = {
      targetObjectType: args.targetObjectType,
      targetObjectId: args.targetObjectId,
      targetFieldPathOrMentionId: path,
      purpose: "argument_role" as const,
      method: "host-bound-mention-link-v1",
      selectorIds: surfaceBinding.selectorIds,
      metadataSelectorIds: surfaceBinding.metadataSelectorIds,
      confidence: surfaceBinding.confidence,
    } satisfies JsonValue;
    bindings.push(SupportBindingSchema.parse({
      schemaVersion: 2,
      supportBindingId: prefixedId("support", "beam.support_binding.v1", payload),
      ...payload,
    }));
    coveredPaths.add(path);
  }
  // A claim selector is already a model-chosen, byte-exact provenance span for
  // the complete record. If the model omits redundant per-field bindings, use
  // that validated span as provenance instead of discarding the record. This
  // only assembles lineage; it does not invent or alter any semantic value.
  const claimSelectors = args.fallbackClaimSelectors?.filter((selector) =>
    args.allowedEvidenceRawTurnIds.has(selector.rawTurnId)) ?? [];
  if (claimSelectors.length > 0) {
    const selectorIds = asciiIdSort(claimSelectors.map((selector) => selector.selectorId));
    selectors.push(...claimSelectors);
    for (const path of args.requiredPaths) {
      if (coveredPaths.has(path)) continue;
      const purpose = path.includes("/arguments/") && path.endsWith("/role")
        ? "argument_role" as const
        : path.startsWith("/temporal/")
          ? "temporal_type" as const
          : "semantic_classification" as const;
      const payload = {
        targetObjectType: args.targetObjectType,
        targetObjectId: args.targetObjectId,
        targetFieldPathOrMentionId: path,
        purpose,
        method: "host-claim-provenance-v1",
        selectorIds,
        metadataSelectorIds: [],
        confidence: "high" as const,
      } satisfies JsonValue;
      bindings.push(SupportBindingSchema.parse({
        schemaVersion: 2,
        supportBindingId: prefixedId("support", "beam.support_binding.v1", payload),
        ...payload,
      }));
      coveredPaths.add(path);
      warnings.push(issue(
        "support_binding_failed",
        `missing field-level binding for ${path} replaced by validated claim provenance`,
      ));
    }
  }
  for (const path of args.requiredPaths) {
    if (!coveredPaths.has(path)) issues.push(issue("missing_support_binding", `missing binding for ${path}`));
  }
  return { bindings, selectors, metadataSelectors, warnings, issues };
}

function hostTemporalBindings(
  recordId: string,
  claimTurn: RawTurn,
): { bindings: SupportBinding[]; metadataSelectors: MetadataSelector[] } {
  const entries: Array<{ path: string; field: DraftMetadataEvidence["field"] }> = [
    { path: "/temporal/assertionTime", field: "raw_timestamp" },
    { path: "/temporal/sessionOrdinal", field: "session_ordinal" },
    { path: "/temporal/turnOrdinal", field: "turn_ordinal" },
  ];
  const bindings: SupportBinding[] = [];
  const metadataSelectors: MetadataSelector[] = [];
  for (const entry of entries) {
    const selector = materializeMetadataSelector({ rawTurnId: claimTurn.rawTurnId, field: entry.field }, new Map([
      [claimTurn.rawTurnId, claimTurn],
    ]));
    if (!selector) throw new Error("host metadata selector unexpectedly failed");
    metadataSelectors.push(selector);
    const payload = {
      targetObjectType: "record",
      targetObjectId: recordId,
      targetFieldPathOrMentionId: entry.path,
      purpose: "host_metadata",
      method: "host-metadata-v1",
      selectorIds: [],
      metadataSelectorIds: [selector.metadataSelectorId],
      confidence: "high",
    } satisfies JsonValue;
    bindings.push(SupportBindingSchema.parse({
      schemaVersion: 2,
      supportBindingId: prefixedId("support", "beam.support_binding.v1", payload),
      ...payload,
    }));
  }
  return { bindings, metadataSelectors };
}

function hostAssistantBlockBindings(
  blockId: string,
  sourceSelector: SourceSelector,
): SupportBinding[] {
  return [
    "/blockKind",
    "/discourseContext/frame",
    "/discourseContext/commitment",
  ].map((targetFieldPathOrMentionId) => {
    const payload = {
      targetObjectType: "block" as const,
      targetObjectId: blockId,
      targetFieldPathOrMentionId,
      purpose: "semantic_classification" as const,
      method: "host-bound-block-source-v1",
      selectorIds: [sourceSelector.selectorId],
      metadataSelectorIds: [],
      confidence: "high" as const,
    } satisfies JsonValue;
    return SupportBindingSchema.parse({
      schemaVersion: 2,
      supportBindingId: prefixedId("support", "beam.support_binding.v1", payload),
      ...payload,
    });
  });
}

function renderBaseRecord(record: SemanticRecord): string {
  const groupIndexes = new Map<string, number>();
  for (const argument of record.arguments) {
    if (argument.groupId !== null && !groupIndexes.has(argument.groupId)) {
      groupIndexes.set(argument.groupId, groupIndexes.size + 1);
    }
  }
  const tags = [
    record.stance.sourceSpeakerRole,
    record.stance.sourceSpeakerSurface ? `speaker=${record.stance.sourceSpeakerSurface}` : null,
    record.recordKind,
    record.stance.speechAct,
    record.stance.speakerCertainty,
    record.stance.modalForce,
    record.stance.polarity === "negative" ? "negative" : null,
    record.discourseContext.frame !== "actual_report" ? record.discourseContext.frame : null,
    record.discourseContext.commitment !== "asserted" ? record.discourseContext.commitment : null,
    record.stance.eventStatus !== "not_applicable" ? record.stance.eventStatus : null,
    record.stance.adoption !== "not_applicable" ? record.stance.adoption : null,
  ].filter((value): value is string => value !== null);
  const predicateValues = [record.predicate.surface, record.predicate.normalized]
    .filter((value): value is string => value !== null)
    .filter((value, index, values) => values.indexOf(value) === index);
  const predicate = predicateValues.join("/");
  const predicateFolded = predicateValues.join(" ").toLocaleLowerCase("und");
  const argumentsText = record.arguments.flatMap((argument) => {
    const typedValue = argument.sourceTypedValue === null
      ? null
      : typeof argument.sourceTypedValue === "string"
        ? argument.sourceTypedValue
        : canonicalJson(argument.sourceTypedValue);
    const values = [
      argument.surface,
      typedValue,
    ].filter((value): value is string => value !== null && value.length > 0)
      .filter((value, index, values) => values.indexOf(value) === index)
      .filter((value) => !predicateFolded.includes(value.toLocaleLowerCase("und")));
    if (values.length === 0) return [];
    const group = argument.groupId === null ? "" : `#${String(groupIndexes.get(argument.groupId) ?? 0)}`;
    const valueType = argument.valueType === "text" ? "" : `:${argument.valueType}`;
    return [`${argument.customRole ?? argument.role}${group}${valueType}=${values.join("/")}`];
  });
  const validTimes = record.temporal.validTimes.flatMap((value) => {
    const rendered = [value.raw, value.normalizedStart, value.normalizedEnd, value.normalizedDuration]
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
    return rendered.length > 0 ? [`time=${[...new Set(rendered)].join("/")}`] : [];
  });
  // Assertion/session time is indexed once as immutable host metadata rather
  // than copied into every record projection. Fact-specific valid time remains.
  return [tags.join(" "), predicate, ...argumentsText, ...validTimes]
    .filter(Boolean).join(" | ");
}

function buildSemanticProjections(
  record: SemanticRecord,
  resolutions: readonly ResolutionAssertion[],
  mentions: readonly Mention[],
): SemanticProjection[] {
  const confirmed = resolutions
    .filter((entry) => entry.targetRecordId === record.recordId && entry.status === "confirmed")
    .sort((left, right) => Buffer.compare(Buffer.from(left.resolutionId), Buffer.from(right.resolutionId)));
  const base = renderBaseRecord(record);
  if (containsInternalIdentifier(base)) {
    throw new Error(`record ${record.recordId} base projection contains an internal ID`);
  }
  const basePayload = {
    recordId: record.recordId,
    projectionKind: "base",
    baseProjectionId: null,
    rendererVersion: BASE_RENDERER_VERSION,
    confirmedResolutionIds: [],
    canonicalText: base,
  } satisfies JsonValue;
  const baseProjection = SemanticProjectionSchema.parse({
    schemaVersion: 2,
    projectionId: prefixedId("projection", "beam.semantic_projection.v1", basePayload),
    ...basePayload,
  });
  if (confirmed.length === 0) return [baseProjection];
  const mentionById = new Map(mentions.map((mention) => [mention.mentionId, mention]));
  const enrichedText = `${base}\nconfirmed_resolutions=${canonicalJson(confirmed.map((entry) => ({
      target: entry.targetFieldPathOrMentionId.startsWith("mention_")
        ? { mentionSurface: mentionById.get(entry.targetFieldPathOrMentionId)?.surface ?? "unresolved_mention" }
        : { fieldPath: entry.targetFieldPathOrMentionId },
      kind: entry.kind,
      value: entry.proposedValue,
    })))}`;
  if (containsInternalIdentifier(enrichedText)) {
    throw new Error(`record ${record.recordId} enriched projection contains an internal ID`);
  }
  const enrichedPayload = {
    recordId: record.recordId,
    projectionKind: "enriched",
    baseProjectionId: baseProjection.projectionId,
    rendererVersion: `${BASE_RENDERER_VERSION}+confirmed-resolutions-v1`,
    confirmedResolutionIds: confirmed.map((entry) => entry.resolutionId),
    canonicalText: enrichedText,
  } satisfies JsonValue;
  const enrichedProjection = SemanticProjectionSchema.parse({
    schemaVersion: 2,
    projectionId: prefixedId("projection", "beam.semantic_projection.v1", enrichedPayload),
    ...enrichedPayload,
  });
  return [baseProjection, enrichedProjection];
}

function assertionTime(raw: string | null): SemanticRecord["temporal"]["assertionTime"] {
  let precision: SemanticRecord["temporal"]["assertionTime"]["precision"] = "unknown";
  if (raw !== null) {
    if (/^\d{4}$/.test(raw)) precision = "year";
    else if (/^\d{4}-\d{2}$/.test(raw)) precision = "month";
    else if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) precision = "day";
    else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(raw)) precision = "time";
    else precision = "exact";
  }
  return { raw, precision, source: "host_metadata" };
}

function lexicalTerms(value: string): string[] {
  return [...new Set(value.match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu) ?? [])]
    .map((term) => term.toLocaleLowerCase("und"))
    .sort();
}

function itemRoutingTerms(item: AssistantBlockItem): string[] {
  return item.heading === null ? [] : lexicalTerms(item.heading);
}

/** A conceptual route is a pointer, not a second copy of the raw block. */
export function compactAssistantRoutingText(value: string): string {
  return value.trim().split(/\s+/u).slice(0, 8).join(" ");
}

export function buildAssistantRawLexicalPostings(args: {
  blocks: readonly AssistantBlock[];
  items: readonly AssistantBlockItem[];
  selectors: readonly SourceSelector[];
}): RawLexicalPosting[] {
  const selectors = new Map(args.selectors.map((value) => [value.selectorId, SourceSelectorSchema.parse(value)]));
  const rows = [
    ...args.blocks.map((blockValue) => {
      const block = AssistantBlockSchema.parse(blockValue);
      return { targetObjectType: "block" as const, targetObjectId: block.blockId, sourceSelectorId: block.sourceSelectorId };
    }),
    ...args.items.map((itemValue) => {
      const item = AssistantBlockItemSchema.parse(itemValue);
      return { targetObjectType: "item" as const, targetObjectId: item.itemId, sourceSelectorId: item.sourceSelectorId };
    }),
  ];
  return rows.map((row) => {
    const selector = selectors.get(row.sourceSelectorId);
    if (!selector) throw new Error(`raw lexical posting lost selector ${row.sourceSelectorId}`);
    const payload = {
      ...row,
      normalizedTerms: lexicalTerms(selector.exactUtf8),
    } satisfies JsonValue;
    return RawLexicalPostingSchema.parse({
      schemaVersion: 2,
      postingId: prefixedId("lexical_posting", "beam.raw_lexical_posting.v1", payload),
      ...payload,
    });
  }).sort((left, right) => Buffer.compare(Buffer.from(left.postingId), Buffer.from(right.postingId)));
}

export type MapperMaterialization = {
  records: SemanticRecord[];
  mentions: Mention[];
  supportBindings: SupportBinding[];
  resolutionAssertions: ResolutionAssertion[];
  semanticProjections: SemanticProjection[];
  assistantBlocks: AssistantBlock[];
  assistantBlockItems: AssistantBlockItem[];
  assistantBlockProjections: AssistantBlockProjection[];
  sourceSelectors: SourceSelector[];
  metadataSelectors: MetadataSelector[];
  quarantines: Quarantine[];
  coverageRows: CoverageRow[];
  derivations: DerivationOccurrence[];
  lifecycleEvents: LifecycleEvent[];
  attemptResults: AttemptMaterializationResult[];
  warnings: MaterializationIssue[];
  complete: boolean;
  completionErrors: string[];
};

function uniqueLocalKeys(values: readonly string[], label: string): string[] {
  const duplicates = values.filter((value, index) => values.indexOf(value) !== index);
  if (duplicates.length > 0) throw new Error(`${label} has duplicate keys: ${[...new Set(duplicates)].join(",")}`);
  return [...values];
}

export function crossTypeProposalKeyCollisions(args: {
  mentionKeys: readonly string[];
  recordKeys: readonly string[];
  blockKeys: readonly string[];
  resolutionKeys: readonly string[];
}): string[] {
  const owners = new Map<string, Set<string>>();
  for (const [type, keys] of Object.entries(args)) {
    for (const key of keys) {
      const values = owners.get(key) ?? new Set<string>();
      values.add(type);
      owners.set(key, values);
    }
  }
  return [...owners]
    .filter(([, types]) => types.size > 1)
    .map(([key]) => key)
    .sort();
}

export function quarantineRootKey(objectType: Quarantine["objectType"], localObjectKey: string): string {
  return `${objectType}:${localObjectKey}`;
}

export function materializeMapperPages(args: {
  rawTurns: readonly RawTurn[];
  expectedTargetOpaqueId: string;
  targetRawTurnIds: ReadonlySet<string>;
  expectedSegments: readonly StructuralSegment[];
  pages: readonly MapperPageOutput[];
  attemptsByPage: ReadonlyMap<number, Attempt>;
  parentQuarantinesByLocalKey?: ReadonlyMap<string, readonly string[]>;
}): MapperMaterialization {
  const rawTurns = args.rawTurns.map((turn) => RawTurnSchema.parse(turn));
  const rawTurnMap = new Map(rawTurns.map((turn) => [turn.rawTurnId, turn]));
  const segments = args.expectedSegments.map((segment) => StructuralSegmentSchema.parse(segment));
  const expectedSegmentIds = new Set(segments.map((segment) => segment.segmentId));
  const pages = args.pages.map((page) => MapperPageOutputSchema.parse(page))
    .sort((left, right) => left.pageNumber - right.pageNumber);
  const completionErrors: string[] = [];
  if (pages.some((page) => page.targetSessionOpaqueId !== args.expectedTargetOpaqueId)) {
    completionErrors.push("mapper page references an unknown target session");
  }
  const pageCount = pages[0]?.pageCount ?? 0;
  if (pages.length !== pageCount || pages.some((page) => page.pageCount !== pageCount)) {
    completionErrors.push("mapper pages do not match their declared pageCount");
  }
  const expectedNumbers = Array.from({ length: pageCount }, (_, index) => index + 1);
  if (pages.map((page) => page.pageNumber).join(",") !== expectedNumbers.join(",")) {
    completionErrors.push("mapper page numbers are missing or duplicated");
  }
  for (const page of pages) {
    const attempt = args.attemptsByPage.get(page.pageNumber);
    if (!attempt || !AttemptSchema.parse(attempt).outputComplete) {
      completionErrors.push(`page ${String(page.pageNumber)} has no complete attempt`);
    }
  }
  const declaredSegments = pages.flatMap((page) => page.expectedSegmentIds);
  if (
    declaredSegments.length !== new Set(declaredSegments).size
    || declaredSegments.some((segmentId) => !expectedSegmentIds.has(segmentId))
    || declaredSegments.length !== expectedSegmentIds.size
  ) completionErrors.push("mapper page segment manifests do not exactly partition expected segments");

  const mentionsDraft = pages.flatMap((page) => page.mentions.map((draft) => ({ page: page.pageNumber, draft })));
  const recordDrafts = pages.flatMap((page) => page.records.map((draft) => ({ page: page.pageNumber, draft })));
  const blockDrafts = pages.flatMap((page) => page.assistantBlocks.map((draft) => ({ page: page.pageNumber, draft })));
  const resolutionDrafts = pages.flatMap((page) => page.resolutionAssertions.map((draft) => ({ page: page.pageNumber, draft })));
  uniqueLocalKeys(mentionsDraft.map((entry) => entry.draft.localMentionKey), "mentions");
  uniqueLocalKeys(recordDrafts.map((entry) => entry.draft.localRecordKey), "records");
  uniqueLocalKeys(blockDrafts.map((entry) => entry.draft.localBlockKey), "blocks");
  uniqueLocalKeys(resolutionDrafts.map((entry) => entry.draft.localResolutionKey), "resolutions");
  const crossTypeCollisions = crossTypeProposalKeyCollisions({
    mentionKeys: mentionsDraft.map((entry) => entry.draft.localMentionKey),
    recordKeys: recordDrafts.map((entry) => entry.draft.localRecordKey),
    blockKeys: blockDrafts.map((entry) => entry.draft.localBlockKey),
    resolutionKeys: resolutionDrafts.map((entry) => entry.draft.localResolutionKey),
  });
  if (crossTypeCollisions.length > 0) {
    completionErrors.push(`cross-type proposal keys are ambiguous: ${crossTypeCollisions.join(",")}`);
  }

  const sourceSelectors: SourceSelector[] = [];
  const metadataSelectors: MetadataSelector[] = [];
  const quarantines: Quarantine[] = [];
  const warnings: MaterializationIssue[] = [];
  const mentions: Mention[] = [];
  const derivations: DerivationOccurrence[] = [];
  const mentionIds = new Map<string, string>();
  const quarantineByLocalKey = new Map<string, string[]>();
  const parentQuarantines = args.parentQuarantinesByLocalKey ?? new Map<string, readonly string[]>();
  const structuralSegmentMap = new Map(segments.map((segment) => [segment.segmentId, segment]));
  const mergedSourceRanges = (segmentIds: readonly string[]) => {
    const ordered = segmentIds.flatMap((segmentId) => structuralSegmentMap.get(segmentId) ?? [])
      .sort((left, right) => left.rawTurnId.localeCompare(right.rawTurnId) || left.byteStart - right.byteStart);
    const ranges: Array<Pick<StructuralSegment, "rawTurnId" | "byteStart" | "byteEnd">> = [];
    for (const segment of ordered) {
      const prior = ranges.at(-1);
      if (prior && prior.rawTurnId === segment.rawTurnId && prior.byteEnd === segment.byteStart) {
        prior.byteEnd = segment.byteEnd;
      } else ranges.push({ rawTurnId: segment.rawTurnId, byteStart: segment.byteStart, byteEnd: segment.byteEnd });
    }
    return ranges;
  };
  const pageSourceRanges = new Map(pages.map((page) => [
    page.pageNumber,
    mergedSourceRanges(page.expectedSegmentIds),
  ] as const));
  const routedSourceRanges = (
    pageNumber: number,
    localObjectKey: string,
    objectType: "record" | "assistant_block",
  ) => {
    const page = pages.find((candidate) => candidate.pageNumber === pageNumber);
    if (!page) return [];
    return mergedSourceRanges(page.coverageRows.filter((row) =>
      (objectType === "record" ? row.localRecordKeys : row.localBlockKeys).includes(localObjectKey)
      || row.localObjectKeysExpectedInQuarantine.includes(localObjectKey))
      .map((row) => row.segmentId));
  };
  const makeQuarantine = (value: Omit<Parameters<typeof quarantine>[0], "parentQuarantineIds">): Quarantine =>
    quarantine({
      ...value,
      parentQuarantineIds: [...(parentQuarantines.get(quarantineRootKey(value.objectType, value.localObjectKey)) ?? [])],
    });

  for (const entry of mentionsDraft) {
    const attempt = args.attemptsByPage.get(entry.page);
    if (!attempt) continue;
    const pageSegmentIds = new Set(
      pages.find((page) => page.pageNumber === entry.page)?.expectedSegmentIds ?? [],
    );
    const occurrenceSegment = entry.draft.sourceSegmentId === null
      ? undefined
      : structuralSegmentMap.get(entry.draft.sourceSegmentId);
    const invalidOccurrenceSegment = entry.draft.sourceSegmentId !== null
      && (!occurrenceSegment || !pageSegmentIds.has(entry.draft.sourceSegmentId));
    const resolved = invalidOccurrenceSegment
      ? {
        selector: null,
        warnings: [],
        issues: [issue("invalid_coverage", "mention sourceSegmentId is not part of its immutable mapper page")],
        candidateByteOffsets: [],
      }
      : resolveSourceAnchor(
        entry.draft.anchor,
        rawTurnMap,
        occurrenceSegment ? [occurrenceSegment] : pageSourceRanges.get(entry.page),
      );
    warnings.push(...resolved.warnings);
    const mentionOutsideTarget = resolved.selector !== null && !args.targetRawTurnIds.has(resolved.selector.rawTurnId);
    if (resolved.selector) sourceSelectors.push(resolved.selector);
    if (!resolved.selector || mentionOutsideTarget) {
      const value = makeQuarantine({
        attemptId: attempt.attemptId,
        objectType: "mention",
        localObjectKey: entry.draft.localMentionKey,
        draft: entry.draft,
        resolvedSelectorIds: resolved.selector ? [resolved.selector.selectorId] : [],
        issues: mentionOutsideTarget
          ? [issue("claim_outside_target", "mention source lies outside the target session")]
          : resolved.issues,
      });
      quarantines.push(value);
      quarantineByLocalKey.set(entry.draft.localMentionKey, [value.quarantineId]);
      continue;
    }
    if (containsInternalIdentifier(resolved.selector.exactUtf8)) {
      const value = makeQuarantine({
        attemptId: attempt.attemptId,
        objectType: "mention",
        localObjectKey: entry.draft.localMentionKey,
        draft: entry.draft,
        resolvedSelectorIds: [resolved.selector.selectorId],
        issues: [issue("schema_invalid", "mention surface would expose an internal identifier in a searchable projection")],
      });
      quarantines.push(value);
      quarantineByLocalKey.set(entry.draft.localMentionKey, [value.quarantineId]);
      continue;
    }
    const payload = {
      selectorId: resolved.selector.selectorId,
      mentionType: entry.draft.mentionType,
    } satisfies JsonValue;
    const mention = MentionSchema.parse({
      schemaVersion: 2,
      mentionId: prefixedId("mention", "beam.mention.v1", payload),
      ...payload,
      surface: resolved.selector.exactUtf8,
    });
    mentions.push(mention);
    mentionIds.set(entry.draft.localMentionKey, mention.mentionId);
  }

  const records: SemanticRecord[] = [];
  const supportBindings: SupportBinding[] = [];
  const recordIds = new Map<string, string>();
  let pending = [...recordDrafts];
  while (pending.length > 0) {
    let progress = false;
    const next: typeof pending = [];
    for (const entry of pending) {
      const attempt = args.attemptsByPage.get(entry.page);
      if (!attempt) continue;
      const unresolvedRef = entry.draft.arguments.find((argument) =>
        argument.recordRefLocalKey !== null && !recordIds.has(argument.recordRefLocalKey),
      );
      if (unresolvedRef) {
        next.push(entry);
        continue;
      }
      progress = true;
      const pageRanges = pageSourceRanges.get(entry.page);
      const routedRanges = routedSourceRanges(entry.page, entry.draft.localRecordKey, "record");
      const claim = resolveAnchorsAtomically(
        entry.draft.claimAnchors,
        rawTurnMap,
        routedRanges.length > 0 ? routedRanges : pageRanges,
        pageRanges,
      );
      warnings.push(...claim.warnings);
      const localIssues = [...claim.issues];
      for (const argument of entry.draft.arguments) {
        if (argument.role === "other" && argument.customRole === null) {
          localIssues.push(issue("schema_invalid", `argument ${argument.argumentKey} uses role=other without customRole`));
        }
        if (argument.valueType === "entity_mention" && argument.mentionKey === null) {
          localIssues.push(issue("schema_invalid", `argument ${argument.argumentKey} is an entity_mention without mentionKey`));
        }
        if (argument.valueType === "record_ref" && argument.recordRefLocalKey === null) {
          localIssues.push(issue("schema_invalid", `argument ${argument.argumentKey} is a record_ref without recordRefLocalKey`));
        }
      }
      if (
        entry.draft.stance.sourceSpeakerRole === "assistant"
        && entry.draft.discourseContext.commitment === "suggested"
      ) {
        localIssues.push(issue(
          "schema_invalid",
          "ASSISTANT suggested advice, plans, examples, and template content must use an assistant block, not a semantic record",
        ));
      }
      for (const time of entry.draft.validTimes) {
        if (
          time.resolutionBasis === "unresolved"
          && [time.normalizedStart, time.normalizedEnd, time.normalizedDuration, time.recurrence]
            .some((value) => value !== null)
        ) {
          localIssues.push(issue("schema_invalid", "unresolved source time contains normalized values"));
        }
      }
      const rawClaimTurns = [...new Set(claim.selectors.map((selector) => selector.rawTurnId))];
      if (rawClaimTurns.some((rawTurnId) => !args.targetRawTurnIds.has(rawTurnId))) {
        localIssues.push(issue("claim_outside_target", "claim selector lies outside the target session"));
      }
      const missingMention = entry.draft.arguments.find((argument) =>
        argument.mentionKey !== null && !mentionIds.has(argument.mentionKey),
      ) ?? (entry.draft.stance.reportedSpeakerMentionKey !== null
        && !mentionIds.has(entry.draft.stance.reportedSpeakerMentionKey)
        ? { mentionKey: entry.draft.stance.reportedSpeakerMentionKey }
        : undefined);
      if (missingMention) localIssues.push(issue("unknown_mention", "record references an unmaterialized mention"));

      let parentScopeSelector: SourceSelector | null = null;
      if (entry.draft.discourseContext.parentScopeAnchor !== null) {
        const claimFocus = [...claim.selectors].sort((left, right) => left.byteStart - right.byteStart)[0];
        const parent = resolveSourceAnchor(
          entry.draft.discourseContext.parentScopeAnchor,
          rawTurnMap,
          pageRanges,
          claimFocus,
        );
        warnings.push(...parent.warnings);
        localIssues.push(...parent.issues);
        parentScopeSelector = parent.selector;
        if (parent.selector) {
          sourceSelectors.push(parent.selector);
          if (!args.targetRawTurnIds.has(parent.selector.rawTurnId)) {
            localIssues.push(issue("claim_outside_target", "record discourse scope lies outside target session"));
          }
        }
      }
      sourceSelectors.push(...claim.selectors);
      if (localIssues.length > 0 || claim.selectors.length === 0) {
        const value = makeQuarantine({
          attemptId: attempt.attemptId,
          objectType: "record",
          localObjectKey: entry.draft.localRecordKey,
          draft: entry.draft,
          resolvedSelectorIds: claim.selectors.map((selector) => selector.selectorId),
          issues: localIssues.length > 0 ? localIssues : [issue("schema_invalid", "record has no claim selector")],
        });
        quarantines.push(value);
        quarantineByLocalKey.set(entry.draft.localRecordKey, [value.quarantineId]);
        continue;
      }
      const claimTurn = rawClaimTurns
        .flatMap((rawTurnId) => rawTurnMap.get(rawTurnId) ?? [])
        .sort((left, right) => left.sessionOrdinal - right.sessionOrdinal || left.turnOrdinal - right.turnOrdinal)
        .at(-1);
      if (!claimTurn) throw new Error("materialized claim lost its raw turn");
      if (rawClaimTurns.some((rawTurnId) => rawTurnMap.get(rawTurnId)?.role !== entry.draft.stance.sourceSpeakerRole)) {
        const value = makeQuarantine({
          attemptId: attempt.attemptId,
          objectType: "record",
          localObjectKey: entry.draft.localRecordKey,
          draft: entry.draft,
          resolvedSelectorIds: claim.selectors.map((selector) => selector.selectorId),
          issues: [issue("schema_invalid", "stance sourceSpeakerRole disagrees with immutable source role")],
        });
        quarantines.push(value);
        quarantineByLocalKey.set(entry.draft.localRecordKey, [value.quarantineId]);
        continue;
      }
      const core = SemanticRecordCoreSchema.parse({
        schemaVersion: 2,
        recordKind: entry.draft.recordKind,
        discourseContext: {
          frame: entry.draft.discourseContext.frame,
          commitment: entry.draft.discourseContext.commitment,
          parentScopeSelectorId: parentScopeSelector?.selectorId ?? null,
        },
        predicate: entry.draft.predicate,
        arguments: entry.draft.arguments.map((argument) => ({
          argumentId: argument.argumentKey,
          role: argument.role,
          customRole: argument.customRole,
          groupId: argument.groupKey,
          valueType: argument.valueType,
          surface: argument.surface,
          sourceTypedValue: argument.sourceTypedValue === null
            ? null
            : decodeModelJsonValue(argument.sourceTypedValue),
          mentionId: argument.mentionKey === null ? null : mentionIds.get(argument.mentionKey) ?? null,
          recordId: argument.recordRefLocalKey === null ? null : recordIds.get(argument.recordRefLocalKey) ?? null,
        })),
        stance: {
          sourceSpeakerRole: entry.draft.stance.sourceSpeakerRole,
          sourceSpeakerSurface: entry.draft.stance.sourceSpeakerSurface,
          reportedSpeakerMentionId: entry.draft.stance.reportedSpeakerMentionKey === null
            ? null
            : mentionIds.get(entry.draft.stance.reportedSpeakerMentionKey) ?? null,
          speechAct: entry.draft.stance.speechAct,
          polarity: entry.draft.stance.polarity,
          modalForce: entry.draft.stance.modalForce,
          eventStatus: entry.draft.stance.eventStatus,
          adoption: entry.draft.stance.adoption,
          speakerCertainty: entry.draft.stance.speakerCertainty,
        },
        temporal: {
          assertionTime: assertionTime(claimTurn.rawTimestamp),
          sessionOrdinal: claimTurn.sessionOrdinal,
          turnOrdinal: claimTurn.turnOrdinal,
          validTimes: entry.draft.validTimes.map((time) => ({
            ...time,
            recurrence: time.recurrence === null ? null : decodeModelJsonValue(time.recurrence),
          })),
        },
        claimSelectorIds: asciiIdSort(claim.selectors.map((selector) => selector.selectorId)),
      });
      const recordId = prefixedId("record", "beam.semantic_record.v1", jsonValue(core));
      const record = SemanticRecordSchema.parse({ ...core, recordId });
      if (containsInternalIdentifier(renderBaseRecord(record))) {
        const value = makeQuarantine({
          attemptId: attempt.attemptId,
          objectType: "record",
          localObjectKey: entry.draft.localRecordKey,
          draft: entry.draft,
          resolvedSelectorIds: claim.selectors.map((selector) => selector.selectorId),
          issues: [issue("schema_invalid", "record searchable fields contain an internal identifier")],
        });
        quarantines.push(value);
        quarantineByLocalKey.set(entry.draft.localRecordKey, [value.quarantineId]);
        continue;
      }
      const bindingResult = materializeSupportBindings({
        draftBindings: entry.draft.supportBindings,
        targetObjectType: "record",
        targetObjectId: recordId,
        requiredPaths: semanticPaths(entry.draft),
        mentionIds,
        mentionFieldPaths: new Map(
          [...new Set(entry.draft.arguments.flatMap((argument) => argument.mentionKey ?? []))]
            .map((mentionKey) => [
              mentionKey,
              entry.draft.arguments.flatMap((argument) =>
                argument.mentionKey === mentionKey
                  ? [`/arguments/${argument.argumentKey}/mentionId`]
                  : []),
            ]),
        ),
        rawTurns: rawTurnMap,
        allowedEvidenceRawTurnIds: args.targetRawTurnIds,
        preferredEvidenceRanges: routedRanges.length > 0 ? routedRanges : pageRanges,
        fallbackEvidenceRanges: pageRanges,
        fallbackClaimSelectors: claim.selectors,
      });
      warnings.push(...bindingResult.warnings);
      sourceSelectors.push(...bindingResult.selectors);
      metadataSelectors.push(...bindingResult.metadataSelectors);
      const hostBindings = hostTemporalBindings(recordId, claimTurn);
      metadataSelectors.push(...hostBindings.metadataSelectors);
      if (bindingResult.issues.length > 0) {
        const value = makeQuarantine({
          attemptId: attempt.attemptId,
          objectType: "record",
          localObjectKey: entry.draft.localRecordKey,
          draft: entry.draft,
          resolvedSelectorIds: [
            ...claim.selectors.map((selector) => selector.selectorId),
            ...bindingResult.selectors.map((selector) => selector.selectorId),
          ],
          issues: bindingResult.issues,
        });
        quarantines.push(value);
        quarantineByLocalKey.set(entry.draft.localRecordKey, [value.quarantineId]);
        continue;
      }
      records.push(record);
      recordIds.set(entry.draft.localRecordKey, recordId);
      supportBindings.push(...bindingResult.bindings, ...hostBindings.bindings);
    }
    if (!progress) {
      for (const entry of next) {
        const attempt = args.attemptsByPage.get(entry.page);
        if (!attempt) continue;
      const value = makeQuarantine({
          attemptId: attempt.attemptId,
          objectType: "record",
          localObjectKey: entry.draft.localRecordKey,
          draft: entry.draft,
          issues: [issue("unknown_record_ref", "record references an unresolved or cyclic local record")],
        });
        quarantines.push(value);
        quarantineByLocalKey.set(entry.draft.localRecordKey, [value.quarantineId]);
      }
      pending = [];
    } else pending = next;
  }

  const assistantBlocks: AssistantBlock[] = [];
  const assistantBlockItems: AssistantBlockItem[] = [];
  const assistantBlockProjections: AssistantBlockProjection[] = [];
  const blockIds = new Map<string, string>();
  const blockLocalKeysBySegment = new Map<string, string[]>();
  for (const entry of blockDrafts) {
    for (const segmentId of entry.draft.sourceSegmentIds) {
      const keys = blockLocalKeysBySegment.get(segmentId) ?? [];
      if (!keys.includes(entry.draft.localBlockKey)) keys.push(entry.draft.localBlockKey);
      blockLocalKeysBySegment.set(segmentId, keys);
    }
  }
  const itemIds = new Map<string, string>();
  const itemLocalKeysByBlock = new Map<string, string[]>();
  for (const entry of blockDrafts) {
    const attempt = args.attemptsByPage.get(entry.page);
    if (!attempt) continue;
    const hasSegmentRoute = entry.draft.sourceSegmentIds.length > 0;
    const segmentSource = hasSegmentRoute
      ? resolveSegmentRange(
        entry.draft.sourceSegmentIds,
        new Map((pages.find((page) => page.pageNumber === entry.page)?.expectedSegmentIds ?? [])
          .flatMap((segmentId) => structuralSegmentMap.get(segmentId) ?? [])
          .map((segment) => [segment.segmentId, segment])),
        rawTurnMap,
      )
      : null;
    // A redundant exact anchor is a safe lossless fallback if the model's
    // selected segment range is malformed. Both routes still resolve against
    // immutable target-page bytes; no semantic choice is invented by the host.
    const anchorSource = entry.draft.sourceAnchor === null
      ? null
      : resolveSourceAnchor(entry.draft.sourceAnchor, rawTurnMap, pageSourceRanges.get(entry.page));
    const blockSource = segmentSource?.selector
      ? segmentSource
      : anchorSource?.selector
        ? anchorSource
        : segmentSource ?? anchorSource ?? {
          selector: null,
          warnings: [],
          issues: [issue("schema_invalid", "assistant block has no source route")],
          candidateByteOffsets: [],
        };
    warnings.push(...blockSource.warnings);
    const localIssues = [...blockSource.issues];
    const blockSelector = blockSource.selector;
    let parentScopeSelector: SourceSelector | null = null;
    if (entry.draft.discourseContext.parentScopeAnchor !== null) {
      const parent = resolveSourceAnchor(
        entry.draft.discourseContext.parentScopeAnchor,
        rawTurnMap,
        pageSourceRanges.get(entry.page),
        blockSelector ?? undefined,
      );
      warnings.push(...parent.warnings);
      localIssues.push(...parent.issues);
      parentScopeSelector = parent.selector;
      if (parent.selector) {
        sourceSelectors.push(parent.selector);
        if (!args.targetRawTurnIds.has(parent.selector.rawTurnId)) {
          localIssues.push(issue("claim_outside_target", "assistant block discourse scope lies outside target session"));
        }
      }
    }
    const listSegments = blockSelector
      ? segments.filter((segment) =>
        segment.rawTurnId === blockSelector.rawTurnId
        && segment.segmentKind === "list_item"
        && segment.byteStart >= blockSelector.byteStart
        && segment.byteEnd <= blockSelector.byteEnd,
      ).sort((left, right) => left.ordinal - right.ordinal)
      : [];
    // Structural list boundaries are host-owned. The model decides the
    // coherent block and its meaning; it does not have to reproduce every
    // exact list-item boundary or identifier.
    const deterministicItems = listSegments.map((segment, index) => {
      const turn = rawTurnMap.get(segment.rawTurnId);
      if (!turn) throw new Error(`assistant list segment lost raw turn ${segment.rawTurnId}`);
      return {
        localItemKey: `auto_item_${contentAddress("beam.assistant_item.local.v1", {
          blockLocalKey: entry.draft.localBlockKey,
          segmentId: segment.segmentId,
        }).slice(0, 32)}`,
        ordinal: index,
        // Raw vocabulary remains in the lossless lexical posting; copying it
        // into the semantic projection would inflate the compressed plane.
        heading: null,
        sourceAnchor: null,
        sourceSegmentId: segment.segmentId,
      } satisfies DraftAssistantBlock["items"][number];
    });
    const itemResults = deterministicItems.map((item) => ({
      item,
      resolved: resolveSegmentRange([item.sourceSegmentId], structuralSegmentMap, rawTurnMap),
      routeInvalid: false,
    }));
    for (const result of itemResults) {
      warnings.push(...result.resolved.warnings);
      localIssues.push(...result.resolved.issues);
      if (result.routeInvalid) {
        localIssues.push(issue("schema_invalid", "assistant block item must use exactly one source route"));
      }
      const itemTurn = result.resolved.selector ? rawTurnMap.get(result.resolved.selector.rawTurnId) : undefined;
      if (itemTurn && (itemTurn.role !== "assistant" || !args.targetRawTurnIds.has(itemTurn.rawTurnId))) {
        localIssues.push(issue("claim_outside_target", "assistant block item must come from a target ASSISTANT turn"));
      }
    }
    const blockTurn = blockSource.selector ? rawTurnMap.get(blockSource.selector.rawTurnId) : undefined;
    if (blockTurn && (blockTurn.role !== "assistant" || !args.targetRawTurnIds.has(blockTurn.rawTurnId))) {
      localIssues.push(issue("claim_outside_target", "assistant block must come from a target ASSISTANT turn"));
    }
    if (blockSource.selector) {
      for (const result of itemResults) {
        const selector = result.resolved.selector;
        if (
          selector
          && (
            selector.rawTurnId !== blockSource.selector.rawTurnId
            || selector.byteStart < blockSource.selector.byteStart
            || selector.byteEnd > blockSource.selector.byteEnd
          )
        ) localIssues.push(issue("schema_invalid", "assistant item boundary lies outside its complete block"));
      }
      for (const segment of listSegments) {
        const coveringItems = itemResults.filter((result) => {
          const selector = result.resolved.selector;
          return selector
            && selector.rawTurnId === segment.rawTurnId
            && selector.byteStart <= segment.byteStart
            && selector.byteEnd >= segment.byteEnd;
        });
        if (coveringItems.length !== 1) {
          localIssues.push(issue("schema_invalid", `list segment ${segment.segmentId} lacks one exact item boundary`));
        }
      }
    }
    sourceSelectors.push(
      ...(blockSource.selector ? [blockSource.selector] : []),
      ...itemResults.flatMap((result) => result.resolved.selector ? [result.resolved.selector] : []),
    );
    if (!blockSource.selector || localIssues.length > 0) {
        const value = makeQuarantine({
        attemptId: attempt.attemptId,
        objectType: "assistant_block",
        localObjectKey: entry.draft.localBlockKey,
        draft: entry.draft,
        resolvedSelectorIds: [
          ...(blockSource.selector ? [blockSource.selector.selectorId] : []),
          ...itemResults.flatMap((result) => result.resolved.selector ? [result.resolved.selector.selectorId] : []),
        ],
        issues: localIssues.length > 0 ? localIssues : [issue("schema_invalid", "block source failed")],
      });
      quarantines.push(value);
      quarantineByLocalKey.set(entry.draft.localBlockKey, [value.quarantineId]);
      continue;
    }
    const blockCore = {
      schemaVersion: 2,
      blockKind: entry.draft.blockKind,
      discourseContext: {
        frame: entry.draft.discourseContext.frame,
        commitment: entry.draft.discourseContext.commitment,
        parentScopeSelectorId: parentScopeSelector?.selectorId ?? null,
      },
      sourceSelectorId: blockSource.selector.selectorId,
    } satisfies Omit<AssistantBlock, "blockId">;
    const blockId = prefixedId("block", "beam.assistant_block.v1", jsonValue(blockCore));
    const block = AssistantBlockSchema.parse({ ...blockCore, blockId });
    const blockBindings = hostAssistantBlockBindings(blockId, blockSource.selector);
    const items = itemResults.map(({ item, resolved }) => {
      if (!resolved.selector) throw new Error("block item selector unexpectedly absent");
      const itemCore = {
        schemaVersion: 2,
        blockId,
        ordinal: item.ordinal,
        heading: item.heading,
        sourceSelectorId: resolved.selector.selectorId,
      } satisfies Omit<AssistantBlockItem, "itemId">;
      const materialized = AssistantBlockItemSchema.parse({
        ...itemCore,
        itemId: prefixedId("item", "beam.assistant_block_item.v1", jsonValue(itemCore)),
      });
      itemIds.set(item.localItemKey, materialized.itemId);
      return materialized;
    });
    itemLocalKeysByBlock.set(entry.draft.localBlockKey, deterministicItems.map((item) => item.localItemKey));
    const itemTerms = Object.fromEntries(items.map((item) => [item.itemId, itemRoutingTerms(item)]));
    // Exact vocabulary is already indexed in lossless raw block/item postings.
    // Keep only the model's conceptual route in the compressed semantic plane.
    const routingText = compactAssistantRoutingText(entry.draft.routingText);
    const routingTerms: string[] = [];
    if (containsInternalIdentifier([routingText, ...routingTerms, ...Object.values(itemTerms).flat()].join("\n"))) {
      const value = makeQuarantine({
        attemptId: attempt.attemptId,
        objectType: "assistant_block",
        localObjectKey: entry.draft.localBlockKey,
        draft: entry.draft,
        resolvedSelectorIds: [
          blockSource.selector.selectorId,
          ...items.map((item) => item.sourceSelectorId),
        ],
        issues: [issue("schema_invalid", "semantic routing projection contains an internal ID")],
      });
      quarantines.push(value);
      quarantineByLocalKey.set(entry.draft.localBlockKey, [value.quarantineId]);
      continue;
    }
    const projectionPayload = {
      blockId,
      rendererVersion: ASSISTANT_ROUTER_VERSION,
      routingText,
      routingTerms,
      itemRoutingTerms: itemTerms,
    } satisfies JsonValue;
    assistantBlocks.push(block);
    assistantBlockItems.push(...items);
    assistantBlockProjections.push(AssistantBlockProjectionSchema.parse({
      schemaVersion: 2,
      projectionId: prefixedId("projection", "beam.assistant_block_projection.v1", projectionPayload),
      ...projectionPayload,
    }));
    supportBindings.push(...blockBindings);
    blockIds.set(entry.draft.localBlockKey, blockId);
  }

  const resolutionAssertions: ResolutionAssertion[] = [];
  const resolutionIds = new Map<string, string>();
  for (const entry of resolutionDrafts) {
    const attempt = args.attemptsByPage.get(entry.page);
    if (!attempt) continue;
    const recordId = recordIds.get(entry.draft.targetRecordLocalKey);
    const targetRecord = recordId ? records.find((record) => record.recordId === recordId) : undefined;
    const targetRecordDraft = recordDrafts.find(
      (candidate) => candidate.draft.localRecordKey === entry.draft.targetRecordLocalKey,
    )?.draft;
    const target = entry.draft.targetKind === "mention"
      ? mentionIds.get(entry.draft.targetPathOrMentionKey)
      : entry.draft.targetPathOrMentionKey;
    const evidence = resolveAnchorsAtomically(entry.draft.evidenceAnchors, rawTurnMap);
    warnings.push(...evidence.warnings);
    const metadata = entry.draft.metadataEvidence.map((item) => materializeMetadataSelector(item, rawTurnMap));
    sourceSelectors.push(...evidence.selectors);
    const localIssues = [...evidence.issues];
    if (entry.draft.evidenceAnchors.length + entry.draft.metadataEvidence.length === 0) {
      localIssues.push(issue("resolution_failed", "resolution assertion has no source or metadata evidence"));
    }
    if (
      entry.draft.targetKind === "field"
      && !/^\/(?:recordKind|discourseContext|predicate|arguments|stance|temporal)(?:\/|$)/.test(
        entry.draft.targetPathOrMentionKey,
      )
    ) {
      localIssues.push(issue("resolution_failed", "resolution field target is outside the semantic core"));
    }
    if (
      entry.draft.targetKind === "mention"
      && !/^[a-z][a-z0-9_]{0,127}$/.test(entry.draft.targetPathOrMentionKey)
    ) {
      localIssues.push(issue("resolution_failed", "resolution mention target is not a valid local mention key"));
    }
    if (!recordId) localIssues.push(issue("resolution_failed", "resolution targets an unmaterialized record"));
    if (!target) localIssues.push(issue("resolution_failed", "resolution targets an unmaterialized mention"));
    const proposedValue = decodeModelJsonValue(entry.draft.proposedValue);
    if (containsInternalIdentifier(proposedValue)) {
      localIssues.push(issue("resolution_failed", "resolution proposed value contains an internal ID"));
    }
    if (
      entry.draft.targetKind === "field"
      && targetRecordDraft
      && !semanticPaths(targetRecordDraft).includes(entry.draft.targetPathOrMentionKey)
    ) {
      localIssues.push(issue("resolution_failed", "resolution targets a semantic field that does not exist"));
    }
    if (
      entry.draft.targetKind === "mention"
      && targetRecord
      && target
      && ![
        targetRecord.stance.reportedSpeakerMentionId,
        ...targetRecord.arguments.map((argument) => argument.mentionId),
      ].includes(target)
    ) {
      localIssues.push(issue("resolution_failed", "resolution mention is not referenced by the target record"));
    }
    if (metadata.some((item) => item === null)) localIssues.push(issue("resolution_failed", "resolution metadata evidence is invalid"));
    if (localIssues.length > 0 || !recordId || !target) {
      const value = makeQuarantine({
        attemptId: attempt.attemptId,
        objectType: "resolution",
        localObjectKey: entry.draft.localResolutionKey,
        draft: entry.draft,
        resolvedSelectorIds: evidence.selectors.map((selector) => selector.selectorId),
        issues: localIssues,
      });
      quarantines.push(value);
      quarantineByLocalKey.set(entry.draft.localResolutionKey, [value.quarantineId]);
      continue;
    }
    metadataSelectors.push(...metadata.flatMap((item) => item ? [item] : []));
    const payload = {
      targetRecordId: recordId,
      targetFieldPathOrMentionId: target,
      kind: entry.draft.kind,
      proposedValue,
      selectorIds: asciiIdSort(evidence.selectors.map((selector) => selector.selectorId)),
      metadataSelectorIds: asciiIdSort(metadata.flatMap((item) => item ? [item.metadataSelectorId] : [])),
      method: entry.draft.method,
      confidence: entry.draft.confidence,
      status: entry.draft.status,
    } satisfies JsonValue;
    const resolution = ResolutionAssertionSchema.parse({
      schemaVersion: 2,
      resolutionId: prefixedId("resolution", "beam.resolution_assertion.v1", payload),
      ...payload,
    });
    resolutionAssertions.push(resolution);
    resolutionIds.set(entry.draft.localResolutionKey, resolution.resolutionId);
  }

  const semanticProjections = records.flatMap((record) => buildSemanticProjections(record, resolutionAssertions, mentions));
  const lifecycleEvents = records.map((record) => createLifecycleEvent({
    recordId: record.recordId,
    judgedProjectionId: semanticProjections.find((projection) =>
      projection.recordId === record.recordId && projection.projectionKind === "base")?.projectionId
      ?? (() => { throw new Error(`record ${record.recordId} lost its base projection`); })(),
    state: "accepted",
    basis: "materialization",
    semanticJudgeAttemptIds: [],
    adjudicatorAttemptId: null,
    replacementRecordIds: [],
    priorLifecycleEventIds: [],
    detail: "record passed atomic selector, role, shape, and support-binding materialization",
  }));

  const attemptForPage = (page: number): Attempt => {
    const attempt = args.attemptsByPage.get(page);
    if (!attempt) throw new Error(`missing attempt for page ${String(page)}`);
    return attempt;
  };
  const appendDerivation = (
    attempt: Attempt,
    objectType: DerivationOccurrence["objectType"],
    objectId: string,
    proposalLocalKey: string,
    extractionConfidence: DerivationOccurrence["extractionConfidence"],
  ): void => {
    const payload = {
      attemptId: attempt.attemptId,
      objectType,
      objectId,
      proposalLocalKey,
      extractionConfidence,
    } satisfies JsonValue;
    derivations.push(createDerivationOccurrence(payload));
  };
  for (const entry of mentionsDraft) {
    const objectId = mentionIds.get(entry.draft.localMentionKey);
    if (objectId) appendDerivation(attemptForPage(entry.page), "mention", objectId, entry.draft.localMentionKey, null);
  }
  for (const entry of recordDrafts) {
    const objectId = recordIds.get(entry.draft.localRecordKey);
    if (objectId) appendDerivation(
      attemptForPage(entry.page),
      "record",
      objectId,
      entry.draft.localRecordKey,
      entry.draft.extractionConfidence,
    );
  }
  for (const entry of blockDrafts) {
    const objectId = blockIds.get(entry.draft.localBlockKey);
    if (objectId) appendDerivation(attemptForPage(entry.page), "block", objectId, entry.draft.localBlockKey, null);
    for (const localItemKey of itemLocalKeysByBlock.get(entry.draft.localBlockKey) ?? []) {
      const itemId = itemIds.get(localItemKey);
      if (itemId) appendDerivation(attemptForPage(entry.page), "item", itemId, localItemKey, null);
    }
  }
  for (const entry of recordDrafts) {
    const recordId = recordIds.get(entry.draft.localRecordKey);
    if (!recordId) continue;
    const attempt = attemptForPage(entry.page);
    for (const binding of supportBindings.filter((value) => value.targetObjectId === recordId)) {
      appendDerivation(
        attempt,
        "support_binding",
        binding.supportBindingId,
        `${entry.draft.localRecordKey}:support:${binding.targetFieldPathOrMentionId}`,
        entry.draft.extractionConfidence,
      );
    }
    for (const projection of semanticProjections.filter((value) => value.recordId === recordId)) {
      if (projection.projectionKind === "base") {
        appendDerivation(
          attempt,
          "projection",
          projection.projectionId,
          `${entry.draft.localRecordKey}:projection:base`,
          entry.draft.extractionConfidence,
        );
        continue;
      }
      const resolutionAttempts = resolutionDrafts.filter((candidate) => {
        const resolutionId = resolutionIds.get(candidate.draft.localResolutionKey);
        return resolutionId !== undefined && projection.confirmedResolutionIds.includes(resolutionId);
      });
      for (const resolutionEntry of resolutionAttempts) {
        appendDerivation(
          attemptForPage(resolutionEntry.page),
          "projection",
          projection.projectionId,
          `${entry.draft.localRecordKey}:projection:enriched`,
          entry.draft.extractionConfidence,
        );
      }
    }
  }
  for (const entry of resolutionDrafts) {
    const resolutionId = resolutionIds.get(entry.draft.localResolutionKey);
    if (resolutionId) appendDerivation(
      attemptForPage(entry.page),
      "resolution",
      resolutionId,
      entry.draft.localResolutionKey,
      null,
    );
  }
  for (const entry of blockDrafts) {
    const blockId = blockIds.get(entry.draft.localBlockKey);
    if (!blockId) continue;
    const attempt = attemptForPage(entry.page);
    for (const binding of supportBindings.filter((value) => value.targetObjectId === blockId)) {
      appendDerivation(
        attempt,
        "support_binding",
        binding.supportBindingId,
        `${entry.draft.localBlockKey}:support:${binding.targetFieldPathOrMentionId}`,
        null,
      );
    }
    for (const projection of assistantBlockProjections.filter((value) => value.blockId === blockId)) {
      appendDerivation(
        attempt,
        "projection",
        projection.projectionId,
        `${entry.draft.localBlockKey}:projection`,
        null,
      );
    }
  }
  const coverageRows: CoverageRow[] = [];
  const suppliedCoverageDrafts = pages.flatMap((page) =>
    page.coverageRows.map((draft) => ({ page: page.pageNumber, draft })));
  const suppliedCoverageIds = new Set(suppliedCoverageDrafts.map((entry) => entry.draft.segmentId));
  // Coverage is a mechanical one-row-per-structural-segment ledger. When the
  // model explicitly attached an assistant block to a segment but omitted the
  // redundant coverage row, reconstruct that row from the same draft linkage.
  // Segments with no explicit object linkage remain errors rather than being
  // silently classified as empty.
  const inferredCoverageDrafts = segments.flatMap((segment) => {
    if (suppliedCoverageIds.has(segment.segmentId)) return [];
    const localBlockKeys = blockLocalKeysBySegment.get(segment.segmentId) ?? [];
    if (localBlockKeys.length === 0) return [];
    const page = pages.find((candidate) => candidate.expectedSegmentIds.includes(segment.segmentId));
    if (!page) return [];
    return [{
      page: page.pageNumber,
      draft: {
        segmentId: segment.segmentId,
        routeType: "assistant_block" as const,
        localRecordKeys: [],
        localBlockKeys,
        localObjectKeysExpectedInQuarantine: [],
        reason: "host-reconstructed coverage from explicit assistant-block segment linkage",
      },
    }];
  });
  const coverageDrafts = [...suppliedCoverageDrafts, ...inferredCoverageDrafts];
  const coverageSegmentIds = coverageDrafts.map((entry) => entry.draft.segmentId);
  if (
    coverageSegmentIds.length !== expectedSegmentIds.size
    || new Set(coverageSegmentIds).size !== coverageSegmentIds.length
    || coverageSegmentIds.some((segmentId) => !expectedSegmentIds.has(segmentId))
  ) completionErrors.push("coverage rows do not exactly cover structural segments");
  for (const entry of coverageDrafts) {
    // Coverage keys are redundant references to already validated objects. A
    // model can place a valid key in the wrong typed array; resolve each
    // declared key through the actual materialized namespace. Cross-type key
    // collisions are rejected earlier, so this cannot choose between objects.
    const declaredObjectKeys = [...new Set([
      ...entry.draft.localRecordKeys,
      ...entry.draft.localBlockKeys,
    ])];
    const materializedRecordIds = declaredObjectKeys.flatMap((key) => recordIds.get(key) ?? []);
    const inferredBlockKeys = blockLocalKeysBySegment.get(entry.draft.segmentId) ?? [];
    const routedBlockKeys = [...new Set([
      ...declaredObjectKeys.filter((key) => blockIds.has(key)),
      ...inferredBlockKeys,
    ])];
    const materializedBlockIds = routedBlockKeys.flatMap((key) => blockIds.get(key) ?? []);
    const implicitlyQuarantinedKeys = [
      ...declaredObjectKeys.filter((key) =>
        !recordIds.has(key) && !blockIds.has(key) && quarantineByLocalKey.has(key)),
    ];
    const quarantineIds = [
      ...entry.draft.localObjectKeysExpectedInQuarantine,
      ...implicitlyQuarantinedKeys,
    ].flatMap((key) =>
      quarantineByLocalKey.get(key) ?? [],
    );
    // Route type is redundant with the named, successfully materialized
    // objects. Derive it from those host-resolved IDs so a contradictory model
    // label cannot erase or misroute otherwise valid evidence.
    const effectiveRouteType = quarantineIds.length > 0
      ? "quarantine"
      : materializedRecordIds.length > 0 && materializedBlockIds.length === 0
        ? "semantic"
        : materializedBlockIds.length > 0 && materializedRecordIds.length === 0
          ? "assistant_block"
          : structuralSegmentMap.get(entry.draft.segmentId)?.segmentKind === "blank"
            ? "no_semantic_content"
          : entry.draft.routeType;
    const recordIdValues = effectiveRouteType === "quarantine" ? [] : materializedRecordIds;
    const blockIdValues = effectiveRouteType === "quarantine" ? [] : materializedBlockIds;
    const namedCount = recordIdValues.length + blockIdValues.length + quarantineIds.length;
    const danglingKeys = [
      ...declaredObjectKeys.filter((key) =>
        !recordIds.has(key) && !blockIds.has(key) && !quarantineByLocalKey.has(key)),
      ...entry.draft.localObjectKeysExpectedInQuarantine.filter((key) => !quarantineByLocalKey.has(key)),
    ];
    if (danglingKeys.length > 0) {
      completionErrors.push(`segment ${entry.draft.segmentId} has dangling routed keys: ${danglingKeys.join(",")}`);
    }
    const routeIsConsistent = effectiveRouteType === "no_semantic_content"
      ? namedCount === 0
      : effectiveRouteType === "semantic"
        ? recordIdValues.length > 0 && blockIdValues.length === 0 && quarantineIds.length === 0
        : effectiveRouteType === "assistant_block"
          ? blockIdValues.length > 0 && recordIdValues.length === 0 && quarantineIds.length === 0
          : quarantineIds.length > 0 && recordIdValues.length === 0 && blockIdValues.length === 0;
    if (!routeIsConsistent) completionErrors.push(
      `segment ${entry.draft.segmentId} route ${effectiveRouteType} does not match its materialized objects`,
    );
    coverageRows.push(CoverageRowSchema.parse({
      schemaVersion: 2,
      segmentId: entry.draft.segmentId,
      routeType: effectiveRouteType,
      recordIds: asciiIdSort(recordIdValues),
      blockIds: asciiIdSort(blockIdValues),
      quarantineIds: asciiIdSort(quarantineIds),
      reason: entry.draft.reason,
    }));
  }

  const dedupe = <T>(values: readonly T[], key: (value: T) => string): T[] => {
    const map = new Map<string, T>();
    for (const value of values) {
      const id = key(value);
      const existing = map.get(id);
      if (existing && canonicalJson(jsonValue(existing)) !== canonicalJson(jsonValue(value))) {
        throw new Error(`same ID ${id} has different canonical bytes`);
      }
      map.set(id, value);
    }
    return [...map.values()].sort((left, right) => Buffer.compare(Buffer.from(key(left)), Buffer.from(key(right))));
  };
  const finalQuarantines = dedupe(quarantines, (value) => value.quarantineId);
  if (finalQuarantines.length > 0) completionErrors.push("quarantine backlog is non-empty");
  const allSegmentIds = new Set(pages.flatMap((page) => page.expectedSegmentIds));
  const attemptResults = [...args.attemptsByPage.values()].map((attempt) => {
    const page = pages.find((value) => value.pageNumber === attempt.pageNumber);
    const ownedSegmentIds = new Set(page?.expectedSegmentIds ?? []);
    const ownedLocalKeys = new Set([
      ...mentionsDraft.filter((entry) => entry.page === attempt.pageNumber).map((entry) => entry.draft.localMentionKey),
      ...recordDrafts.filter((entry) => entry.page === attempt.pageNumber).map((entry) => entry.draft.localRecordKey),
      ...blockDrafts.filter((entry) => entry.page === attempt.pageNumber).map((entry) => entry.draft.localBlockKey),
      ...resolutionDrafts.filter((entry) => entry.page === attempt.pageNumber).map((entry) => entry.draft.localResolutionKey),
    ]);
    const pageCoverageIds = pages
      .filter((value) => value.pageNumber === attempt.pageNumber)
      .flatMap((value) => value.coverageRows.map((row) => row.segmentId));
    const pageCoverageMismatch = canonicalJson(pageCoverageIds as JsonValue)
      !== canonicalJson([...(page?.expectedSegmentIds ?? [])] as JsonValue);
    const ownedCompletionErrors = [...new Set([
      ...completionErrors.filter((error) =>
        [...ownedSegmentIds].some((segmentId) => error.includes(segmentId))),
      ...completionErrors.filter((error) => error.startsWith(`page ${String(attempt.pageNumber)} `)),
      ...(pageCoverageMismatch && completionErrors.includes("coverage rows do not exactly cover structural segments")
        ? ["coverage rows do not exactly cover structural segments"]
        : []),
      ...(crossTypeCollisions.some((key) => ownedLocalKeys.has(key))
        ? [`cross-type proposal keys are ambiguous: ${crossTypeCollisions.join(",")}`]
        : []),
    ])].sort();
    const objectIds = asciiIdSort(derivations
      .filter((entry) => entry.attemptId === attempt.attemptId)
      .map((entry) => entry.objectId));
    const quarantineIds = asciiIdSort(finalQuarantines
      .filter((entry) => entry.attemptId === attempt.attemptId)
      .map((entry) => entry.quarantineId));
    const status: AttemptMaterializationResult["status"] = !attempt.outputComplete
      ? "incomplete"
      : quarantineIds.length > 0
        ? "quarantined"
        : ownedCompletionErrors.length > 0
          ? "incomplete"
          : "accepted";
    return createAttemptMaterializationResult({
      attemptId: attempt.attemptId,
      status,
      materializedObjectIds: objectIds,
      quarantineIds,
      completionErrors: ownedCompletionErrors,
      warnings: attempt.warnings,
    });
  });
  return {
    records: dedupe(records, (value) => value.recordId),
    mentions: dedupe(mentions, (value) => value.mentionId),
    supportBindings: dedupe(supportBindings, (value) => value.supportBindingId),
    resolutionAssertions: dedupe(resolutionAssertions, (value) => value.resolutionId),
    semanticProjections: dedupe(semanticProjections, (value) => value.projectionId),
    assistantBlocks: dedupe(assistantBlocks, (value) => value.blockId),
    assistantBlockItems: dedupe(assistantBlockItems, (value) => value.itemId),
    assistantBlockProjections: dedupe(assistantBlockProjections, (value) => value.projectionId),
    sourceSelectors: dedupe(sourceSelectors, (value) => value.selectorId),
    metadataSelectors: dedupe(metadataSelectors, (value) => value.metadataSelectorId),
    quarantines: finalQuarantines,
    coverageRows,
    derivations: dedupe(derivations, (value) => value.derivationId),
    lifecycleEvents: dedupe(lifecycleEvents, (value) => value.lifecycleEventId),
    attemptResults: dedupe(attemptResults, (value) => value.attemptResultId),
    warnings,
    complete: completionErrors.length === 0,
    completionErrors,
  };
}

export function createAttempt(value: Omit<Attempt, "schemaVersion" | "attemptId">): Attempt {
  if (sha256(canonicalJson(value.inputContextManifest)) !== value.inputContextManifestSha256) {
    throw new Error("attempt input-context manifest hash mismatch");
  }
  if (sha256(value.rawProviderOutput) !== value.rawOutputSha256) {
    throw new Error("attempt raw provider output hash mismatch");
  }
  const normalized = { ...value, parentAttemptIds: asciiIdSort(value.parentAttemptIds) };
  const payload = jsonValue(normalized);
  return AttemptSchema.parse({
    schemaVersion: 2,
    attemptId: prefixedId("attempt", "beam.extraction_attempt.v1", payload),
    ...normalized,
  });
}

export function createDerivationOccurrence(
  value: Omit<DerivationOccurrence, "schemaVersion" | "derivationId">,
): DerivationOccurrence {
  const payload = jsonValue(value);
  return DerivationOccurrenceSchema.parse({
    schemaVersion: 2,
    derivationId: prefixedId("derivation", "beam.derivation_occurrence.v1", payload),
    ...value,
  });
}

export function createAttemptMaterializationResult(
  value: Omit<AttemptMaterializationResult, "schemaVersion" | "attemptResultId">,
): AttemptMaterializationResult {
  const payload = {
    ...value,
    materializedObjectIds: asciiIdSort(value.materializedObjectIds),
    quarantineIds: asciiIdSort(value.quarantineIds),
  } satisfies JsonValue;
  return AttemptMaterializationResultSchema.parse({
    schemaVersion: 2,
    attemptResultId: prefixedId("attempt_result", "beam.attempt_materialization_result.v1", payload),
    ...payload,
  });
}

export function createAttemptSupersession(
  value: Omit<AttemptSupersession, "schemaVersion" | "supersessionId">,
): AttemptSupersession {
  const payload = jsonValue(value);
  return AttemptSupersessionSchema.parse({
    schemaVersion: 2,
    supersessionId: prefixedId("supersession", "beam.attempt_supersession.v1", payload),
    ...value,
  });
}

export function createLifecycleEvent(value: Omit<LifecycleEvent, "schemaVersion" | "lifecycleEventId">): LifecycleEvent {
  const judgeIds = asciiIdSort(value.semanticJudgeAttemptIds);
  const judgesAreIndependent = judgeIds.length === 2 && new Set(judgeIds).size === 2;
  const hasIndependentAdjudicator = value.adjudicatorAttemptId !== null
    && !new Set(judgeIds).has(value.adjudicatorAttemptId);
  if (value.basis === "materialization") {
    if (
      value.state !== "accepted"
      || judgeIds.length > 0
      || value.adjudicatorAttemptId !== null
      || value.priorLifecycleEventIds.length !== 0
    ) {
      throw new Error("materialization lifecycle events must be unadjudicated accepted records");
    }
  }
  if (value.basis === "model_challenge") {
    if (
      value.state !== "challenged"
      || judgeIds.length !== 1
      || value.adjudicatorAttemptId !== null
      || value.priorLifecycleEventIds.length !== 1
    ) {
      throw new Error("model challenge requires exactly one semantic judge and no adjudicator");
    }
  }
  if (value.basis === "deterministic_invalidity") {
    if (
      !["invalidated", "projection_gap"].includes(value.state)
      || judgeIds.length > 0
      || value.adjudicatorAttemptId !== null
      || value.priorLifecycleEventIds.length !== 1
    ) throw new Error("deterministic invalidity requires one prior accepted/challenged state and no model lineage");
  }
  if (value.basis === "dual_judge_adjudication" && (
    !["invalidated", "projection_gap"].includes(value.state)
    || !judgesAreIndependent
    || !hasIndependentAdjudicator
    || value.priorLifecycleEventIds.length !== 1
  )) {
    throw new Error("dual-judge adjudication requires one prior state, two distinct semantic judges, and a distinct adjudicator");
  }
  if (value.state === "invalidated") {
    const validBasis = value.basis === "deterministic_invalidity"
      || value.basis === "dual_judge_adjudication";
    if (!validBasis) throw new Error("invalidation requires deterministic invalidity or dual-judge adjudication");
    if (value.replacementRecordIds.length === 0) {
      throw new Error("invalidation without a replacement must use projection_gap state");
    }
  }
  if (value.state === "projection_gap") {
    const validBasis = value.basis === "deterministic_invalidity"
      || value.basis === "dual_judge_adjudication";
    if (!validBasis || value.replacementRecordIds.length > 0) {
      throw new Error("projection_gap requires proven invalidity and no accepted replacement");
    }
  }
  if (value.state === "challenged" && value.basis !== "model_challenge") {
    throw new Error("challenged lifecycle state requires model_challenge basis");
  }
  const normalized = {
    ...value,
    semanticJudgeAttemptIds: judgeIds,
    replacementRecordIds: asciiIdSort(value.replacementRecordIds),
    priorLifecycleEventIds: asciiIdSort(value.priorLifecycleEventIds),
  };
  const payload = jsonValue(normalized);
  return LifecycleEventSchema.parse({
    schemaVersion: 2,
    lifecycleEventId: prefixedId("lifecycle", "beam.lifecycle_event.v1", payload),
    ...normalized,
  });
}

const LifecycleJudgmentOutputSchema = z.object({
  targetRecordId: z.string().min(1),
  targetProjectionId: z.string().min(1),
  priorLifecycleEventIds: z.array(z.string().min(1)),
  lifecycleState: z.enum(["accepted", "challenged", "invalidated", "projection_gap"]),
  reason: z.string().min(1),
}).passthrough();

/** Mechanical lineage validation only; all semantic verdicts remain model-owned. */
export function validateLifecycleLineage(args: {
  events: readonly LifecycleEvent[];
  attempts: readonly Attempt[];
  records: readonly SemanticRecord[];
  projections: readonly SemanticProjection[];
}): void {
  const events = args.events.map((value) => LifecycleEventSchema.parse(value));
  const attempts = new Map(args.attempts.map((value) => {
    const attempt = AttemptSchema.parse(value);
    return [attempt.attemptId, attempt] as const;
  }));
  const records = new Set(args.records.map((value) => SemanticRecordSchema.parse(value).recordId));
  const projections = new Map(args.projections.map((value) => {
    const projection = SemanticProjectionSchema.parse(value);
    return [projection.projectionId, projection] as const;
  }));
  const eventById = new Map(events.map((value) => [value.lifecycleEventId, value]));
  const assertJudgmentBinding = (attempt: Attempt, event: LifecycleEvent, role: "semantic judge" | "adjudicator"): void => {
    if (!attempt.outputComplete) throw new Error(`lifecycle ${role} ${attempt.attemptId} output is incomplete`);
    if (attempt.targetId !== event.recordId) {
      throw new Error(`lifecycle ${role} ${attempt.attemptId} targets the wrong record`);
    }
    const manifest = attempt.inputContextManifest;
    if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
      throw new Error(`lifecycle ${role} ${attempt.attemptId} has no judgment manifest`);
    }
    if (
      manifest.targetRecordId !== event.recordId
      || manifest.targetProjectionId !== event.judgedProjectionId
      || canonicalJson((manifest.priorLifecycleEventIds ?? null) as JsonValue)
        !== canonicalJson(event.priorLifecycleEventIds as JsonValue)
    ) throw new Error(`lifecycle ${role} ${attempt.attemptId} is not bound to the judged record state`);
    const verdict = LifecycleJudgmentOutputSchema.safeParse(attempt.parsedDrafts);
    if (!verdict.success) throw new Error(`lifecycle ${role} ${attempt.attemptId} has no parsed verdict`);
    if (
      verdict.data.targetRecordId !== event.recordId
      || verdict.data.targetProjectionId !== event.judgedProjectionId
      || verdict.data.lifecycleState !== event.state
      || canonicalJson(verdict.data.priorLifecycleEventIds as JsonValue)
        !== canonicalJson(event.priorLifecycleEventIds as JsonValue)
    ) throw new Error(`lifecycle ${role} ${attempt.attemptId} verdict is not bound to the lifecycle event`);
  };
  for (const event of events) {
    if (!records.has(event.recordId)) throw new Error(`lifecycle event targets missing record ${event.recordId}`);
    const judgedProjection = projections.get(event.judgedProjectionId);
    if (!judgedProjection || judgedProjection.recordId !== event.recordId) {
      throw new Error(`lifecycle event ${event.lifecycleEventId} targets an invalid projection`);
    }
    const priorEvents: LifecycleEvent[] = [];
    for (const priorId of event.priorLifecycleEventIds) {
      const prior = eventById.get(priorId);
      if (!prior || prior.recordId !== event.recordId) {
        throw new Error(`lifecycle event ${event.lifecycleEventId} has an invalid prior event`);
      }
      priorEvents.push(prior);
    }
    if (event.state === "accepted") {
      if (event.basis !== "materialization" || priorEvents.length !== 0) {
        throw new Error(`accepted lifecycle event ${event.lifecycleEventId} must be the initial materialization state`);
      }
    } else {
      const prior = priorEvents[0];
      if (priorEvents.length !== 1 || !prior) {
        throw new Error(`lifecycle event ${event.lifecycleEventId} must have exactly one prior state`);
      }
      const allowedPriorStates = event.state === "challenged" ? ["accepted"] : ["accepted", "challenged"];
      if (!allowedPriorStates.includes(prior.state)) {
        throw new Error(`lifecycle event ${event.lifecycleEventId} cannot follow terminal state ${prior.state}`);
      }
    }
    for (const judgeId of event.semanticJudgeAttemptIds) {
      const judge = attempts.get(judgeId);
      if (!judge || judge.trigger !== "semantic_judge") {
        throw new Error(`lifecycle semantic judge ${judgeId} is missing or has the wrong role`);
      }
      assertJudgmentBinding(judge, event, "semantic judge");
    }
    if (event.adjudicatorAttemptId !== null) {
      const adjudicator = attempts.get(event.adjudicatorAttemptId);
      if (!adjudicator || adjudicator.trigger !== "adjudicator") {
        throw new Error(`lifecycle adjudicator ${event.adjudicatorAttemptId} is missing or has the wrong role`);
      }
      assertJudgmentBinding(adjudicator, event, "adjudicator");
      if (canonicalJson(adjudicator.parentAttemptIds as JsonValue)
        !== canonicalJson(event.semanticJudgeAttemptIds as JsonValue)) {
        throw new Error(`lifecycle adjudicator ${event.adjudicatorAttemptId} does not cite exactly the semantic judges`);
      }
    }
    for (const replacementId of event.replacementRecordIds) {
      if (!records.has(replacementId)) {
        throw new Error(`lifecycle replacement record ${replacementId} does not exist`);
      }
    }
  }
}

/**
 * Builds the only searchable semantic membership from immutable lifecycle and
 * projection objects. Semantic judgment stays with the models; this function
 * merely prevents obsolete or non-default bytes from leaking into retrieval.
 */
export function defaultProjectionMembership(args: {
  records: readonly SemanticRecord[];
  projections: readonly SemanticProjection[];
  lifecycleEvents: readonly LifecycleEvent[];
  resolutions?: readonly ResolutionAssertion[];
}): DefaultProjectionMembership[] {
  const records = args.records.map((record) => SemanticRecordSchema.parse(record));
  const recordIds = new Set(records.map((record) => record.recordId));
  const resolutionById = new Map((args.resolutions ?? []).map((value) => {
    const resolution = ResolutionAssertionSchema.parse(value);
    return [resolution.resolutionId, resolution] as const;
  }));
  const projectionsByRecord = new Map<string, SemanticProjection[]>();
  for (const projectionValue of args.projections) {
    const projection = SemanticProjectionSchema.parse(projectionValue);
    const values = projectionsByRecord.get(projection.recordId) ?? [];
    values.push(projection);
    projectionsByRecord.set(projection.recordId, values);
  }
  const lifecycleByRecord = new Map<string, LifecycleEvent[]>();
  for (const eventValue of args.lifecycleEvents) {
    const event = LifecycleEventSchema.parse(eventValue);
    const values = lifecycleByRecord.get(event.recordId) ?? [];
    values.push(event);
    lifecycleByRecord.set(event.recordId, values);
  }
  const terminalByRecord = new Map<string, LifecycleEvent>();
  for (const record of records) {
    const events = lifecycleByRecord.get(record.recordId) ?? [];
    const citedAsPrior = new Set(events.flatMap((event) => event.priorLifecycleEventIds));
    const terminal = events.filter((event) => !citedAsPrior.has(event.lifecycleEventId));
    if (terminal.length !== 1) throw new Error(`record ${record.recordId} must have exactly one terminal lifecycle event`);
    const state = terminal[0];
    if (!state) throw new Error(`record ${record.recordId} lost its lifecycle state`);
    terminalByRecord.set(record.recordId, state);
  }
  for (const [recordId, state] of terminalByRecord) {
    if (state.state === "projection_gap") {
      throw new Error(`record ${recordId} has an unresolved projection_gap`);
    }
    if (state.state === "invalidated") {
      for (const replacementId of state.replacementRecordIds) {
        if (!recordIds.has(replacementId)) throw new Error(`invalidated record ${recordId} has a missing replacement`);
        const replacementState = terminalByRecord.get(replacementId);
        if (!replacementState || !["accepted", "challenged"].includes(replacementState.state)) {
          throw new Error(`invalidated record ${recordId} replacement is not default-active`);
        }
      }
    }
  }
  return records.flatMap((record) => {
    const state = terminalByRecord.get(record.recordId);
    if (!state) throw new Error(`record ${record.recordId} lost its terminal lifecycle state`);
    if (state.state === "invalidated") return [];
    const projections = projectionsByRecord.get(record.recordId) ?? [];
    const base = projections.filter((projection) => projection.projectionKind === "base");
    const enriched = projections.filter((projection) => projection.projectionKind === "enriched");
    if (base.length !== 1 || enriched.length > 1) {
      throw new Error(`record ${record.recordId} has ambiguous base/enriched projection membership`);
    }
    if (enriched[0]) {
      if (enriched[0].baseProjectionId !== base[0]?.projectionId) {
        throw new Error(`record ${record.recordId} enriched projection references the wrong base`);
      }
      for (const resolutionId of enriched[0].confirmedResolutionIds) {
        const resolution = resolutionById.get(resolutionId);
        if (args.resolutions !== undefined && (
          !resolution
          || resolution.targetRecordId !== record.recordId
          || resolution.status !== "confirmed"
        )) throw new Error(`record ${record.recordId} enriched projection references an invalid resolution`);
      }
    }
    const selected = enriched[0] ?? base[0];
    if (!selected) throw new Error(`record ${record.recordId} has no searchable projection`);
    return [DefaultProjectionMembershipSchema.parse({
      schemaVersion: 2,
      recordId: record.recordId,
      projectionId: selected.projectionId,
      projectionKind: selected.projectionKind,
      lifecycleEventId: state.lifecycleEventId,
    })];
  }).sort((left, right) => Buffer.compare(Buffer.from(left.recordId), Buffer.from(right.recordId)));
}

export function materializeTypedLink(coreValue: z.input<typeof TypedLinkCoreSchema>): TypedLink {
  const parsed = TypedLinkCoreSchema.parse(coreValue);
  const symmetricEndpoints = parsed.direction === "symmetric"
    ? [parsed.sourceEndpoint, parsed.targetEndpoint].sort((left, right) =>
      Buffer.compare(Buffer.from(left.endpointId), Buffer.from(right.endpointId)))
    : [parsed.sourceEndpoint, parsed.targetEndpoint];
  const provenanceBasis = parsed.provenanceBasis.map((basis) => ({
    ...basis,
    selectorIds: asciiIdSort(basis.selectorIds),
    metadataSelectorIds: asciiIdSort(basis.metadataSelectorIds),
  })).sort((left, right) => Buffer.compare(
    Buffer.from(canonicalJson(jsonValue(left))),
    Buffer.from(canonicalJson(jsonValue(right))),
  ));
  const sourceEndpoint = symmetricEndpoints[0];
  const targetEndpoint = symmetricEndpoints[1];
  if (!sourceEndpoint || !targetEndpoint) throw new Error("typed link lost an endpoint during canonicalization");
  const core = TypedLinkCoreSchema.parse({
    ...parsed,
    sourceEndpoint,
    targetEndpoint,
    provenanceBasis,
  });
  return TypedLinkSchema.parse({
    ...core,
    linkId: prefixedId("link", "beam.typed_link.v1", jsonValue(core)),
  });
}

export function createLinkGeneration(value: Omit<LinkGenerationMembership, "schemaVersion" | "generationId" | "linkIds"> & { linkIds: readonly string[] }): LinkGenerationMembership {
  const payload = {
    linkIds: asciiIdSort(value.linkIds),
    mapperFreezeSha256: value.mapperFreezeSha256,
    linkerPromptSha256: value.linkerPromptSha256,
    linkerModel: value.linkerModel,
  } satisfies JsonValue;
  return LinkGenerationMembershipSchema.parse({
    schemaVersion: 2,
    generationId: prefixedId("linkgen", "beam.link_generation.v1", payload),
    ...payload,
  });
}
