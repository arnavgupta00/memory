import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

import { z } from "zod";

import {
  LinkAuditOutputSchema,
  LinkerOutputSchema,
  RawTurnSchema,
  StructuralSegmentSchema,
  TypedLinkSchema,
  asciiIdSort,
  canonicalJson,
  decodeModelJsonValue,
  type JsonValue,
  type LinkGenerationMembership,
  type LinkAuditOutput,
  type LinkerOutput,
  type RawTurn,
  type SemanticRecord,
  type StructuralSegment,
  type TypedLink,
} from "./structuredEventSchemaV1.js";
import {
  createLinkGeneration,
  materializeRawTurn,
  materializeTypedLink,
  segmentRawTurn,
} from "./structuredEventMaterializerV1.js";
import {
  LinkFreezeManifestSchema,
  SemanticFreezeManifestSchema,
  type LinkFreezeManifest,
  type SemanticFreezeManifest,
} from "./structuredEventEvaluationV1.js";

/** Keeps only links independently accepted by a complete, index-bound audit. */
export function applyLinkAudit(outputValue: LinkerOutput, auditValue: LinkAuditOutput): LinkerOutput {
  const output = LinkerOutputSchema.parse(outputValue);
  const audit = LinkAuditOutputSchema.parse(auditValue);
  const expectedIndexes = output.links.map((_, index) => index);
  const returnedIndexes = audit.decisions.map((value) => value.linkIndex);
  const returned = new Set(returnedIndexes);
  if (
    audit.decisions.length !== expectedIndexes.length
    || returned.size !== expectedIndexes.length
    || expectedIndexes.some((index) => !returned.has(index))
    || returnedIndexes.some((index) => index >= output.links.length)
  ) throw new Error("link audit did not return exactly one decision per proposed link index");
  const decisionByIndex = new Map(audit.decisions.map((value) => [value.linkIndex, value]));
  return LinkerOutputSchema.parse({
    links: output.links.filter((_, index) => decisionByIndex.get(index)?.accepted === true),
    unresolvedRelations: [
      ...output.unresolvedRelations,
      ...output.links.flatMap((link, index) => {
        const decision = decisionByIndex.get(index);
        if (decision?.accepted === true) return [];
        return [{
          sourceEndpoint: link.sourceEndpoint,
          targetEndpoint: link.targetEndpoint,
          attemptedType: link.type,
          reason: `independent link audit rejected proposal: ${decision?.reason ?? "missing decision"}`,
        }];
      }),
    ],
  });
}

/** Parse one unambiguous clock time from exact endpoint source text. */
export function explicitClockMinutes(texts: readonly string[]): number | null {
  const values = new Set<number>();
  for (const text of texts) {
    for (const match of text.matchAll(/\b(1[0-2]|0?[1-9]):([0-5]\d)\s*([ap])\.?m\.?\b/gi)) {
      const hourValue = Number(match[1]);
      const minute = Number(match[2]);
      const meridiem = match[3]?.toLowerCase();
      if (!Number.isInteger(hourValue) || !Number.isInteger(minute) || !meridiem) continue;
      values.add((hourValue % 12) * 60 + minute + (meridiem === "p" ? 12 * 60 : 0));
    }
  }
  return values.size === 1 ? [...values][0] ?? null : null;
}

/**
 * Conservative active-link floor. The LLM may propose and audit broader
 * relations, but uncertain coreference and temporal edges lacking two exact
 * endpoint clocks remain recoverable unresolved proposals instead of entering
 * the active graph.
 */
export function applyActiveLinkEvidenceFloor(
  outputValue: LinkerOutput,
  endpointClockMinutes: Readonly<Record<string, number | null>>,
): LinkerOutput {
  const output = LinkerOutputSchema.parse(outputValue);
  const accepted: typeof output.links = [];
  const rejected: typeof output.unresolvedRelations = [];
  for (const link of output.links) {
    let reason: string | null = null;
    if (link.status !== "confirmed") {
      reason = "active link evidence floor requires confirmed status";
    } else if (link.type === "BEFORE" || link.type === "AFTER") {
      const source = endpointClockMinutes[link.sourceEndpoint.endpointId] ?? null;
      const target = endpointClockMinutes[link.targetEndpoint.endpointId] ?? null;
      const directionSupported = source !== null && target !== null
        && (link.type === "BEFORE" ? source < target : source > target);
      if (!directionSupported) {
        reason = "active temporal link requires two exact endpoint clocks in the declared direction";
      }
    }
    if (reason === null) accepted.push(link);
    else rejected.push({
      sourceEndpoint: link.sourceEndpoint,
      targetEndpoint: link.targetEndpoint,
      attemptedType: link.type,
      reason,
    });
  }
  return LinkerOutputSchema.parse({
    links: accepted,
    unresolvedRelations: [...output.unresolvedRelations, ...rejected],
  });
}

export type RepeatedTurnSemanticCountMismatch = {
  rawTurnId: string;
  peerRawTurnId: string;
  actualRecordCount: number;
  requiredRecordCount: number;
};

/**
 * Exact duplicate USER turns must retain the same number of occurrence-bound
 * semantic records. This is a lossless occurrence check, not semantic parsing;
 * the repair model still decides what the missing records mean.
 */
export function repeatedTurnSemanticCountMismatches(
  rawTurnsValue: readonly RawTurn[],
  recordsValue: readonly SemanticRecord[],
): RepeatedTurnSemanticCountMismatch[] {
  const rawTurns = rawTurnsValue.map((value) => RawTurnSchema.parse(value));
  const userTurns = rawTurns.filter((turn) => turn.role === "user");
  const countByOccurrence = new Map(userTurns.map((turn) => [
    `${String(turn.sessionOrdinal)}\0${String(turn.turnOrdinal)}`,
    recordsValue.filter((record) =>
      record.stance.sourceSpeakerRole === "user"
      && record.temporal.sessionOrdinal === turn.sessionOrdinal
      && record.temporal.turnOrdinal === turn.turnOrdinal).length,
  ]));
  const byContent = new Map<string, RawTurn[]>();
  for (const turn of userTurns) {
    const values = byContent.get(turn.contentSha256) ?? [];
    values.push(turn);
    byContent.set(turn.contentSha256, values);
  }
  const output: RepeatedTurnSemanticCountMismatch[] = [];
  for (const occurrences of byContent.values()) {
    if (occurrences.length < 2) continue;
    const count = (turn: RawTurn): number => countByOccurrence.get(
      `${String(turn.sessionOrdinal)}\0${String(turn.turnOrdinal)}`,
    ) ?? 0;
    const required = Math.max(...occurrences.map(count));
    const peer = occurrences.find((turn) => count(turn) === required);
    if (!peer) continue;
    for (const turn of occurrences) {
      if (count(turn) >= required) continue;
      output.push({
        rawTurnId: turn.rawTurnId,
        peerRawTurnId: peer.rawTurnId,
        actualRecordCount: count(turn),
        requiredRecordCount: required,
      });
    }
  }
  return output;
}

export const ConversationTurnSchema = z.strictObject({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

export const StructuredConversationInputSchema = z.strictObject({
  conversationId: z.union([z.string(), z.number()]),
  sessionIds: z.array(z.string().min(1)),
  sessionDates: z.array(z.string()),
  sessions: z.array(z.array(ConversationTurnSchema)),
});
export type StructuredConversationInput = z.infer<typeof StructuredConversationInputSchema>;

export type PreparedSession = {
  hostSessionId: string;
  opaqueSessionId: string;
  sessionOrdinal: number;
  sessionDate: string;
  rawTurns: RawTurn[];
  segments: StructuralSegment[];
};

export function assertAppendCompatible(previous: readonly RawTurn[], next: readonly RawTurn[]): void {
  const priorByHostTurn = new Map(previous.map((turn) => [
    `${turn.archiveId}\0${turn.hostConversationId}\0${turn.hostSessionId}\0${turn.hostTurnId}`,
    turn,
  ]));
  for (const turn of next) {
    const key = `${turn.archiveId}\0${turn.hostConversationId}\0${turn.hostSessionId}\0${turn.hostTurnId}`;
    const prior = priorByHostTurn.get(key);
    if (!prior) continue;
    if (canonicalJson(prior as unknown as JsonValue) !== canonicalJson(turn as unknown as JsonValue)) {
      throw new Error(`immutable host turn version conflict: ${turn.hostTurnId}`);
    }
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Stable keyed opaque handle; append order cannot renumber prior sessions. */
export function opaqueSessionHandle(hostSessionId: string, key: Buffer): string {
  if (key.length < 32) throw new Error("opaque handle key must have at least 32 bytes");
  const digest = createHmac("sha256", key).update(hostSessionId).digest("hex");
  const decimal = (BigInt(`0x${digest.slice(0, 15)}`) % 1_000_000_000_000_000n).toString();
  return `memory_${decimal.padStart(15, "0")}`;
}

export function prepareConversation(args: {
  archiveId: string;
  input: StructuredConversationInput;
  opaqueHandleKey: Buffer;
  transportArtifactSha256?: string | null;
  maximumStructuralSegmentBytes?: number;
}): PreparedSession[] {
  const input = StructuredConversationInputSchema.parse(args.input);
  if (input.sessionIds.length !== input.sessions.length || input.sessionDates.length !== input.sessions.length) {
    throw new Error("conversation session arrays are misaligned");
  }
  const handles = new Set<string>();
  const prepared = input.sessions.map((turns, sessionOrdinal) => {
    const hostSessionId = input.sessionIds[sessionOrdinal];
    const sessionDate = input.sessionDates[sessionOrdinal];
    if (hostSessionId === undefined || sessionDate === undefined) throw new Error("missing session metadata");
    const opaqueSessionId = opaqueSessionHandle(hostSessionId, args.opaqueHandleKey);
    if (handles.has(opaqueSessionId)) throw new Error("opaque session handle collision");
    handles.add(opaqueSessionId);
    const rawTurns = turns.map((turn, turnOrdinal) => materializeRawTurn({
      archiveId: args.archiveId,
      hostConversationId: String(input.conversationId),
      hostSessionId,
      hostTurnId: `${hostSessionId}:turn:${String(turnOrdinal)}`,
      role: turn.role,
      rawTimestamp: sessionDate || null,
      sessionOrdinal,
      turnOrdinal,
      content: turn.content,
      transportArtifactSha256: args.transportArtifactSha256 ?? null,
    }));
    return {
      hostSessionId,
      opaqueSessionId,
      sessionOrdinal,
      sessionDate,
      rawTurns,
      segments: rawTurns.flatMap((turn) => segmentRawTurn(turn, args.maximumStructuralSegmentBytes)),
    };
  });
  const allTurns = prepared.flatMap((session) => session.rawTurns);
  assertAppendCompatible([], allTurns);
  const duplicateHostKeys = allTurns.map((turn) =>
    `${turn.archiveId}\0${turn.hostConversationId}\0${turn.hostSessionId}\0${turn.hostTurnId}`,
  );
  if (new Set(duplicateHostKeys).size !== duplicateHostKeys.length) {
    throw new Error("conversation contains duplicate immutable host-turn keys");
  }
  return prepared;
}

export function modelSession(session: PreparedSession): Record<string, unknown> {
  return {
    sessionId: session.opaqueSessionId,
    sessionDate: session.sessionDate,
    sessionOrdinal: session.sessionOrdinal,
    turns: session.rawTurns.map((turn) => ({
      rawTurnId: turn.rawTurnId,
      turnOrdinal: turn.turnOrdinal,
      role: turn.role,
      rawTimestamp: turn.rawTimestamp,
      content: turn.content,
    })),
  };
}

export type SegmentPage = {
  pageNumber: number;
  pageCount: number;
  expectedSegmentIds: string[];
  segments: Array<{
    segmentId: string;
    rawTurnId: string;
    segmentKind: StructuralSegment["segmentKind"];
    ordinal: number;
    byteStart: number;
    byteEnd: number;
    exactUtf8: string;
  }>;
};

export function pageSessionSegments(session: PreparedSession, maxSegmentsPerPage: number): SegmentPage[] {
  if (!Number.isInteger(maxSegmentsPerPage) || maxSegmentsPerPage <= 0 || maxSegmentsPerPage > 128) {
    throw new Error("maxSegmentsPerPage must be in [1, 128]");
  }
  const turnMap = new Map(session.rawTurns.map((turn) => [turn.rawTurnId, turn]));
  const groups: StructuralSegment[][] = [];
  for (let index = 0; index < session.segments.length; index += maxSegmentsPerPage) {
    groups.push(session.segments.slice(index, index + maxSegmentsPerPage));
  }
  if (groups.length === 0) groups.push([]);
  return groups.map((segments, index) => ({
    pageNumber: index + 1,
    pageCount: groups.length,
    expectedSegmentIds: segments.map((segment) => segment.segmentId),
    segments: segments.map((segment) => {
      const turn = turnMap.get(segment.rawTurnId);
      if (!turn) throw new Error(`segment ${segment.segmentId} lost its raw turn`);
      const exactUtf8 = Buffer.from(turn.content, "utf8")
        .subarray(segment.byteStart, segment.byteEnd)
        .toString("utf8");
      return {
        segmentId: segment.segmentId,
        rawTurnId: segment.rawTurnId,
        segmentKind: segment.segmentKind,
        ordinal: segment.ordinal,
        byteStart: segment.byteStart,
        byteEnd: segment.byteEnd,
        exactUtf8,
      };
    }),
  }));
}

/** Host-only adaptive paging policy used after an incomplete mapper output. */
export function nextAdaptivePageSize(current: number): number | null {
  if (!Number.isInteger(current) || current <= 0 || current > 128) {
    throw new Error("current page size must be in [1, 128]");
  }
  return current === 1 ? null : Math.max(1, Math.floor(current / 2));
}

/** Provider/account failures cannot be repaired by changing semantic page size. */
export function isTerminalProviderFailure(message: string | null): boolean {
  if (message === null) return false;
  return /(?:no credits remaining|insufficient[_ ]quota|billing|invalid api key|incorrect api key|authentication|unauthorized|forbidden|organization.*(?:disabled|deactivated))/i
    .test(message);
}

export async function runAdaptivePageRounds<TPage, TResult>(args: {
  initialPageSize: number;
  buildPages: (pageSize: number) => readonly TPage[];
  callRound: (pages: readonly TPage[], round: number) => Promise<readonly TResult[]>;
  isComplete: (result: TResult) => boolean;
}): Promise<{
  pageSize: number;
  pages: readonly TPage[];
  results: readonly TResult[];
  rounds: number;
}> {
  let pageSize = args.initialPageSize;
  let rounds = 0;
  while (true) {
    rounds += 1;
    const pages = args.buildPages(pageSize);
    const results = await args.callRound(pages, rounds);
    if (results.length !== pages.length) throw new Error("adaptive mapper round did not return one result per page");
    if (results.every(args.isComplete)) return { pageSize, pages, results, rounds };
    const next = nextAdaptivePageSize(pageSize);
    if (next === null) return { pageSize, pages, results, rounds };
    pageSize = next;
  }
}

export function modelPageSession(
  session: PreparedSession,
  page: SegmentPage,
  adjacentSegmentCount = 1,
): Record<string, unknown> {
  const pageIds = new Set(page.expectedSegmentIds);
  const indexes = session.segments.flatMap((segment, index) => pageIds.has(segment.segmentId) ? [index] : []);
  if (indexes.length !== page.expectedSegmentIds.length || indexes.length === 0) {
    throw new Error("page context segment manifest does not match prepared session");
  }
  const minimum = Math.max(0, Math.min(...indexes) - adjacentSegmentCount);
  const maximum = Math.min(session.segments.length, Math.max(...indexes) + adjacentSegmentCount + 1);
  const selected = session.segments.slice(minimum, maximum);
  const turnMap = new Map(session.rawTurns.map((turn) => [turn.rawTurnId, turn]));
  return {
    sessionId: session.opaqueSessionId,
    sessionDate: session.sessionDate,
    sessionOrdinal: session.sessionOrdinal,
    pageNumber: page.pageNumber,
    excerpts: selected.map((segment) => {
      const turn = turnMap.get(segment.rawTurnId);
      if (!turn) throw new Error(`page context lost raw turn ${segment.rawTurnId}`);
      return {
        rawTurnId: turn.rawTurnId,
        turnOrdinal: turn.turnOrdinal,
        role: turn.role,
        rawTimestamp: turn.rawTimestamp,
        segmentId: segment.segmentId,
        byteStart: segment.byteStart,
        byteEnd: segment.byteEnd,
        exactUtf8: Buffer.from(turn.content, "utf8").subarray(segment.byteStart, segment.byteEnd).toString("utf8"),
        isTargetSegment: pageIds.has(segment.segmentId),
      };
    }),
  };
}

function artifact(path: string): { path: string; sha256: string; byteLength: number } {
  const bytes = readFileSync(path);
  return { path, sha256: sha256(bytes), byteLength: bytes.length };
}

export function createSemanticFreezeManifest(args: {
  specificationSha256: string;
  codeSha256: string;
  schemaSha256: string;
  configurationSha256: string;
  promptSha256s: string[];
  artifactPaths: string[];
  createdAt: string;
  mapperComplete: boolean;
}): SemanticFreezeManifest {
  if (!args.mapperComplete) throw new Error("incomplete semantic materialization cannot freeze");
  return SemanticFreezeManifestSchema.parse({
    schemaVersion: 1,
    status: "complete",
    specificationSha256: args.specificationSha256,
    codeSha256: args.codeSha256,
    schemaSha256: args.schemaSha256,
    configurationSha256: args.configurationSha256,
    promptSha256s: asciiIdSort(args.promptSha256s),
    artifacts: args.artifactPaths.map(artifact).sort((left, right) =>
      Buffer.compare(Buffer.from(left.path), Buffer.from(right.path))),
    createdAt: args.createdAt,
    questionBlind: true,
  });
}

export function materializeLinkerOutputs(args: {
  outputs: readonly LinkerOutput[];
  allowedEndpointIds: ReadonlySet<string>;
  allowedSelectorIds: ReadonlySet<string>;
  allowedMetadataSelectorIds: ReadonlySet<string>;
}): TypedLink[] {
  const links: TypedLink[] = [];
  for (const outputValue of args.outputs) {
    const output = LinkerOutputSchema.parse(outputValue);
    for (const draft of output.links) {
      if (
        !args.allowedEndpointIds.has(draft.sourceEndpoint.endpointId)
        || !args.allowedEndpointIds.has(draft.targetEndpoint.endpointId)
      ) throw new Error("linker referenced an endpoint outside the semantic freeze");
      for (const basis of draft.provenanceBasis) {
        if (basis.selectorIds.some((id) => !args.allowedSelectorIds.has(id))) {
          throw new Error("linker referenced a selector outside the semantic freeze");
        }
        if (basis.metadataSelectorIds.some((id) => !args.allowedMetadataSelectorIds.has(id))) {
          throw new Error("linker referenced metadata outside the semantic freeze");
        }
      }
      links.push(materializeTypedLink({
        schemaVersion: 2,
        ...draft,
        effectiveTime: {
          ...draft.effectiveTime,
          value: draft.effectiveTime.value === null ? null : decodeModelJsonValue(draft.effectiveTime.value),
        },
        provenanceBasis: draft.provenanceBasis.map((basis) => ({
          ...basis,
          parsedValue: basis.parsedValue === null ? null : decodeModelJsonValue(basis.parsedValue),
        })),
      }));
    }
  }
  const byId = new Map<string, TypedLink>();
  for (const link of links) {
    const prior = byId.get(link.linkId);
    if (prior && canonicalJson(prior as unknown as JsonValue) !== canonicalJson(link as unknown as JsonValue)) {
      throw new Error(`same link ID ${link.linkId} has different bytes`);
    }
    byId.set(link.linkId, TypedLinkSchema.parse(link));
  }
  return [...byId.values()].sort((left, right) => Buffer.compare(Buffer.from(left.linkId), Buffer.from(right.linkId)));
}

export function createLinkFreezeManifest(args: {
  semanticFreezePath: string;
  linkerPromptPath: string;
  artifactPaths: string[];
  createdAt: string;
}): LinkFreezeManifest {
  return LinkFreezeManifestSchema.parse({
    schemaVersion: 1,
    status: "complete",
    semanticFreezeSha256: sha256(readFileSync(args.semanticFreezePath)),
    linkerPromptSha256: sha256(readFileSync(args.linkerPromptPath)),
    artifacts: args.artifactPaths.map(artifact).sort((left, right) =>
      Buffer.compare(Buffer.from(left.path), Buffer.from(right.path))),
    createdAt: args.createdAt,
    questionBlind: true,
  });
}

export function linkGeneration(args: {
  links: readonly TypedLink[];
  mapperFreezeSha256: string;
  linkerPromptSha256: string;
  linkerModel: string;
}): LinkGenerationMembership {
  return createLinkGeneration({
    linkIds: args.links.map((link) => link.linkId),
    mapperFreezeSha256: args.mapperFreezeSha256,
    linkerPromptSha256: args.linkerPromptSha256,
    linkerModel: args.linkerModel,
  });
}

export function parsePreparedRawTurns(value: unknown): RawTurn[] {
  return z.array(RawTurnSchema).parse(value);
}

export function parseStructuralSegments(value: unknown): StructuralSegment[] {
  return z.array(StructuralSegmentSchema).parse(value);
}
