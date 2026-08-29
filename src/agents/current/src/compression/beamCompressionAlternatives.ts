import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  DiscoverySession,
  DiscoveryUnion,
  RecertifiedOracleEntry,
} from "./beamCompression.js";

const OPAQUE_SESSION_ID = /^memory_[0-9]{3,}$/;
const OBLIGATION_ID = /^[a-z][a-z0-9_]*$/;

export const ConservativeRouterOutputSchema = z.strictObject({
  directSafeToDrop: z.array(z.string().regex(OPAQUE_SESSION_ID)).max(512),
  contextualSafeToDrop: z.array(z.string().regex(OPAQUE_SESSION_ID)).max(512),
});
export type ConservativeRouterOutput = z.infer<typeof ConservativeRouterOutputSchema>;

export const SourcePointerSchema = z.strictObject({
  sessionId: z.string().regex(OPAQUE_SESSION_ID),
  turnStart: z.number().int().nonnegative(),
  turnEnd: z.number().int().nonnegative(),
  keepWholeSession: z.boolean(),
});
export type SourcePointer = z.infer<typeof SourcePointerSchema>;

export const StoryCompilerOutputSchema = z.strictObject({
  storyBranches: z.array(z.strictObject({
    label: z.string().min(1).max(500),
    purpose: z.string().min(1).max(1_000),
    sourcePointers: z.array(SourcePointerSchema).min(1).max(96),
  })).min(1).max(32),
  unresolvedCoverage: z.array(z.string().min(1).max(1_000)).max(24),
});
export type StoryCompilerOutput = z.infer<typeof StoryCompilerOutputSchema>;

export const CoverageLedgerSchema = z.strictObject({
  obligations: z.array(z.strictObject({
    id: z.string().regex(OBLIGATION_ID),
    description: z.string().min(1).max(1_000),
    evidenceShapes: z.array(z.string().min(1).max(500)).min(1).max(12),
    completionRule: z.string().min(1).max(1_000),
  })).min(1).max(32),
  adversarialChecks: z.array(z.string().min(1).max(800)).min(1).max(24),
});
export type CoverageLedger = z.infer<typeof CoverageLedgerSchema>;

const ExplorerPointerSchema = SourcePointerSchema.extend({
  obligationIds: z.array(z.string().regex(OBLIGATION_ID)).max(16),
  routingLabel: z.string().min(1).max(500),
  confidence: z.enum(["high", "medium", "low"]),
});
export type ExplorerPointer = z.infer<typeof ExplorerPointerSchema>;

export const ShardScoutOutputSchema = z.strictObject({
  sourcePointers: z.array(ExplorerPointerSchema).max(128),
  observedObligationIds: z.array(z.string().regex(OBLIGATION_ID)).max(32),
  uncertainObligationIds: z.array(z.string().regex(OBLIGATION_ID)).max(32),
});
export type ShardScoutOutput = z.infer<typeof ShardScoutOutputSchema>;

export const CoverageAuditOutputSchema = z.strictObject({
  satisfiedObligationIds: z.array(z.string().regex(OBLIGATION_ID)).max(32),
  missingObligations: z.array(z.strictObject({
    obligationId: z.string().regex(OBLIGATION_ID),
    searchHints: z.array(z.string().min(1).max(200)).min(1).max(12),
  })).max(32),
  repairShardIndexes: z.array(z.number().int().nonnegative()).max(16),
  coverageComplete: z.boolean(),
});
export type CoverageAuditOutput = z.infer<typeof CoverageAuditOutputSchema>;

export type DiscoveryShard = {
  index: number;
  sessions: DiscoverySession[];
  estimatedTokens: number;
};

function sessionTokenEstimate(session: DiscoverySession): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify({
    sessionId: session.opaqueSessionId,
    date: session.date,
    turns: session.turns,
  }), "utf8") / 3);
}

/** Pack whole sessions without truncation. Oversized sessions remain intact alone. */
export function shardDiscoverySessions(
  sessions: DiscoverySession[],
  tokenBudget: number,
): DiscoveryShard[] {
  if (!(tokenBudget > 0)) throw new Error("shard token budget must be positive");
  const shards: DiscoveryShard[] = [];
  let current: DiscoverySession[] = [];
  let currentTokens = 0;
  for (const session of sessions) {
    const tokens = sessionTokenEstimate(session);
    if (current.length > 0 && currentTokens + tokens > tokenBudget) {
      shards.push({ index: shards.length, sessions: current, estimatedTokens: currentTokens });
      current = [];
      currentTokens = 0;
    }
    current.push(session);
    currentTokens += tokens;
  }
  if (current.length > 0) {
    shards.push({ index: shards.length, sessions: current, estimatedTokens: currentTokens });
  }
  return shards;
}

export function formatAlternativeSessions(sessions: DiscoverySession[]): string {
  return JSON.stringify(sessions.map((session) => ({
    sessionId: session.opaqueSessionId,
    date: session.date,
    turns: session.turns.map((turn, turnIndex) => ({
      turnIndex,
      role: turn.role,
      content: turn.content,
    })),
  })));
}

export type RawEvidenceSegment = {
  sessionId: string;
  realSessionId: string;
  date: string;
  turnStart: number;
  turnEnd: number;
  turns: DiscoverySession["turns"];
};

export type RawEvidencePackage = {
  segments: RawEvidenceSegment[];
  representedRealSessionIds: string[];
  representedTurnKeys: string[];
  invalidPointers: Array<{ pointer: SourcePointer; reason: string }>;
  failOpen: boolean;
  rawCharacters: number;
  estimatedTokens: number;
};

function fullDiscoveryPackage(
  discovery: DiscoveryUnion,
  invalidPointers: RawEvidencePackage["invalidPointers"] = [],
): RawEvidencePackage {
  const segments = discovery.sessions.flatMap((session) => {
    if (session.turns.length === 0) return [];
    return [{
      sessionId: session.opaqueSessionId,
      realSessionId: session.realSessionId,
      date: session.date,
      turnStart: 0,
      turnEnd: session.turns.length - 1,
      turns: session.turns,
    }];
  });
  return assembleRawPackage(segments, invalidPointers, true);
}

function assembleRawPackage(
  segments: RawEvidenceSegment[],
  invalidPointers: RawEvidencePackage["invalidPointers"],
  failOpen: boolean,
): RawEvidencePackage {
  const representedTurnKeys = [...new Set(segments.flatMap((segment) =>
    segment.turns.map((_turn, offset) =>
      `${segment.realSessionId}\0${String(segment.turnStart + offset)}`,
    ),
  ))];
  const rawCharacters = segments.reduce((sum, segment) =>
    sum + segment.turns.reduce((turnSum, turn) => turnSum + turn.content.length, 0),
  0);
  return {
    segments,
    representedRealSessionIds: [...new Set(segments.map((segment) => segment.realSessionId))],
    representedTurnKeys,
    invalidPointers,
    failOpen,
    rawCharacters,
    estimatedTokens: Math.ceil(rawCharacters / 4),
  };
}

export function materializeRetainedSessions(
  discovery: DiscoveryUnion,
  retainedOpaqueIds: Iterable<string>,
): RawEvidencePackage {
  const retained = new Set(retainedOpaqueIds);
  const segments = discovery.sessions.flatMap((session) => {
    if (!retained.has(session.opaqueSessionId) || session.turns.length === 0) return [];
    return [{
      sessionId: session.opaqueSessionId,
      realSessionId: session.realSessionId,
      date: session.date,
      turnStart: 0,
      turnEnd: session.turns.length - 1,
      turns: session.turns,
    }];
  });
  return assembleRawPackage(segments, [], false);
}

/** Drop only when both independently requested routing lenses agree. */
export function applyConservativeRouter(
  discovery: DiscoveryUnion,
  outputs: ConservativeRouterOutput[],
): RawEvidencePackage {
  const known = new Set(discovery.sessions.map((session) => session.opaqueSessionId));
  const direct = new Set(outputs.flatMap((output) => output.directSafeToDrop).filter((id) => known.has(id)));
  const contextual = new Set(
    outputs.flatMap((output) => output.contextualSafeToDrop).filter((id) => known.has(id)),
  );
  const retained = discovery.sessions
    .map((session) => session.opaqueSessionId)
    .filter((id) => !(direct.has(id) && contextual.has(id)));
  return materializeRetainedSessions(discovery, retained);
}

/**
 * Dereference model-produced coordinates. Generated prose is never evidence.
 * Invalid coordinates fail open to the complete union, making a mechanical
 * failure visible as a compression failure rather than silent evidence loss.
 */
export function materializeSourcePointers(args: {
  discovery: DiscoveryUnion;
  pointers: SourcePointer[];
  haloTurns?: number;
  failOpenOnInvalid?: boolean;
}): RawEvidencePackage {
  const halo = args.haloTurns ?? 2;
  const byOpaque = new Map(args.discovery.sessions.map((session) => [session.opaqueSessionId, session]));
  const invalidPointers: RawEvidencePackage["invalidPointers"] = [];
  const ranges = new Map<string, Array<{ start: number; end: number; whole: boolean }>>();
  for (const pointer of args.pointers) {
    const session = byOpaque.get(pointer.sessionId);
    if (!session) {
      invalidPointers.push({ pointer, reason: "unknown_session" });
      continue;
    }
    if (pointer.keepWholeSession) {
      const prior = ranges.get(pointer.sessionId) ?? [];
      prior.push({
        start: 0,
        end: Math.max(0, session.turns.length - 1),
        whole: true,
      });
      ranges.set(pointer.sessionId, prior);
      continue;
    }
    if (
      pointer.turnStart > pointer.turnEnd
      || pointer.turnStart >= session.turns.length
      || pointer.turnEnd >= session.turns.length
    ) {
      invalidPointers.push({ pointer, reason: "invalid_turn_range" });
      continue;
    }
    const prior = ranges.get(pointer.sessionId) ?? [];
    prior.push({
      start: Math.max(0, pointer.turnStart - halo),
      end: Math.min(session.turns.length - 1, pointer.turnEnd + halo),
      whole: false,
    });
    ranges.set(pointer.sessionId, prior);
  }
  if (invalidPointers.length > 0 && (args.failOpenOnInvalid ?? true)) {
    return fullDiscoveryPackage(args.discovery, invalidPointers);
  }

  const segments: RawEvidenceSegment[] = [];
  for (const [sessionId, rawRanges] of ranges) {
    const session = byOpaque.get(sessionId);
    if (!session || session.turns.length === 0) continue;
    const sorted = rawRanges.sort((left, right) => left.start - right.start || left.end - right.end);
    const merged: Array<{ start: number; end: number }> = [];
    for (const range of sorted) {
      const prior = merged.at(-1);
      if (prior && range.start <= prior.end + 1) prior.end = Math.max(prior.end, range.end);
      else merged.push({ start: range.start, end: range.end });
    }
    const selectedTurnCount = merged.reduce((sum, range) => sum + range.end - range.start + 1, 0);
    const upgrade = rawRanges.some((range) => range.whole)
      || merged.length > 2
      || selectedTurnCount > 8;
    if (upgrade) {
      segments.push({
        sessionId,
        realSessionId: session.realSessionId,
        date: session.date,
        turnStart: 0,
        turnEnd: session.turns.length - 1,
        turns: session.turns,
      });
      continue;
    }
    for (const range of merged) {
      segments.push({
        sessionId,
        realSessionId: session.realSessionId,
        date: session.date,
        turnStart: range.start,
        turnEnd: range.end,
        turns: session.turns.slice(range.start, range.end + 1),
      });
    }
  }
  segments.sort((left, right) =>
    left.date.localeCompare(right.date)
    || left.sessionId.localeCompare(right.sessionId)
    || left.turnStart - right.turnStart,
  );
  return assembleRawPackage(segments, invalidPointers, false);
}

export function evaluateRawEvidenceCoverage(
  pkg: RawEvidencePackage,
  oracle: RecertifiedOracleEntry,
): {
  coveredAtoms: number;
  totalAtoms: number;
  atomRecall: number;
  fullStory: boolean;
  uncoveredAtomIds: string[];
  goldSessionsRepresented: number;
  goldSessionsTotal: number;
} {
  const representedTurns = new Set(pkg.representedTurnKeys);
  const uncoveredAtomIds: string[] = [];
  let coveredAtoms = 0;
  for (const atom of oracle.evidence_atoms) {
    const covered = atom.sources.some((source) =>
      representedTurns.has(`${source.session_id}\0${String(source.turn_index)}`),
    );
    if (covered) coveredAtoms += 1;
    else uncoveredAtomIds.push(atom.atom_id);
  }
  const goldSessions = new Set(
    oracle.evidence_atoms.flatMap((atom) => atom.sources.map((source) => source.session_id)),
  );
  const represented = new Set(pkg.representedRealSessionIds);
  return {
    coveredAtoms,
    totalAtoms: oracle.evidence_atoms.length,
    atomRecall: oracle.evidence_atoms.length === 0 ? 1 : coveredAtoms / oracle.evidence_atoms.length,
    fullStory: uncoveredAtomIds.length === 0,
    uncoveredAtomIds,
    goldSessionsRepresented: [...goldSessions].filter((id) => represented.has(id)).length,
    goldSessionsTotal: goldSessions.size,
  };
}

export function discoveryCharacterCount(discovery: DiscoveryUnion): number {
  return discovery.sessions.reduce((sum, session) =>
    sum + session.turns.reduce((turnSum, turn) => turnSum + turn.content.length, 0),
  0);
}

export function explorerPointers(outputs: ShardScoutOutput[]): SourcePointer[] {
  return outputs.flatMap((output) => output.sourcePointers.map((pointer) => ({
    sessionId: pointer.sessionId,
    turnStart: pointer.turnStart,
    turnEnd: pointer.turnEnd,
    keepWholeSession: pointer.keepWholeSession,
  })));
}

export function shardCatalog(shards: DiscoveryShard[]): string {
  const stop = new Set([
    "about", "after", "again", "also", "and", "are", "because", "been", "before", "being",
    "but", "can", "could", "did", "does", "for", "from", "had", "has", "have", "into",
    "just", "more", "not", "that", "the", "their", "them", "then", "there", "they", "this",
    "was", "were", "what", "when", "where", "which", "with", "would", "you", "your",
  ]);
  return JSON.stringify(shards.map((shard) => {
    const counts = new Map<string, number>();
    for (const session of shard.sessions) {
      for (const turn of session.turns) {
        for (const token of turn.content.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []) {
          if (stop.has(token)) continue;
          counts.set(token, (counts.get(token) ?? 0) + 1);
        }
      }
    }
    const keywords = [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 24)
      .map(([token]) => token);
    return {
      shardIndex: shard.index,
      sessionCount: shard.sessions.length,
      firstDate: shard.sessions.at(0)?.date ?? "",
      lastDate: shard.sessions.at(-1)?.date ?? "",
      keywords,
    };
  }));
}

export function packageSha256(pkg: RawEvidencePackage): string {
  return createHash("sha256").update(JSON.stringify(pkg.segments)).digest("hex");
}
