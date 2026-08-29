import { Buffer } from "node:buffer";

import { getEncoding } from "js-tiktoken";

import type {
  RecertifiedEvidenceAtom,
  RecertifiedEvidenceSource,
  RecertifiedOracleEntry,
} from "../compression/beamCompression.js";
import type {
  AtomicCardMaterializationResult,
  MaterializedAtomicCard,
  MaterializedSourceQuote,
} from "./atomicCards.js";

export type {
  AtomicCardMaterializationResult,
  MaterializedAtomicCard,
  MaterializedSourceQuote,
  QuarantinedAtomicCard,
} from "./atomicCards.js";

const O200K = getEncoding("o200k_base");

export type AtomCardSourceMatch = {
  cardId: string;
  cardSpanIndex: number;
  oracleSourceIndex: number;
};

export type AtomCardCandidates = {
  atomId: string;
  candidateCardIds: string[];
  sourceMatches: AtomCardSourceMatch[];
};

function turnKey(sessionId: string, turnIndex: number): string {
  return `${sessionId}\0${String(turnIndex)}`;
}

/**
 * A conservative overlap check for two verbatim excerpts from the same turn.
 * One excerpt must contain the other exactly; case folding or fuzzy matching
 * would make provenance validation non-lossless.
 */
export function verbatimQuotesOverlap(left: string, right: string): boolean {
  const leftQuote = left.trim();
  const rightQuote = right.trim();
  return leftQuote.length > 0
    && rightQuote.length > 0
    && (leftQuote.includes(rightQuote) || rightQuote.includes(leftQuote));
}

function spanMatchesOracleSource(
  span: MaterializedSourceQuote,
  source: RecertifiedEvidenceSource,
): boolean {
  return span.sessionId === source.session_id
    && span.turnIndex === source.turn_index
    && verbatimQuotesOverlap(span.exact, source.quote);
}

function candidatesForAtom(
  cards: readonly MaterializedAtomicCard[],
  atom: RecertifiedEvidenceAtom,
): AtomCardCandidates {
  const sourceMatches: AtomCardSourceMatch[] = [];
  for (const card of cards) {
    for (let cardSpanIndex = 0; cardSpanIndex < card.sources.length; cardSpanIndex += 1) {
      const span = card.sources[cardSpanIndex];
      if (!span) continue;
      for (let oracleSourceIndex = 0; oracleSourceIndex < atom.sources.length; oracleSourceIndex += 1) {
        const source = atom.sources[oracleSourceIndex];
        if (!source || !spanMatchesOracleSource(span, source)) continue;
        sourceMatches.push({ cardId: card.cardId, cardSpanIndex, oracleSourceIndex });
      }
    }
  }
  sourceMatches.sort((left, right) =>
    left.cardId.localeCompare(right.cardId)
    || left.cardSpanIndex - right.cardSpanIndex
    || left.oracleSourceIndex - right.oracleSourceIndex,
  );
  return {
    atomId: atom.atom_id,
    candidateCardIds: [...new Set(sourceMatches.map((match) => match.cardId))],
    sourceMatches,
  };
}

function turnCandidatesForAtom(
  cards: readonly MaterializedAtomicCard[],
  atom: RecertifiedEvidenceAtom,
): AtomCardCandidates {
  const sourceMatches: AtomCardSourceMatch[] = [];
  for (const card of cards) {
    for (let cardSpanIndex = 0; cardSpanIndex < card.sources.length; cardSpanIndex += 1) {
      const span = card.sources[cardSpanIndex];
      if (!span) continue;
      for (let oracleSourceIndex = 0; oracleSourceIndex < atom.sources.length; oracleSourceIndex += 1) {
        const source = atom.sources[oracleSourceIndex];
        if (
          !source
          || span.sessionId !== source.session_id
          || span.turnIndex !== source.turn_index
        ) continue;
        sourceMatches.push({ cardId: card.cardId, cardSpanIndex, oracleSourceIndex });
      }
    }
  }
  sourceMatches.sort((left, right) =>
    left.cardId.localeCompare(right.cardId)
    || left.cardSpanIndex - right.cardSpanIndex
    || left.oracleSourceIndex - right.oracleSourceIndex,
  );
  return {
    atomId: atom.atom_id,
    candidateCardIds: [...new Set(sourceMatches.map((match) => match.cardId))],
    sourceMatches,
  };
}

/**
 * Maps accepted cards to recertified atoms using only exact provenance
 * coordinates and conservative quote overlap. Candidate status is not a
 * semantic coverage judgment.
 */
export function mapAcceptedCardSpansToOracleAtoms(
  cards: readonly MaterializedAtomicCard[],
  oracle: RecertifiedOracleEntry,
): AtomCardCandidates[] {
  return oracle.evidence_atoms.map((atom) => candidatesForAtom(cards, atom));
}

/**
 * Gives the semantic judge every accepted card anchored in a certified source
 * turn. This compensates for oracle excerpts that omit adjacent details while
 * retaining the exact session/turn boundary and requiring semantic judgment.
 */
export function mapAcceptedCardTurnsToOracleAtoms(
  cards: readonly MaterializedAtomicCard[],
  oracle: RecertifiedOracleEntry,
): AtomCardCandidates[] {
  return oracle.evidence_atoms.map((atom) => turnCandidatesForAtom(cards, atom));
}

export type TurnOnlyAtomCoverage = {
  coveredAtoms: number;
  totalAtoms: number;
  atomRecall: number;
  fullStory: boolean;
  fullStoryCompatible: boolean;
  coveredAtomIds: string[];
  uncoveredAtomIds: string[];
};

/**
 * Compatibility metric for the historical scorer: an atom is covered when an
 * accepted card cites any oracle source turn, regardless of quote or claim
 * semantics. This must not be treated as semantic evidence coverage.
 */
export function evaluateTurnOnlyAtomCoverage(
  cards: readonly MaterializedAtomicCard[],
  oracle: RecertifiedOracleEntry,
): TurnOnlyAtomCoverage {
  const representedTurns = new Set(cards.flatMap((card) =>
    card.sources.map((span) => turnKey(span.sessionId, span.turnIndex)),
  ));
  const coveredAtomIds: string[] = [];
  const uncoveredAtomIds: string[] = [];
  for (const atom of oracle.evidence_atoms) {
    const covered = atom.sources.some((source) =>
      representedTurns.has(turnKey(source.session_id, source.turn_index)),
    );
    (covered ? coveredAtomIds : uncoveredAtomIds).push(atom.atom_id);
  }
  const totalAtoms = oracle.evidence_atoms.length;
  const coveredAtoms = coveredAtomIds.length;
  const fullStory = uncoveredAtomIds.length === 0;
  return {
    coveredAtoms,
    totalAtoms,
    atomRecall: totalAtoms === 0 ? 1 : coveredAtoms / totalAtoms,
    fullStory,
    fullStoryCompatible: fullStory,
    coveredAtomIds,
    uncoveredAtomIds,
  };
}

function jsonStableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonStableValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, jsonStableValue(child)]));
}

export function stableJson(value: unknown): string {
  const stable = jsonStableValue(value);
  if (stable === undefined) throw new Error("value cannot be serialized as JSON");
  return JSON.stringify(stable);
}

export function countO200kTokens(text: string): number {
  return O200K.encode(text).length;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const midpoint = Math.floor(values.length / 2);
  const right = values[midpoint] ?? 0;
  if (values.length % 2 === 1) return right;
  const left = values[midpoint - 1] ?? 0;
  return (left + right) / 2;
}

function nearestRank(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const index = Math.max(0, Math.ceil(values.length * fraction) - 1);
  return values[Math.min(index, values.length - 1)] ?? 0;
}

export type PerCardSizeMetric = {
  cardId: string;
  tokens: number;
  utf8Bytes: number;
};

export type ExactCardTokenMetrics = {
  tokenizer: "o200k_base";
  serialization: "stable-jsonl-with-terminal-newline";
  cardCount: number;
  totalTokens: number;
  totalUtf8Bytes: number;
  meanTokensPerCard: number;
  medianTokensPerCard: number;
  p95TokensPerCard: number;
  maxTokensPerCard: number;
  meanUtf8BytesPerCard: number;
  p95Utf8BytesPerCard: number;
  maxUtf8BytesPerCard: number;
  sourceTokenCount: number | null;
  cardTokenFraction: number | null;
  compressionRatio: number | null;
  cardsPerMillionSourceTokens: number | null;
  perCard: PerCardSizeMetric[];
};

/** Counts the exact o200k_base tokens in a canonical JSONL card artifact. */
export function computeExactCardTokenMetrics(
  cards: readonly MaterializedAtomicCard[],
  sourceTokenCount?: number,
): ExactCardTokenMetrics {
  if (sourceTokenCount !== undefined && (!Number.isInteger(sourceTokenCount) || sourceTokenCount < 0)) {
    throw new Error("sourceTokenCount must be a nonnegative integer");
  }
  const lines = cards.map((card) => stableJson(card));
  const jsonl = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  const perCard = cards.map((card, index) => {
    const line = lines[index] ?? "";
    return {
      cardId: card.cardId,
      tokens: countO200kTokens(line),
      utf8Bytes: Buffer.byteLength(line, "utf8"),
    };
  });
  const tokens = perCard.map((metric) => metric.tokens).sort((left, right) => left - right);
  const bytes = perCard.map((metric) => metric.utf8Bytes).sort((left, right) => left - right);
  const totalTokens = countO200kTokens(jsonl);
  const totalUtf8Bytes = Buffer.byteLength(jsonl, "utf8");
  const sourceTokens = sourceTokenCount ?? null;
  return {
    tokenizer: "o200k_base",
    serialization: "stable-jsonl-with-terminal-newline",
    cardCount: cards.length,
    totalTokens,
    totalUtf8Bytes,
    meanTokensPerCard: cards.length === 0
      ? 0
      : perCard.reduce((sum, metric) => sum + metric.tokens, 0) / cards.length,
    medianTokensPerCard: median(tokens),
    p95TokensPerCard: nearestRank(tokens, 0.95),
    maxTokensPerCard: tokens.at(-1) ?? 0,
    meanUtf8BytesPerCard: cards.length === 0
      ? 0
      : perCard.reduce((sum, metric) => sum + metric.utf8Bytes, 0) / cards.length,
    p95Utf8BytesPerCard: nearestRank(bytes, 0.95),
    maxUtf8BytesPerCard: bytes.at(-1) ?? 0,
    sourceTokenCount: sourceTokens,
    cardTokenFraction: sourceTokens === null || sourceTokens === 0 ? null : totalTokens / sourceTokens,
    compressionRatio: sourceTokens === null || sourceTokens === 0 || totalTokens === 0
      ? null
      : sourceTokens / totalTokens,
    cardsPerMillionSourceTokens: sourceTokens === null || sourceTokens === 0
      ? null
      : cards.length * 1_000_000 / sourceTokens,
    perCard,
  };
}

export type FrozenAtomicIngestionCanaryManifest = {
  schema_version: number;
  benchmark: string;
  tier: string;
  name: string;
  role: string;
  conversation_selection: {
    eligible_conversation_ids: Array<number | string>;
    primary_conversation_id: number | string;
    shadow_conversation_id: number | string;
  };
  probe_selection: {
    strata: Record<string, number>;
  };
  primary_probe_ids: string[];
  shadow_probe_ids: string[];
  isolation: {
    ingestion_input: string;
    forbidden_during_ingestion: string[];
    existing_compression_holdout: string;
  };
};

export type FrozenCanaryValidationOptions = {
  allowedConversationIds?: ReadonlyArray<number | string>;
  forbiddenConversationIds?: ReadonlyArray<number | string>;
};

export type FrozenCanaryValidation = {
  valid: boolean;
  errors: string[];
  conversationCount: number;
  probeCount: number;
  primaryProbeStrata: Record<string, number>;
  shadowProbeStrata: Record<string, number>;
};

function conversationKey(value: number | string): string {
  const text = String(value).trim();
  const match = text.match(/^(?:chat-)?0*([0-9]+)$/i);
  return match?.[1] ? String(Number(match[1])) : text;
}

function questionParts(questionId: string): { conversation: string; ability: string } | null {
  const match = questionId.match(/^beam-1m\/chat-([0-9]+)\/([^/]+)\/[12]$/);
  if (!match?.[1] || !match[2]) return null;
  return { conversation: conversationKey(match[1]), ability: match[2] };
}

function countProbeStrata(
  probeIds: readonly string[],
  expectedConversation: string,
  label: "primary" | "shadow",
  errors: string[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const questionId of probeIds) {
    const parsed = questionParts(questionId);
    if (!parsed) {
      errors.push(`${label} probe ${questionId} is not a valid BEAM-1M question ID`);
      continue;
    }
    if (parsed.conversation !== expectedConversation) {
      errors.push(`${label} probe ${questionId} crosses the conversation boundary`);
    }
    counts[parsed.ability] = (counts[parsed.ability] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right)));
}

function validateStrata(
  label: "primary" | "shadow",
  expected: Readonly<Record<string, number>>,
  actual: Readonly<Record<string, number>>,
  errors: string[],
): void {
  const abilities = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const ability of [...abilities].sort()) {
    const expectedCount = expected[ability] ?? 0;
    if (!Number.isInteger(expectedCount) || expectedCount < 0) {
      errors.push(`probe_selection.strata.${ability} must be a nonnegative integer`);
      continue;
    }
    const actualCount = actual[ability] ?? 0;
    if (actualCount !== expectedCount) {
      errors.push(`${label} probe stratum ${ability} expected ${expectedCount}, got ${actualCount}`);
    }
  }
}

/** Validates only structure and isolation; it never reads probe or oracle data. */
export function validateFrozenCanaryManifest(
  manifest: FrozenAtomicIngestionCanaryManifest,
  options: FrozenCanaryValidationOptions = {},
): FrozenCanaryValidation {
  const errors: string[] = [];
  if (manifest.schema_version !== 1) errors.push("schema_version must be 1");
  if (manifest.benchmark !== "BEAM" || manifest.tier !== "1M") {
    errors.push("manifest must target BEAM-1M");
  }
  if (!manifest.role.startsWith("sealed_")) errors.push("manifest role must be sealed");

  const eligibleIds = manifest.conversation_selection.eligible_conversation_ids.map(conversationKey);
  const eligibleSet = new Set(eligibleIds);
  const primaryId = conversationKey(manifest.conversation_selection.primary_conversation_id);
  const shadowId = conversationKey(manifest.conversation_selection.shadow_conversation_id);
  if (eligibleSet.size !== eligibleIds.length) {
    errors.push("eligible_conversation_ids must be unique");
  }
  if (!eligibleSet.has(primaryId)) errors.push("primary conversation is not eligible");
  if (!eligibleSet.has(shadowId)) errors.push("shadow conversation is not eligible");
  if (primaryId === shadowId) errors.push("primary and shadow conversations must be distinct");

  const allowed = options.allowedConversationIds
    ? new Set(options.allowedConversationIds.map(conversationKey))
    : null;
  const forbidden = new Set((options.forbiddenConversationIds ?? []).map(conversationKey));
  for (const conversationId of [primaryId, shadowId]) {
    if (allowed && !allowed.has(conversationId)) {
      errors.push(`conversation ${conversationId} is outside the allowed cohort`);
    }
    if (forbidden.has(conversationId)) {
      errors.push(`conversation ${conversationId} intersects a forbidden cohort`);
    }
  }

  const allProbeIds = [...manifest.primary_probe_ids, ...manifest.shadow_probe_ids];
  if (new Set(allProbeIds).size !== allProbeIds.length) {
    errors.push("probe IDs must be unique across primary and shadow cohorts");
  }
  const primaryProbeStrata = countProbeStrata(
    manifest.primary_probe_ids,
    primaryId,
    "primary",
    errors,
  );
  const shadowProbeStrata = countProbeStrata(
    manifest.shadow_probe_ids,
    shadowId,
    "shadow",
    errors,
  );
  validateStrata("primary", manifest.probe_selection.strata, primaryProbeStrata, errors);
  validateStrata("shadow", manifest.probe_selection.strata, shadowProbeStrata, errors);
  if (manifest.isolation.ingestion_input !== "raw chronological sessions only") {
    errors.push("ingestion_input must be raw chronological sessions only");
  }
  if (manifest.isolation.forbidden_during_ingestion.length === 0) {
    errors.push("forbidden_during_ingestion must not be empty");
  }

  return {
    valid: errors.length === 0,
    errors,
    conversationCount: new Set([primaryId, shadowId]).size,
    probeCount: allProbeIds.length,
    primaryProbeStrata,
    shadowProbeStrata,
  };
}

export type AtomicIngestionCountSummary = {
  totalCardCount: number;
  acceptedCardCount: number;
  quarantinedCardCount: number;
  quarantineRate: number;
  acceptedSourceSpanCount: number;
  quarantinedSourceSpanCount: number;
  acceptedCardsWithoutProvenance: number;
  uniqueProvenanceSessionCount: number;
  uniqueProvenanceTurnCount: number;
  duplicateCardIdCount: number;
  quarantineByReason: Record<string, number>;
};

export function summarizeAtomicIngestionCounts(
  result: AtomicCardMaterializationResult,
): AtomicIngestionCountSummary {
  const acceptedSourceSpans = result.cards.flatMap((card) => card.sources);
  const quarantinedSourceSpans = result.quarantined.flatMap((card) => card.draft.sources);
  const allIds = result.cards.map((card) => card.cardId);
  const quarantineByReason: Record<string, number> = {};
  for (const card of result.quarantined) {
    for (const reason of new Set(card.issues.map((issue) => issue.reason))) {
      quarantineByReason[reason] = (quarantineByReason[reason] ?? 0) + 1;
    }
  }
  const totalCardCount = result.cards.length + result.quarantined.length;
  return {
    totalCardCount,
    acceptedCardCount: result.cards.length,
    quarantinedCardCount: result.quarantined.length,
    quarantineRate: totalCardCount === 0 ? 0 : result.quarantined.length / totalCardCount,
    acceptedSourceSpanCount: acceptedSourceSpans.length,
    quarantinedSourceSpanCount: quarantinedSourceSpans.length,
    acceptedCardsWithoutProvenance: result.cards.filter((card) => card.sources.length === 0).length,
    uniqueProvenanceSessionCount: new Set(acceptedSourceSpans.map((span) => span.sessionId)).size,
    uniqueProvenanceTurnCount: new Set(acceptedSourceSpans.map((span) =>
      turnKey(span.sessionId, span.turnIndex),
    )).size,
    duplicateCardIdCount: allIds.length - new Set(allIds).size,
    quarantineByReason: Object.fromEntries(Object.entries(quarantineByReason)
      .sort(([left], [right]) => left.localeCompare(right))),
  };
}
