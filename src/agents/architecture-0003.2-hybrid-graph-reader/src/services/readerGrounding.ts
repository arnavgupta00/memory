import type {
  JsonValue,
  MasterContextGraph,
  ReaderPlan,
  TimestampedSession,
} from "../types.js";

export type ExactSurfaceAnchor = {
  text: string;
  normalized: string;
  kind: "capitalized_phrase" | "capitalized_token" | "quoted_phrase";
};

export type ReaderGroundingIssue =
  | {
      code: "unknown_selected_session";
      sessionId: string;
    }
  | {
      code: "unknown_selected_turn";
      sessionId: string;
      turnIndex: number;
    }
  | {
      code: "unknown_selected_graph_pointer";
      pointer: string;
    }
  | {
      code: "fact_session_not_selected";
      factIndex: number;
      sessionId: string;
    }
  | {
      code: "fact_graph_pointer_not_selected";
      factIndex: number;
      pointer: string;
    }
  | {
      code: "fact_has_no_selected_source";
      factIndex: number;
    }
  | {
      code: "question_restatement_fact";
      factIndex: number;
    }
  | {
      code: "non_abstaining_plan_without_grounded_fact";
    }
  | {
      code: "unmatched_exact_surface_anchor";
      anchor: ExactSurfaceAnchor;
    };

export type ReaderGroundingResult = {
  valid: boolean;
  action: "accept" | "force_abstain";
  anchors: ExactSurfaceAnchor[];
  matchedAnchors: ExactSurfaceAnchor[];
  issues: ReaderGroundingIssue[];
};

export type EnforcedReaderGrounding = {
  plan: ReaderPlan;
  validation: ReaderGroundingResult;
  removedFactIndexes: number[];
};

const CAPITALIZED_WORD =
  String.raw`\p{Lu}[\p{L}\p{N}]*(?:[-'’][\p{L}\p{N}]+)*`;
const CAPITALIZED_SEQUENCE = new RegExp(
  `${CAPITALIZED_WORD}(?:\\s+${CAPITALIZED_WORD})*`,
  "gu",
);
const DOUBLE_QUOTED_PHRASE = /["“]([^"”\n]{2,120})["”]/gu;
const IGNORED_CAPITALIZED_TOKENS = new Set([
  "a",
  "an",
  "are",
  "can",
  "could",
  "describe",
  "did",
  "do",
  "does",
  "explain",
  "give",
  "had",
  "has",
  "have",
  "how",
  "i",
  "identify",
  "is",
  "list",
  "me",
  "my",
  "our",
  "please",
  "should",
  "tell",
  "the",
  "us",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "would",
]);
const GRAMMATICAL_CONTRACTION_SUFFIXES = new Set([
  "d",
  "ll",
  "m",
  "re",
  "s",
  "ve",
]);

function normalizeSurface(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replaceAll("_", " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function anchorKey(anchor: ExactSurfaceAnchor): string {
  return `${anchor.kind}:${anchor.normalized}`;
}

function uniqueAnchors(anchors: ExactSurfaceAnchor[]): ExactSurfaceAnchor[] {
  const seen = new Set<string>();
  return anchors.filter((anchor) => {
    const normalizedKey = anchorKey(anchor);
    if (seen.has(normalizedKey)) return false;
    seen.add(normalizedKey);
    return true;
  });
}

function contractionParts(
  value: string,
): { base: string; suffix: string } | null {
  const match = /^(.+?)['’]([\p{L}]+)$/u.exec(value.normalize("NFKC"));
  const rawBase = match?.[1];
  const rawSuffix = match?.[2];
  if (!rawBase || !rawSuffix) return null;
  const base = normalizeSurface(rawBase);
  const suffix = normalizeSurface(rawSuffix);
  if (!base || !GRAMMATICAL_CONTRACTION_SUFFIXES.has(suffix)) return null;
  return { base, suffix };
}

function isIgnoredFramingContraction(value: string): boolean {
  const parts = contractionParts(value);
  return parts !== null && IGNORED_CAPITALIZED_TOKENS.has(parts.base);
}

function isNamedPossessive(value: string): boolean {
  const parts = contractionParts(value);
  return (
    parts?.suffix === "s"
    && !IGNORED_CAPITALIZED_TOKENS.has(parts.base)
  );
}

/**
 * Extracts only exact surface forms that are visibly marked in the question.
 *
 * This deliberately does not attempt named-entity recognition. Multiword
 * capitalization, internal capitalized tokens, and double-quoted phrases are
 * treated as literal constraints because substituting a nearby spelling would
 * change the question. Sentence-initial singleton words are ignored.
 */
export function extractExactSurfaceAnchors(
  question: string,
): ExactSurfaceAnchor[] {
  const anchors: ExactSurfaceAnchor[] = [];
  for (const match of question.matchAll(DOUBLE_QUOTED_PHRASE)) {
    const text = match[1]?.trim();
    if (!text) continue;
    const normalized = normalizeSurface(text);
    if (!normalized) continue;
    anchors.push({ text, normalized, kind: "quoted_phrase" });
  }
  for (const match of question.matchAll(CAPITALIZED_SEQUENCE)) {
    const text = match[0].trim();
    const normalized = normalizeSurface(text);
    if (!normalized) continue;
    // Punctuation normalization turns contractions such as "I'm" into
    // "i m". Phrase classification must reflect the literal question surface,
    // not spaces introduced by normalization.
    const isPhrase = /\s/u.test(text);
    const isInternalToken = match.index > 0;
    if (!isPhrase && isIgnoredFramingContraction(text)) {
      continue;
    }
    if (
      !isPhrase
      && (
        (
          !isInternalToken
          || IGNORED_CAPITALIZED_TOKENS.has(normalized)
        )
        && !isNamedPossessive(text)
      )
    ) {
      continue;
    }
    anchors.push({
      text,
      normalized,
      kind: isPhrase ? "capitalized_phrase" : "capitalized_token",
    });
  }
  return uniqueAnchors(anchors);
}

function stripQuestionWrapper(value: string): string {
  let stripped = value;
  const wrappers = [
    /^(?:the )?user (?:asked|asks)\s+/u,
    /^(?:the )?(?:question|query)(?: is| was| asked| asks)?\s+/u,
  ];
  for (const wrapper of wrappers) {
    stripped = stripped.replace(wrapper, "");
  }
  return stripped;
}

export function isQuestionRestatement(
  question: string,
  statement: string,
): boolean {
  const normalizedQuestion = normalizeSurface(question);
  const normalizedStatement = normalizeSurface(statement);
  if (!normalizedQuestion || !normalizedStatement) return false;
  return (
    normalizedStatement === normalizedQuestion
    || stripQuestionWrapper(normalizedStatement) === normalizedQuestion
  );
}

function decodePointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function graphValueAtPointer(
  graph: MasterContextGraph,
  pointer: string,
): JsonValue | undefined {
  const segments = pointer.split("/").slice(1).map(decodePointerSegment);
  if (segments.shift() !== "context") return undefined;
  let current: JsonValue = graph.context;
  for (const segment of segments) {
    if (
      typeof current !== "object"
      || current === null
      || Array.isArray(current)
      || !Object.hasOwn(current, segment)
    ) {
      return undefined;
    }
    const next: JsonValue | undefined = current[segment];
    if (next === undefined) return undefined;
    current = next;
  }
  return current;
}

function graphValueText(value: JsonValue): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function sourceContainsAnchor(
  sourceTexts: string[],
  anchor: ExactSurfaceAnchor,
): boolean {
  return sourceTexts.some((text) =>
    normalizeSurface(text).includes(anchor.normalized),
  );
}

/**
 * Performs a conservative, deterministic grounding check over an already
 * schema-valid reader plan. It verifies source membership and exact question
 * surface constraints; it does not attempt semantic entailment.
 */
export function validateReaderGrounding(args: {
  question: string;
  plan: ReaderPlan;
  sessions: readonly TimestampedSession[];
  graph: MasterContextGraph;
}): ReaderGroundingResult {
  const issues: ReaderGroundingIssue[] = [];
  const sessionsById = new Map(
    args.sessions.map((session) => [session.session_id, session]),
  );
  const selectedSessionIds = new Set(
    args.plan.selectedSessions.map((selected) => selected.sessionId),
  );
  const selectedGraphPointers = new Set(args.plan.selectedGraphPointers);
  const selectedSourceTexts: string[] = [];

  for (const selected of args.plan.selectedSessions) {
    const session = sessionsById.get(selected.sessionId);
    if (!session) {
      issues.push({
        code: "unknown_selected_session",
        sessionId: selected.sessionId,
      });
      continue;
    }
    // A selected session is the evidence container. A later answer-bearing turn
    // can rely on entity or location context established earlier in that same
    // conversation, so exact anchors may be grounded anywhere in the selected
    // session. Unselected sessions remain excluded from this safety check.
    selectedSourceTexts.push(...session.turns.map((turn) => turn.content));
    for (const turnIndex of selected.turnIndexes) {
      const turn = session.turns[turnIndex];
      if (!turn) {
        issues.push({
          code: "unknown_selected_turn",
          sessionId: selected.sessionId,
          turnIndex,
        });
        continue;
      }
    }
  }

  for (const pointer of args.plan.selectedGraphPointers) {
    const value = graphValueAtPointer(args.graph, pointer);
    if (value === undefined) {
      issues.push({ code: "unknown_selected_graph_pointer", pointer });
      continue;
    }
    selectedSourceTexts.push(graphValueText(value));
  }

  let groundedFactCount = 0;
  args.plan.evidenceFacts.forEach((fact, factIndex) => {
    let factHasSelectedSource = false;
    for (const sessionId of fact.sessionIds) {
      if (!selectedSessionIds.has(sessionId)) {
        issues.push({
          code: "fact_session_not_selected",
          factIndex,
          sessionId,
        });
      } else {
        factHasSelectedSource = true;
      }
    }
    for (const pointer of fact.graphPointers) {
      if (!selectedGraphPointers.has(pointer)) {
        issues.push({
          code: "fact_graph_pointer_not_selected",
          factIndex,
          pointer,
        });
      } else {
        factHasSelectedSource = true;
      }
    }
    if (!factHasSelectedSource) {
      issues.push({ code: "fact_has_no_selected_source", factIndex });
    } else {
      groundedFactCount += 1;
    }
    if (isQuestionRestatement(args.question, fact.statement)) {
      issues.push({ code: "question_restatement_fact", factIndex });
    }
  });

  const claimsEvidence =
    args.plan.supportStatus !== "insufficient"
    || args.plan.answerMode !== "abstain";
  if (claimsEvidence && groundedFactCount === 0) {
    issues.push({ code: "non_abstaining_plan_without_grounded_fact" });
  }

  const anchors = claimsEvidence
    ? extractExactSurfaceAnchors(args.question)
    : [];
  const matchedAnchors: ExactSurfaceAnchor[] = [];
  for (const anchor of anchors) {
    if (sourceContainsAnchor(selectedSourceTexts, anchor)) {
      matchedAnchors.push(anchor);
    } else {
      issues.push({ code: "unmatched_exact_surface_anchor", anchor });
    }
  }

  return {
    valid: issues.length === 0,
    action: issues.length === 0 ? "accept" : "force_abstain",
    anchors,
    matchedAnchors,
    issues,
  };
}

/**
 * Prunes stray, ungrounded fact references before applying the atomic
 * abstention guard. One irrelevant extra fact must not discard other,
 * correctly grounded evidence.
 */
export function enforceReaderGrounding(args: {
  question: string;
  plan: ReaderPlan;
  sessions: readonly TimestampedSession[];
  graph: MasterContextGraph;
}): EnforcedReaderGrounding {
  const selectedSessionIds = new Set(
    args.plan.selectedSessions.map((selected) => selected.sessionId),
  );
  const selectedGraphPointers = new Set(args.plan.selectedGraphPointers);
  const removedFactIndexes: number[] = [];
  const evidenceFacts = args.plan.evidenceFacts.flatMap((fact, factIndex) => {
    if (isQuestionRestatement(args.question, fact.statement)) {
      removedFactIndexes.push(factIndex);
      return [];
    }
    const sessionIds = fact.sessionIds.filter((sessionId) =>
      selectedSessionIds.has(sessionId),
    );
    const graphPointers = fact.graphPointers.filter((pointer) =>
      selectedGraphPointers.has(pointer),
    );
    if (sessionIds.length === 0 && graphPointers.length === 0) {
      removedFactIndexes.push(factIndex);
      return [];
    }
    return [{ ...fact, sessionIds, graphPointers }];
  });
  const prunedPlan: ReaderPlan = {
    ...args.plan,
    evidenceFacts,
  };
  const validation = validateReaderGrounding({
    ...args,
    plan: prunedPlan,
  });
  return {
    plan: validation.action === "accept"
      ? prunedPlan
      : {
          supportStatus: "insufficient",
          answerMode: "abstain",
          selectedSessions: [],
          selectedGraphPointers: [],
          evidenceFacts: [],
          conflicts: [],
        },
    validation,
    removedFactIndexes,
  };
}
