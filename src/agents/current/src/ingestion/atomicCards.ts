import { createHash } from "node:crypto";

import { z } from "zod";

const SHA256_HEX = /^[a-f0-9]{64}$/;
const SOURCE_ID = /^source_[a-f0-9]{64}$/;
const CARD_ID = /^card_[a-f0-9]{64}$/;

export const AtomicCardSourceTurnSchema = z.strictObject({
  sessionId: z.string().min(1),
  turnIndex: z.number().int().nonnegative(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  timestamp: z.string().min(1).nullable(),
});
export type AtomicCardSourceTurn = z.infer<typeof AtomicCardSourceTurnSchema>;

/** Model-proposed quote selector. Prefix and suffix are immediate adjacent context. */
export const SourceQuoteAnchorSchema = z.strictObject({
  sessionId: z.string().min(1),
  turnIndex: z.number().int().nonnegative(),
  exact: z.string().min(1).max(6_000),
  prefix: z.string().max(256),
  suffix: z.string().max(256),
});
export type SourceQuoteAnchor = z.infer<typeof SourceQuoteAnchorSchema>;

export const AtomicCardEventTimeSchema = z.strictObject({
  raw: z.string().min(1).nullable(),
  start: z.string().min(1).nullable(),
  end: z.string().min(1).nullable(),
  confidence: z.enum(["high", "medium", "low"]).nullable(),
});
export type AtomicCardEventTime = z.infer<typeof AtomicCardEventTimeSchema>;

export const AtomicCardKindSchema = z.enum([
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
]);
export type AtomicCardKind = z.infer<typeof AtomicCardKindSchema>;

export const DraftAtomicCardSchema = z.strictObject({
  kind: AtomicCardKindSchema,
  normalizedText: z.string().min(1).max(2_000),
  assertedBy: z.string().min(1).nullable(),
  speechAct: z.enum(["assertion", "denial", "intention", "hypothetical", "question", "report"]),
  polarity: z.enum(["positive", "negative"]),
  modality: z.enum(["actual", "planned", "possible", "counterfactual", "unknown"]),
  confidence: z.enum(["high", "medium", "low"]),
  eventTime: AtomicCardEventTimeSchema,
  sources: z.array(SourceQuoteAnchorSchema).min(1).max(16),
});
export type DraftAtomicCard = z.infer<typeof DraftAtomicCardSchema>;

export const TurnDispositionSchema = z.strictObject({
  turnIndex: z.number().int().nonnegative(),
  disposition: z.enum(["cards_extracted", "no_extractable_content"]),
  reason: z.string().max(1_000),
});
export type TurnDisposition = z.infer<typeof TurnDispositionSchema>;

export const AtomicCardExtractorOutputSchema = z.strictObject({
  cards: z.array(DraftAtomicCardSchema).max(512),
  turnDispositions: z.array(TurnDispositionSchema).max(512),
});
export type AtomicCardExtractorOutput = z.infer<typeof AtomicCardExtractorOutputSchema>;

export const AtomicCardReplacementSchema = z.strictObject({
  draftIndex: z.number().int().nonnegative(),
  card: DraftAtomicCardSchema,
});
export type AtomicCardReplacement = z.infer<typeof AtomicCardReplacementSchema>;

export const AtomicCardAuditorOutputSchema = z.strictObject({
  rejectedDraftIndexes: z.array(z.number().int().nonnegative()).max(512),
  replacementCards: z.array(AtomicCardReplacementSchema).max(512),
  missingCards: z.array(DraftAtomicCardSchema).max(128),
  turnDispositions: z.array(TurnDispositionSchema).max(512),
});
export type AtomicCardAuditorOutput = z.infer<typeof AtomicCardAuditorOutputSchema>;

export const AtomicCardDerivationSchema = z.strictObject({
  model: z.string().min(1),
  promptSha256: z.string().regex(SHA256_HEX),
  runId: z.string().min(1),
}).readonly();
export type AtomicCardDerivation = z.infer<typeof AtomicCardDerivationSchema>;

export const MaterializedSourceQuoteSchema = z.strictObject({
  sourceId: z.string().regex(SOURCE_ID),
  sessionId: z.string().min(1),
  turnIndex: z.number().int().nonnegative(),
  role: z.enum(["user", "assistant"]),
  timestamp: z.string().min(1).nullable(),
  contentSha256: z.string().regex(SHA256_HEX),
  /** Offsets into the JavaScript string (UTF-16 code units), with an exclusive end. */
  charStart: z.number().int().nonnegative(),
  charEnd: z.number().int().positive(),
  /** Offsets into the original UTF-8 byte sequence, with an exclusive end. */
  byteStart: z.number().int().nonnegative(),
  byteEnd: z.number().int().positive(),
  exact: z.string().min(1),
  prefix: z.string(),
  suffix: z.string(),
}).readonly();
export type MaterializedSourceQuote = z.infer<typeof MaterializedSourceQuoteSchema>;

const ImmutableEventTimeSchema = AtomicCardEventTimeSchema.readonly();

export const MaterializedAtomicCardSchema = z.strictObject({
  schemaVersion: z.literal(1),
  cardId: z.string().regex(CARD_ID),
  kind: DraftAtomicCardSchema.shape.kind,
  normalizedText: DraftAtomicCardSchema.shape.normalizedText,
  assertedBy: DraftAtomicCardSchema.shape.assertedBy,
  speechAct: DraftAtomicCardSchema.shape.speechAct,
  polarity: DraftAtomicCardSchema.shape.polarity,
  modality: DraftAtomicCardSchema.shape.modality,
  confidence: DraftAtomicCardSchema.shape.confidence,
  eventTime: ImmutableEventTimeSchema,
  sources: z.array(MaterializedSourceQuoteSchema).min(1).max(16).readonly(),
  derivation: AtomicCardDerivationSchema,
}).readonly();
export type MaterializedAtomicCard = z.infer<typeof MaterializedAtomicCardSchema>;

export const AtomicCardQuarantineIssueSchema = z.strictObject({
  sourceIndex: z.number().int().nonnegative(),
  reason: z.enum([
    "unknown_turn",
    "quote_not_found",
    "anchor_context_mismatch",
    "ambiguous_quote",
  ]),
  detail: z.string().min(1),
}).readonly();
export type AtomicCardQuarantineIssue = z.infer<typeof AtomicCardQuarantineIssueSchema>;

export const QuarantinedAtomicCardSchema = z.strictObject({
  draftIndex: z.number().int().nonnegative(),
  draft: DraftAtomicCardSchema,
  issues: z.array(AtomicCardQuarantineIssueSchema).min(1),
}).readonly();
export type QuarantinedAtomicCard = z.infer<typeof QuarantinedAtomicCardSchema>;

export const AtomicCardMaterializationResultSchema = z.strictObject({
  cards: z.array(MaterializedAtomicCardSchema).readonly(),
  quarantined: z.array(QuarantinedAtomicCardSchema).readonly(),
}).readonly();
export type AtomicCardMaterializationResult = z.infer<
  typeof AtomicCardMaterializationResultSchema
>;

type ResolvedAnchor = {
  source: MaterializedSourceQuote;
};

type AnchorFailure = {
  reason: AtomicCardQuarantineIssue["reason"];
  detail: string;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function turnKey(sessionId: string, turnIndex: number): string {
  return `${sessionId}\0${String(turnIndex)}`;
}

function matchingOffsets(content: string, exact: string): number[] {
  const offsets: number[] = [];
  let cursor = 0;
  while (cursor <= content.length - exact.length) {
    const found = content.indexOf(exact, cursor);
    if (found < 0) break;
    offsets.push(found);
    cursor = found + 1;
  }
  return offsets;
}

function anchorContextMatches(
  content: string,
  start: number,
  exact: string,
  prefix: string,
  suffix: string,
): boolean {
  const prefixStart = start - prefix.length;
  const suffixStart = start + exact.length;
  return prefixStart >= 0
    && content.slice(prefixStart, start) === prefix
    && content.slice(suffixStart, suffixStart + suffix.length) === suffix;
}

function resolveAnchor(
  anchor: SourceQuoteAnchor,
  turns: ReadonlyMap<string, AtomicCardSourceTurn>,
): ResolvedAnchor | AnchorFailure {
  const turn = turns.get(turnKey(anchor.sessionId, anchor.turnIndex));
  if (!turn) {
    return {
      reason: "unknown_turn",
      detail: `No source turn ${anchor.sessionId}:${String(anchor.turnIndex)}`,
    };
  }

  const offsets = matchingOffsets(turn.content, anchor.exact);
  if (offsets.length === 0) {
    return {
      reason: "quote_not_found",
      detail: "The exact quote is not present in the declared turn",
    };
  }
  const contextMatches = offsets.filter((offset) =>
    anchorContextMatches(turn.content, offset, anchor.exact, anchor.prefix, anchor.suffix),
  );
  if (contextMatches.length === 0) {
    return {
      reason: "anchor_context_mismatch",
      detail: "The exact quote exists, but its prefix and suffix do not match",
    };
  }
  if (contextMatches.length > 1) {
    return {
      reason: "ambiguous_quote",
      detail: `The quote anchor resolves to ${String(contextMatches.length)} locations`,
    };
  }

  const charStart = contextMatches[0];
  if (charStart === undefined) throw new Error("resolved quote offset unexpectedly missing");
  const charEnd = charStart + anchor.exact.length;
  const contentSha256 = sha256(turn.content);
  const byteStart = Buffer.byteLength(turn.content.slice(0, charStart), "utf8");
  const byteEnd = byteStart + Buffer.byteLength(anchor.exact, "utf8");
  const sourceId = `source_${sha256(JSON.stringify({
    schemaVersion: 1,
    sessionId: turn.sessionId,
    turnIndex: turn.turnIndex,
    role: turn.role,
    contentSha256,
    charStart,
    charEnd,
    byteStart,
    byteEnd,
  }))}`;
  const source = MaterializedSourceQuoteSchema.parse({
    sourceId,
    sessionId: turn.sessionId,
    turnIndex: turn.turnIndex,
    role: turn.role,
    timestamp: turn.timestamp,
    contentSha256,
    charStart,
    charEnd,
    byteStart,
    byteEnd,
    exact: turn.content.slice(charStart, charEnd),
    prefix: anchor.prefix,
    suffix: anchor.suffix,
  });
  return { source };
}

function compareSources(left: MaterializedSourceQuote, right: MaterializedSourceQuote): number {
  return left.sessionId.localeCompare(right.sessionId)
    || left.turnIndex - right.turnIndex
    || left.charStart - right.charStart
    || left.charEnd - right.charEnd;
}

function cardIdentity(
  draft: DraftAtomicCard,
  sources: readonly MaterializedSourceQuote[],
): string {
  return sha256(JSON.stringify({
    schemaVersion: 1,
    kind: draft.kind,
    normalizedText: draft.normalizedText,
    assertedBy: draft.assertedBy,
    speechAct: draft.speechAct,
    polarity: draft.polarity,
    modality: draft.modality,
    confidence: draft.confidence,
    eventTime: draft.eventTime,
    sourceIds: sources.map((source) => source.sourceId),
  }));
}

export function materializeAtomicCards(args: {
  turns: readonly AtomicCardSourceTurn[];
  drafts: readonly DraftAtomicCard[];
  derivation: AtomicCardDerivation;
}): AtomicCardMaterializationResult {
  const turns = z.array(AtomicCardSourceTurnSchema).parse(args.turns);
  const drafts = z.array(DraftAtomicCardSchema).parse(args.drafts);
  const derivation = AtomicCardDerivationSchema.parse(args.derivation);
  const turnMap = new Map<string, AtomicCardSourceTurn>();
  for (const turn of turns) {
    const key = turnKey(turn.sessionId, turn.turnIndex);
    if (turnMap.has(key)) throw new Error(`duplicate source turn ${turn.sessionId}:${String(turn.turnIndex)}`);
    turnMap.set(key, turn);
  }

  const cards: MaterializedAtomicCard[] = [];
  const quarantined: QuarantinedAtomicCard[] = [];
  for (let draftIndex = 0; draftIndex < drafts.length; draftIndex += 1) {
    const draft = drafts[draftIndex];
    if (!draft) continue;
    const sources: MaterializedSourceQuote[] = [];
    const issues: AtomicCardQuarantineIssue[] = [];
    for (let sourceIndex = 0; sourceIndex < draft.sources.length; sourceIndex += 1) {
      const anchor = draft.sources[sourceIndex];
      if (!anchor) continue;
      const resolved = resolveAnchor(anchor, turnMap);
      if ("reason" in resolved) {
        issues.push(AtomicCardQuarantineIssueSchema.parse({
          sourceIndex,
          reason: resolved.reason,
          detail: resolved.detail,
        }));
      } else {
        sources.push(resolved.source);
      }
    }
    if (issues.length > 0) {
      quarantined.push(QuarantinedAtomicCardSchema.parse({ draftIndex, draft, issues }));
      continue;
    }

    const uniqueSources = [...new Map(sources.map((source) => [source.sourceId, source])).values()]
      .sort(compareSources);
    const cardId = `card_${cardIdentity(draft, uniqueSources)}`;
    cards.push(MaterializedAtomicCardSchema.parse({
      schemaVersion: 1,
      cardId,
      kind: draft.kind,
      normalizedText: draft.normalizedText,
      assertedBy: draft.assertedBy,
      speechAct: draft.speechAct,
      polarity: draft.polarity,
      modality: draft.modality,
      confidence: draft.confidence,
      eventTime: draft.eventTime,
      sources: uniqueSources,
      derivation,
    }));
  }

  return AtomicCardMaterializationResultSchema.parse({ cards, quarantined });
}
