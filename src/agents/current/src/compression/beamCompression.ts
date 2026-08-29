import { createHash } from "node:crypto";

import { z } from "zod";

import type { ArchitectureCase, ArchitectureTurn } from "../benchmarks/architectureDataset.js";
import { buildOpaqueSessionSpace } from "../retrieval/opaqueSessionIds.js";

export const CompressionPlanSchema = z.strictObject({
  questionMode: z.enum([
    "lookup",
    "update",
    "contradiction",
    "temporal",
    "aggregate",
    "timeline",
    "summary",
    "instruction",
    "preference",
    "absence",
    "other",
  ]),
  answerContract: z.string().min(1).max(4_000),
  storyBranches: z.array(z.strictObject({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    description: z.string().min(1).max(1_000),
    evidenceNeeded: z.array(z.string().min(1).max(500)).min(1).max(12),
  })).max(32),
  evidenceFacets: z.array(z.strictObject({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    priority: z.enum(["must", "should"]),
    description: z.string().min(1).max(1_000),
    evidenceShapes: z.array(z.string().min(1).max(500)).min(1).max(12),
    completionRule: z.string().min(1).max(1_000),
  })).min(1).max(40),
  crossSessionOperations: z.array(z.enum([
    "none",
    "deduplicate_restatements",
    "preserve_contradictions",
    "resolve_updates_by_date",
    "construct_timeline",
    "aggregate_distinct_members",
    "compare_endpoints",
  ])).max(12),
  workerInstructions: z.array(z.string().min(1).max(800)).min(1).max(16),
  novelEvidencePolicy: z.string().min(1).max(1_500),
  coverageChecklist: z.array(z.string().min(1).max(800)).min(1).max(40),
});

export type CompressionPlan = z.infer<typeof CompressionPlanSchema>;

const WorkerClaimSchema = z.strictObject({
  turnIndex: z.number().int().nonnegative(),
  verbatimQuote: z.string().min(1).max(6_000),
  normalizedFact: z.string().min(1).max(2_000),
  facetIds: z.array(z.string()).max(12),
  storyBranchIds: z.array(z.string()).max(12),
  evidenceKind: z.enum([
    "direct_fact",
    "event",
    "date",
    "quantity",
    "preference",
    "instruction",
    "prior_state",
    "updated_state",
    "contradiction",
    "constraint",
    "negative_evidence",
    "other",
  ]),
  whyNeeded: z.string().min(1).max(1_000),
  confidence: z.enum(["high", "medium", "low"]),
  unplannedNovelEvidence: z.boolean(),
});

export const CompressionWorkerSchema = z.strictObject({
  sessionResults: z.array(z.strictObject({
    sessionId: z.string().regex(/^memory_[0-9]{3,}$/),
    disposition: z.enum(["relevant", "uncertain", "not_relevant"]),
    claims: z.array(WorkerClaimSchema).max(48),
  })).min(1).max(8),
});

export type CompressionWorkerOutput = z.infer<typeof CompressionWorkerSchema>;

export type DiscoverySession = {
  realSessionId: string;
  opaqueSessionId: string;
  date: string;
  turns: ArchitectureTurn[];
  hitCount: number;
  bestRank: number;
  retrievalFamilies: Array<"sparse" | "dense">;
  retrievalStages: Array<"initial" | "follow_up">;
};

export type DiscoveryUnion = {
  questionId: string;
  sessions: DiscoverySession[];
  rawSessionIds: string[];
};

type TraceCase = {
  question_id: string;
  trace?: Array<Record<string, unknown>>;
};

type CandidateHit = {
  family: "sparse" | "dense";
  stage: "initial" | "follow_up";
  rank: number;
};

function objectValues(value: unknown): unknown[] {
  return value && typeof value === "object" ? Object.values(value) : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * Reconstruct every unique session returned by any sparse or dense query.
 * This is deliberately an inclusive union: it performs no ranking or cutoff.
 */
export function buildDiscoveryUnion(raw: ArchitectureCase, traced: TraceCase): DiscoveryUnion {
  if (raw.question_id !== traced.question_id) {
    throw new Error(`trace mismatch: ${traced.question_id} does not match ${raw.question_id}`);
  }
  const dates = new Map<string, string>();
  raw.haystack_session_ids.forEach((sessionId, index) => {
    dates.set(sessionId, raw.haystack_dates[index] ?? "");
  });
  const opaque = buildOpaqueSessionSpace({
    namespace: raw.question_id,
    sessionIds: raw.haystack_session_ids,
    datesBySessionId: dates,
    annotations: new Map(),
  });
  const hitsByRealId = new Map<string, CandidateHit[]>();
  const add = (opaqueSessionId: string, hit: CandidateHit): void => {
    const realSessionId = opaque.opaqueToReal.get(opaqueSessionId);
    if (!realSessionId) return;
    const prior = hitsByRealId.get(realSessionId) ?? [];
    prior.push(hit);
    hitsByRealId.set(realSessionId, prior);
  };

  for (const traceEntry of traced.trace ?? []) {
    for (const [key, rawDiscovery] of Object.entries(traceEntry)) {
      if (key !== "initial_discovery" && key !== "follow_up_discovery") continue;
      const discovery = asRecord(rawDiscovery);
      if (!discovery) continue;
      const stage = key === "initial_discovery" ? "initial" : "follow_up";
      for (const rawQuery of objectValues(discovery.sparse_queries)) {
        const query = asRecord(rawQuery);
        if (!query) continue;
        stringArray(query.session_ids).forEach((opaqueSessionId, index) => {
          add(opaqueSessionId, { family: "sparse", stage, rank: index + 1 });
        });
      }
      for (const rawQuery of objectValues(discovery.dense_queries)) {
        const query = asRecord(rawQuery);
        if (!query) continue;
        objectValues(query.hits).forEach((rawHit, index) => {
          const hit = asRecord(rawHit);
          if (!hit || typeof hit.session_id !== "string") return;
          add(hit.session_id, {
            family: "dense",
            stage,
            rank: typeof hit.rank === "number" ? hit.rank : index + 1,
          });
        });
      }
    }
  }

  const rawIndex = new Map<string, number>();
  raw.haystack_session_ids.forEach((sessionId, index) => {
    if (!rawIndex.has(sessionId)) rawIndex.set(sessionId, index);
  });
  const sessions = [...hitsByRealId.entries()].flatMap(([realSessionId, hits]) => {
    const index = rawIndex.get(realSessionId);
    const opaqueSessionId = opaque.realToOpaque.get(realSessionId);
    if (index === undefined || !opaqueSessionId) return [];
    return [{
      realSessionId,
      opaqueSessionId,
      date: raw.haystack_dates[index] ?? "",
      turns: raw.haystack_sessions[index] ?? [],
      hitCount: hits.length,
      bestRank: Math.min(...hits.map((hit) => hit.rank)),
      retrievalFamilies: [...new Set(hits.map((hit) => hit.family))].sort(),
      retrievalStages: [...new Set(hits.map((hit) => hit.stage))].sort(),
    } satisfies DiscoverySession];
  }).sort((left, right) =>
    left.date.localeCompare(right.date)
    || left.opaqueSessionId.localeCompare(right.opaqueSessionId),
  );
  return {
    questionId: raw.question_id,
    sessions,
    rawSessionIds: [...new Set(raw.haystack_session_ids)],
  };
}

export function formatDiscoverySessions(sessions: DiscoverySession[]): string {
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

export function formatWorkerSessions(sessions: DiscoverySession[]): string {
  return formatDiscoverySessions(sessions);
}

export type ValidatedCompressionClaim = {
  sessionId: string;
  realSessionId: string;
  date: string;
  turnIndex: number;
  role: "user" | "assistant";
  verbatimQuote: string;
  normalizedFact: string;
  facetIds: string[];
  storyBranchIds: string[];
  evidenceKind: z.infer<typeof WorkerClaimSchema>["evidenceKind"];
  whyNeeded: string;
  confidence: z.infer<typeof WorkerClaimSchema>["confidence"];
  unplannedNovelEvidence: boolean;
};

export type RejectedCompressionClaim = {
  sessionId: string;
  turnIndex: number;
  reason: "unknown_session" | "unknown_turn" | "quote_not_in_source" | "unknown_plan_reference";
  normalizedFact: string;
};

export type ReducedCompressionPackage = {
  claims: ValidatedCompressionClaim[];
  rejectedClaims: RejectedCompressionClaim[];
  representedRealSessionIds: string[];
  coveredFacetIds: string[];
  uncoveredMustFacetIds: string[];
  characterCount: number;
  estimatedTokens: number;
};

/**
 * Validate and assemble claims without semantic scoring, relevance thresholds,
 * top-K truncation, or fuzzy deduplication. Every source-grounded claim is kept.
 */
export function reduceCompressionClaims(args: {
  plan: CompressionPlan;
  discovery: DiscoveryUnion;
  workerOutputs: CompressionWorkerOutput[];
}): ReducedCompressionPackage {
  const sessions = new Map(args.discovery.sessions.map((session) => [session.opaqueSessionId, session]));
  const facetIds = new Set(args.plan.evidenceFacets.map((facet) => facet.id));
  const branchIds = new Set(args.plan.storyBranches.map((branch) => branch.id));
  const claims: ValidatedCompressionClaim[] = [];
  const rejectedClaims: RejectedCompressionClaim[] = [];

  for (const output of args.workerOutputs) {
    for (const result of output.sessionResults) {
      for (const claim of result.claims) {
        const session = sessions.get(result.sessionId);
        if (!session) {
          rejectedClaims.push({
            sessionId: result.sessionId,
            turnIndex: claim.turnIndex,
            reason: "unknown_session",
            normalizedFact: claim.normalizedFact,
          });
          continue;
        }
        const turn = session.turns[claim.turnIndex];
        if (!turn) {
          rejectedClaims.push({
            sessionId: result.sessionId,
            turnIndex: claim.turnIndex,
            reason: "unknown_turn",
            normalizedFact: claim.normalizedFact,
          });
          continue;
        }
        if (!turn.content.includes(claim.verbatimQuote)) {
          rejectedClaims.push({
            sessionId: result.sessionId,
            turnIndex: claim.turnIndex,
            reason: "quote_not_in_source",
            normalizedFact: claim.normalizedFact,
          });
          continue;
        }
        const unknownFacet = claim.facetIds.some((id) => !facetIds.has(id));
        const unknownBranch = claim.storyBranchIds.some((id) => !branchIds.has(id));
        if ((unknownFacet || unknownBranch) && !claim.unplannedNovelEvidence) {
          rejectedClaims.push({
            sessionId: result.sessionId,
            turnIndex: claim.turnIndex,
            reason: "unknown_plan_reference",
            normalizedFact: claim.normalizedFact,
          });
          continue;
        }
        claims.push({
          sessionId: result.sessionId,
          realSessionId: session.realSessionId,
          date: session.date,
          turnIndex: claim.turnIndex,
          role: turn.role,
          verbatimQuote: claim.verbatimQuote,
          normalizedFact: claim.normalizedFact,
          facetIds: claim.facetIds.filter((id) => facetIds.has(id)),
          storyBranchIds: claim.storyBranchIds.filter((id) => branchIds.has(id)),
          evidenceKind: claim.evidenceKind,
          whyNeeded: claim.whyNeeded,
          confidence: claim.confidence,
          unplannedNovelEvidence: claim.unplannedNovelEvidence,
        });
      }
    }
  }

  claims.sort((left, right) =>
    left.date.localeCompare(right.date)
    || left.sessionId.localeCompare(right.sessionId)
    || left.turnIndex - right.turnIndex
    || left.normalizedFact.localeCompare(right.normalizedFact),
  );
  const representedRealSessionIds = [...new Set(claims.map((claim) => claim.realSessionId))];
  const coveredFacetIds = [...new Set(claims.flatMap((claim) => claim.facetIds))].sort();
  const covered = new Set(coveredFacetIds);
  const uncoveredMustFacetIds = args.plan.evidenceFacets
    .filter((facet) => facet.priority === "must" && !covered.has(facet.id))
    .map((facet) => facet.id);
  const characterCount = claims.reduce(
    (sum, claim) => sum + claim.normalizedFact.length + claim.verbatimQuote.length,
    0,
  );
  return {
    claims,
    rejectedClaims,
    representedRealSessionIds,
    coveredFacetIds,
    uncoveredMustFacetIds,
    characterCount,
    estimatedTokens: Math.ceil(characterCount / 4),
  };
}

export type RecertifiedEvidenceSource = {
  message_id: number;
  session_id: string;
  turn_index: number;
  role: "user" | "assistant";
  quote: string;
};

export type RecertifiedEvidenceAtom = {
  atom_id: string;
  description: string;
  sources: RecertifiedEvidenceSource[];
};

export type RecertifiedOracleEntry = {
  question_id: string;
  status: "certified" | "needs_review";
  evidence_atoms: RecertifiedEvidenceAtom[];
  excluded_answer_atoms?: Array<{
    atom_id: string;
    description: string;
    status: "not_found" | "ambiguous";
  }>;
};

export function evaluateCompressionCoverage(
  pkg: ReducedCompressionPackage,
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
  const representedTurns = new Set(
    pkg.claims.map((claim) => `${claim.realSessionId}\0${String(claim.turnIndex)}`),
  );
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
  const representedSessions = new Set(pkg.representedRealSessionIds);
  const goldSessionsRepresented = [...goldSessions].filter((id) => representedSessions.has(id)).length;
  return {
    coveredAtoms,
    totalAtoms: oracle.evidence_atoms.length,
    atomRecall: oracle.evidence_atoms.length === 0 ? 1 : coveredAtoms / oracle.evidence_atoms.length,
    fullStory: uncoveredAtomIds.length === 0,
    uncoveredAtomIds,
    goldSessionsRepresented,
    goldSessionsTotal: goldSessions.size,
  };
}

export function compressionPlanHash(plan: CompressionPlan): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}
