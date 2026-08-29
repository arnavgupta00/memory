import { describe, expect, it } from "vitest";

import {
  AtomicCardAuditorOutputSchema,
  AtomicCardExtractorOutputSchema,
  AtomicCardKindSchema,
  DraftAtomicCardSchema,
  SourceQuoteAnchorSchema,
  TurnDispositionSchema,
  materializeAtomicCards,
  type AtomicCardDerivation,
  type AtomicCardSourceTurn,
  type DraftAtomicCard,
} from "../src/ingestion/atomicCards.js";

const derivation: AtomicCardDerivation = {
  model: "test-extractor",
  promptSha256: "a".repeat(64),
  runId: "run-1",
};

const turns: AtomicCardSourceTurn[] = [
  {
    sessionId: "session-a",
    turnIndex: 0,
    role: "user",
    content: "I started Project Cedar on Monday.",
    timestamp: "2026-08-03T09:00:00Z",
  },
  {
    sessionId: "session-a",
    turnIndex: 1,
    role: "assistant",
    content: "The migration plan uses two stages.",
    timestamp: "2026-08-03T09:01:00Z",
  },
];

function draft(overrides: Partial<DraftAtomicCard> = {}): DraftAtomicCard {
  return {
    kind: "event",
    normalizedText: "Project Cedar started on Monday and uses a two-stage migration plan.",
    assertedBy: "user and assistant",
    speechAct: "assertion",
    polarity: "positive",
    modality: "actual",
    confidence: "high",
    eventTime: {
      raw: "Monday",
      start: "2026-08-03",
      end: "2026-08-03",
      confidence: "high",
    },
    sources: [
      {
        sessionId: "session-a",
        turnIndex: 0,
        exact: "started Project Cedar on Monday",
        prefix: "I ",
        suffix: ".",
      },
      {
        sessionId: "session-a",
        turnIndex: 1,
        exact: "migration plan uses two stages",
        prefix: "The ",
        suffix: ".",
      },
    ],
    ...overrides,
  };
}

describe("atomic card ingestion primitives", () => {
  it("materializes immutable multi-turn cards from both roles with host IDs", () => {
    const first = materializeAtomicCards({ turns, drafts: [draft()], derivation });
    const second = materializeAtomicCards({ turns, drafts: [draft()], derivation });

    expect(first.quarantined).toEqual([]);
    expect(first.cards).toHaveLength(1);
    const card = first.cards[0];
    if (!card) throw new Error("missing materialized card");
    expect(card.cardId).toMatch(/^card_[a-f0-9]{64}$/);
    expect(card.cardId).toBe(second.cards[0]?.cardId);
    expect(card.sources.map((source) => source.role)).toEqual(["user", "assistant"]);
    expect(card.sources.every((source) => /^source_[a-f0-9]{64}$/.test(source.sourceId))).toBe(true);
    expect(card.sources[0]).toEqual(expect.objectContaining({
      exact: "started Project Cedar on Monday",
      charStart: turns[0]?.content.indexOf("started") ?? -1,
    }));
    expect(Object.isFrozen(card)).toBe(true);
    expect(Object.isFrozen(card.sources)).toBe(true);
    expect(Object.isFrozen(card.sources[0])).toBe(true);
    expect(Object.isFrozen(card.eventTime)).toBe(true);
    expect(Object.isFrozen(card.derivation)).toBe(true);
  });

  it("uses exact prefix and suffix to resolve a repeated quote", () => {
    const repeatedTurn: AtomicCardSourceTurn = {
      sessionId: "session-b",
      turnIndex: 0,
      role: "assistant",
      content: "Alpha said yes. Later Alpha said no.",
      timestamp: null,
    };
    const value = materializeAtomicCards({
      turns: [repeatedTurn],
      drafts: [draft({
        normalizedText: "The later statement names Alpha.",
        sources: [{
          sessionId: "session-b",
          turnIndex: 0,
          exact: "Alpha",
          prefix: "Later ",
          suffix: " said no",
        }],
      })],
      derivation,
    });

    expect(value.quarantined).toEqual([]);
    expect(value.cards[0]?.sources[0]?.charStart).toBe(repeatedTurn.content.lastIndexOf("Alpha"));
  });

  it("quarantines a whole draft when any anchor is ambiguous or invalid", () => {
    const repeatedTurn: AtomicCardSourceTurn = {
      sessionId: "session-b",
      turnIndex: 0,
      role: "user",
      content: "Alpha then Alpha",
      timestamp: null,
    };
    const result = materializeAtomicCards({
      turns: [repeatedTurn],
      drafts: [
        draft({
          sources: [{
            sessionId: "session-b",
            turnIndex: 0,
            exact: "Alpha",
            prefix: "",
            suffix: "",
          }],
        }),
        draft({
          sources: [{
            sessionId: "missing-session",
            turnIndex: 9,
            exact: "missing",
            prefix: "",
            suffix: "",
          }],
        }),
        draft({
          sources: [{
            sessionId: "session-b",
            turnIndex: 0,
            exact: "Alpha",
            prefix: "wrong ",
            suffix: "",
          }],
        }),
      ],
      derivation,
    });

    expect(result.cards).toEqual([]);
    expect(result.quarantined.map((item) => item.issues[0]?.reason)).toEqual([
      "ambiguous_quote",
      "unknown_turn",
      "anchor_context_mismatch",
    ]);
  });

  it("rejects fabricated quotes and duplicate declared source turns", () => {
    const fabricated = materializeAtomicCards({
      turns,
      drafts: [draft({
        sources: [{
          sessionId: "session-a",
          turnIndex: 0,
          exact: "This was fabricated",
          prefix: "",
          suffix: "",
        }],
      })],
      derivation,
    });
    expect(fabricated.quarantined[0]?.issues[0]?.reason).toBe("quote_not_found");

    const firstTurn = turns[0];
    const firstAnchor = draft().sources[0];
    if (!firstTurn || !firstAnchor) throw new Error("fixture source missing");
    expect(() => materializeAtomicCards({
      turns: [firstTurn, firstTurn],
      drafts: [draft({ sources: [firstAnchor] })],
      derivation,
    })).toThrow("duplicate source turn");
  });

  it("supports every query-blind card kind and strict turn dispositions", () => {
    const kinds = [
      "claim",
      "event",
      "state",
      "preference",
      "intention",
      "plan",
      "decision",
      "action",
      "outcome",
      "relationship",
      "measurement",
      "instruction",
      "procedure",
      "correction",
      "question",
      "other",
    ];
    expect(kinds.map((kind) => AtomicCardKindSchema.parse(kind))).toEqual(kinds);
    expect(TurnDispositionSchema.parse({
      turnIndex: 0,
      disposition: "cards_extracted",
      reason: "Two independently meaningful propositions were extracted.",
    })).toEqual(expect.objectContaining({ turnIndex: 0 }));
    expect(() => TurnDispositionSchema.parse({
      turnIndex: 0,
      disposition: "no_extractable_content",
      reason: "Acknowledgement only.",
      extra: true,
    })).toThrow();
  });

  it("keeps extractor and auditor prompt contracts strict", () => {
    expect(() => SourceQuoteAnchorSchema.parse({
      sessionId: "session-a",
      turnIndex: 0,
      exact: "Project Cedar",
      prefix: "started ",
      suffix: " on",
      extra: true,
    })).toThrow();
    expect(() => DraftAtomicCardSchema.parse({ ...draft(), extra: true })).toThrow();

    const turnDispositions = [{
      turnIndex: 0,
      disposition: "cards_extracted" as const,
      reason: "The turn produced cards.",
    }];
    const extraction = AtomicCardExtractorOutputSchema.parse({
      cards: [draft()],
      turnDispositions,
    });
    expect(extraction.cards).toHaveLength(1);
    expect(() => AtomicCardExtractorOutputSchema.parse({ ...extraction, extra: true })).toThrow();

    const audit = AtomicCardAuditorOutputSchema.parse({
      rejectedDraftIndexes: [0],
      replacementCards: [{
        draftIndex: 0,
        card: draft({ normalizedText: "Project Cedar started on Monday." }),
      }],
      missingCards: [draft({
        kind: "procedure",
        normalizedText: "The migration procedure uses two stages.",
      })],
      turnDispositions,
    });
    expect(audit.replacementCards[0]?.draftIndex).toBe(0);
    expect(() => AtomicCardAuditorOutputSchema.parse({ ...audit, extra: true })).toThrow();
  });
});
