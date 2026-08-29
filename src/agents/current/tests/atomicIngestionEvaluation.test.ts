import { Buffer } from "node:buffer";

import { getEncoding } from "js-tiktoken";
import { describe, expect, it } from "vitest";

import type { RecertifiedOracleEntry } from "../src/compression/beamCompression.js";
import type {
  DraftAtomicCard,
  MaterializedAtomicCard,
  QuarantinedAtomicCard,
} from "../src/ingestion/atomicCards.js";
import {
  computeExactCardTokenMetrics,
  evaluateTurnOnlyAtomCoverage,
  mapAcceptedCardSpansToOracleAtoms,
  mapAcceptedCardTurnsToOracleAtoms,
  stableJson,
  summarizeAtomicIngestionCounts,
  validateFrozenCanaryManifest,
  verbatimQuotesOverlap,
  type FrozenAtomicIngestionCanaryManifest,
} from "../src/ingestion/atomicIngestionEvaluation.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function card(args: {
  id: string;
  fact: string;
  sources: Array<{ session: string; turn: number; quote: string }>;
}): MaterializedAtomicCard {
  return {
    schemaVersion: 1,
    cardId: `card_${args.id.repeat(64).slice(0, 64)}`,
    kind: "claim",
    normalizedText: args.fact,
    assertedBy: "user",
    speechAct: "assertion",
    polarity: "positive",
    modality: "actual",
    confidence: "high",
    eventTime: { raw: null, start: null, end: null, confidence: null },
    sources: args.sources.map((source, index) => ({
      sourceId: `source_${String(index + 1).repeat(64).slice(0, 64)}`,
      sessionId: source.session,
      turnIndex: source.turn,
      role: "user",
      timestamp: null,
      contentSha256: HASH_A,
      charStart: 0,
      charEnd: source.quote.length,
      byteStart: 0,
      byteEnd: Buffer.byteLength(source.quote, "utf8"),
      exact: source.quote,
      prefix: "",
      suffix: "",
    })),
    derivation: { model: "test", promptSha256: HASH_B, runId: "test-run" },
  };
}

function oracle(): RecertifiedOracleEntry {
  return {
    question_id: "beam-1m/chat-03/knowledge_update/1",
    status: "certified",
    evidence_atoms: [
      {
        atom_id: "prior_state",
        description: "The prior launch date was Monday.",
        sources: [{
          message_id: 1,
          session_id: "raw_a",
          turn_index: 0,
          role: "user",
          quote: "The prior launch date was Monday.",
        }],
      },
      {
        atom_id: "updated_state",
        description: "The launch moved to Friday.",
        sources: [{
          message_id: 2,
          session_id: "raw_b",
          turn_index: 2,
          role: "user",
          quote: "The launch moved to Friday.",
        }],
      },
    ],
  };
}

describe("atomic ingestion evidence compatibility", () => {
  it("maps atom candidates only on source coordinates and verbatim quote overlap", () => {
    const cards = [
      card({
        id: "a",
        fact: "Launch was previously scheduled for Monday.",
        sources: [{
          session: "raw_a",
          turn: 0,
          quote: "The prior launch date was Monday. The team later changed it.",
        }],
      }),
      card({
        id: "b",
        fact: "The team discussed logistics.",
        sources: [{ session: "raw_b", turn: 2, quote: "The team discussed logistics." }],
      }),
      card({
        id: "c",
        fact: "The launch moved to Friday.",
        sources: [{ session: "raw_b", turn: 1, quote: "The launch moved to Friday." }],
      }),
    ];

    expect(verbatimQuotesOverlap(
      "The prior launch date was Monday. The team later changed it.",
      "The prior launch date was Monday.",
    )).toBe(true);
    expect(verbatimQuotesOverlap("launch moved", "Launch moved")).toBe(false);
    expect(verbatimQuotesOverlap("  ", "anything")).toBe(false);

    expect(mapAcceptedCardSpansToOracleAtoms(cards, oracle())).toEqual([
      {
        atomId: "prior_state",
        candidateCardIds: [`card_${"a".repeat(64)}`],
        sourceMatches: [{
          cardId: `card_${"a".repeat(64)}`,
          cardSpanIndex: 0,
          oracleSourceIndex: 0,
        }],
      },
      { atomId: "updated_state", candidateCardIds: [], sourceMatches: [] },
    ]);
  });

  it("reports the historical turn-only full-story metric separately", () => {
    const cards = [
      card({
        id: "a",
        fact: "Prior state.",
        sources: [{ session: "raw_a", turn: 0, quote: "unrelated same-turn excerpt" }],
      }),
      card({
        id: "b",
        fact: "Updated state.",
        sources: [{ session: "raw_b", turn: 2, quote: "another unrelated excerpt" }],
      }),
    ];
    expect(evaluateTurnOnlyAtomCoverage(cards, oracle())).toEqual({
      coveredAtoms: 2,
      totalAtoms: 2,
      atomRecall: 1,
      fullStory: true,
      fullStoryCompatible: true,
      coveredAtomIds: ["prior_state", "updated_state"],
      uncoveredAtomIds: [],
    });
    expect(mapAcceptedCardSpansToOracleAtoms(cards, oracle())
      .every((entry) => entry.candidateCardIds.length === 0)).toBe(true);
    expect(mapAcceptedCardTurnsToOracleAtoms(cards, oracle()).map((entry) => ({
      atomId: entry.atomId,
      candidateCardIds: entry.candidateCardIds,
    }))).toEqual([
      { atomId: "prior_state", candidateCardIds: [`card_${"a".repeat(64)}`] },
      { atomId: "updated_state", candidateCardIds: [`card_${"b".repeat(64)}`] },
    ]);
  });
});

describe("atomic card size metrics", () => {
  it("counts stable JSONL with the exact o200k_base tokenizer", () => {
    const cards = [
      card({ id: "b", fact: "The launch moved to Friday.", sources: [] }),
      card({ id: "a", fact: "Budget is ₹5,000.", sources: [] }),
    ];
    const encoding = getEncoding("o200k_base");
    const jsonl = `${cards.map((item) => stableJson(item)).join("\n")}\n`;
    const metrics = computeExactCardTokenMetrics(cards, 1_000);

    expect(metrics).toEqual(expect.objectContaining({
      tokenizer: "o200k_base",
      serialization: "stable-jsonl-with-terminal-newline",
      cardCount: 2,
      totalTokens: encoding.encode(jsonl).length,
      totalUtf8Bytes: Buffer.byteLength(jsonl, "utf8"),
      sourceTokenCount: 1_000,
      cardTokenFraction: encoding.encode(jsonl).length / 1_000,
      cardsPerMillionSourceTokens: 2_000,
    }));
    expect(metrics.compressionRatio).toBe(1_000 / metrics.totalTokens);
    expect(metrics.perCard.map((item) => item.cardId)).toEqual([
      `card_${"b".repeat(64)}`,
      `card_${"a".repeat(64)}`,
    ]);
    expect(stableJson({ z: 1, nested: { y: 2, x: 3 }, a: 4 }))
      .toBe('{"a":4,"nested":{"x":3,"y":2},"z":1}');
  });

  it("returns zero sizes and undefined ratios for an empty artifact", () => {
    expect(computeExactCardTokenMetrics([])).toEqual(expect.objectContaining({
      cardCount: 0,
      totalTokens: 0,
      totalUtf8Bytes: 0,
      cardTokenFraction: null,
      compressionRatio: null,
      cardsPerMillionSourceTokens: null,
      perCard: [],
    }));
    expect(() => computeExactCardTokenMetrics([], -1)).toThrow(/nonnegative integer/);
  });
});

describe("frozen canary manifest validation", () => {
  function manifest(): FrozenAtomicIngestionCanaryManifest {
    return {
      schema_version: 1,
      benchmark: "BEAM",
      tier: "1M",
      name: "beam-1m-atomic-ingestion-dev-v1",
      role: "sealed_from_now_ingestion_falsification_not_population_estimate",
      conversation_selection: {
        eligible_conversation_ids: [3, 8],
        primary_conversation_id: 3,
        shadow_conversation_id: 8,
      },
      probe_selection: { strata: { knowledge_update: 1, temporal_reasoning: 1 } },
      primary_probe_ids: [
        "beam-1m/chat-03/knowledge_update/1",
        "beam-1m/chat-03/temporal_reasoning/2",
      ],
      shadow_probe_ids: [
        "beam-1m/chat-08/knowledge_update/2",
        "beam-1m/chat-08/temporal_reasoning/1",
      ],
      isolation: {
        ingestion_input: "raw chronological sessions only",
        forbidden_during_ingestion: ["probe questions", "oracle atoms"],
        existing_compression_holdout: "untouched and excluded",
      },
    };
  }

  it("accepts exact strata isolated to distinct primary and shadow conversations", () => {
    expect(validateFrozenCanaryManifest(manifest(), {
      allowedConversationIds: [3, 8, 18, 25, 29],
      forbiddenConversationIds: [1, 2],
    })).toEqual({
      valid: true,
      errors: [],
      conversationCount: 2,
      probeCount: 4,
      primaryProbeStrata: { knowledge_update: 1, temporal_reasoning: 1 },
      shadowProbeStrata: { knowledge_update: 1, temporal_reasoning: 1 },
    });
  });

  it("rejects an unsealed, cross-conversation, stratum-mismatched manifest", () => {
    const invalid = manifest();
    invalid.role = "development_only";
    invalid.shadow_probe_ids[1] = "beam-1m/chat-18/summarization/1";
    const validation = validateFrozenCanaryManifest(invalid, {
      allowedConversationIds: [3],
      forbiddenConversationIds: [8],
    });
    expect(validation.valid).toBe(false);
    expect(validation.errors).toEqual(expect.arrayContaining([
      "manifest role must be sealed",
      "conversation 8 is outside the allowed cohort",
      "conversation 8 intersects a forbidden cohort",
      "shadow probe beam-1m/chat-18/summarization/1 crosses the conversation boundary",
      "shadow probe stratum summarization expected 0, got 1",
      "shadow probe stratum temporal_reasoning expected 1, got 0",
    ]));
  });
});

function draft(sources: DraftAtomicCard["sources"]): DraftAtomicCard {
  return {
    kind: "claim",
    normalizedText: "Draft fact.",
    assertedBy: "user",
    speechAct: "assertion",
    polarity: "positive",
    modality: "actual",
    confidence: "high",
    eventTime: { raw: null, start: null, end: null, confidence: null },
    sources: [...sources],
  };
}

describe("atomic ingestion count summaries", () => {
  it("summarizes accepted provenance, duplicate IDs, and quarantine reasons", () => {
    const acceptedCards = [
      card({ id: "a", fact: "one", sources: [{ session: "raw_a", turn: 0, quote: "one" }] }),
      card({ id: "b", fact: "two", sources: [{ session: "raw_a", turn: 0, quote: "two" }] }),
      card({ id: "b", fact: "three", sources: [] }),
    ];
    const quarantinedCards: QuarantinedAtomicCard[] = [
      {
        draftIndex: 0,
        draft: draft([{ sessionId: "raw_b", turnIndex: 1, exact: "bad", prefix: "", suffix: "" }]),
        issues: [
          { sourceIndex: 0, reason: "quote_not_found", detail: "bad quote" },
          { sourceIndex: 0, reason: "quote_not_found", detail: "same reason" },
          { sourceIndex: 0, reason: "unknown_turn", detail: "bad turn" },
        ],
      },
      {
        draftIndex: 1,
        draft: draft([]),
        issues: [{ sourceIndex: 0, reason: "unknown_turn", detail: "bad turn" }],
      },
    ];
    expect(summarizeAtomicIngestionCounts({ cards: acceptedCards, quarantined: quarantinedCards })).toEqual({
      totalCardCount: 5,
      acceptedCardCount: 3,
      quarantinedCardCount: 2,
      quarantineRate: 0.4,
      acceptedSourceSpanCount: 2,
      quarantinedSourceSpanCount: 1,
      acceptedCardsWithoutProvenance: 1,
      uniqueProvenanceSessionCount: 1,
      uniqueProvenanceTurnCount: 1,
      duplicateCardIdCount: 1,
      quarantineByReason: { quote_not_found: 1, unknown_turn: 2 },
    });
  });
});
