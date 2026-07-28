import { renderSelectPrompt } from "../answer/renderAnswerPrompt.js";
import type { WorkflowRuntime } from "../runtime.js";
import type { MemoryStateType, MemoryStateUpdate } from "../state.js";
import {
  SelectOutputSchema,
  SelectOutputWithExpandSchema,
  type ContextPackage,
  type ContextPackageItem,
  type TimestampedSession,
} from "../types.js";
import type { SelectedSpan } from "../retrieval/types.js";
import {
  buildSessionIndex,
  formatSessionIndex,
} from "../retrieval/sessionIndex.js";
import { sessionToFullSpan } from "../retrieval/seriesExpand.js";
import { dedupeSessionsById } from "../retrieval/retrieve.js";

const SET_EXPAND_SHAPES = new Set<ContextPackage["queryShape"]>([
  "aggregate",
  "order",
]);

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "in",
  "on",
  "for",
  "to",
  "was",
  "were",
  "is",
  "are",
  "i",
  "my",
  "me",
  "we",
  "you",
  "that",
  "this",
  "with",
  "from",
  "at",
  "by",
  "as",
  "be",
  "been",
  "have",
  "has",
  "had",
  "it",
  "its",
  "over",
  "past",
  "before",
  "after",
  "which",
  "what",
  "how",
  "many",
  "did",
  "do",
  "most",
  "based",
  "user",
  "stated",
  "none",
  "n/a",
  "than",
  "then",
  "into",
  "about",
  "just",
  "only",
  "also",
  "not",
  "any",
  "all",
  "can",
  "could",
  "would",
  "should",
  "will",
  "within",
]);

function sessionInBundle(spans: SelectedSpan[], sessionId: string): boolean {
  return spans.some((span) => span.sessionId === sessionId);
}

function turnInSpan(
  spans: SelectedSpan[],
  sessionId: string,
  turnIndex: number,
): boolean {
  return spans.some(
    (span) =>
      span.sessionId === sessionId
      && turnIndex >= span.startTurn
      && turnIndex <= span.endTurn,
  );
}

function resolveTurn(
  sessions: TimestampedSession[],
  spans: SelectedSpan[],
  sessionId: string,
  turnIndex: number,
  fullSessionEnabled: boolean,
): { date: string; role: "user" | "assistant"; text: string } | null {
  const session = sessions.find((item) => item.session_id === sessionId);
  if (!session) return null;
  if (turnIndex < 0 || turnIndex >= session.turns.length) return null;
  const reachable = fullSessionEnabled
    ? sessionInBundle(spans, sessionId)
    : turnInSpan(spans, sessionId, turnIndex);
  if (!reachable) return null;
  const turn = session.turns[turnIndex];
  if (!turn) return null;
  return { date: session.date, role: turn.role, text: turn.content };
}

/** Export for tests / offline rebuild. */
export function tokenizeForPackage(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (match.length < 3 || STOPWORDS.has(match)) continue;
    out.add(match);
  }
  return out;
}

function overlapCount(left: Set<string>, right: Iterable<string>): number {
  let count = 0;
  for (const token of right) {
    if (left.has(token)) count += 1;
  }
  return count;
}

function seedTokens(args: {
  question: string;
  setBoundary: string;
  selectedTexts: string[];
}): Set<string> {
  const seed = new Set<string>();
  for (const token of tokenizeForPackage(
    `${args.question}\n${args.setBoundary}\n${args.selectedTexts.join("\n")}`,
  )) {
    seed.add(token);
  }
  return seed;
}

function scoreSiblingSession(args: {
  spans: SelectedSpan[];
  seed: Set<string>;
}): number {
  if (args.seed.size === 0) return 0;
  let score = 0;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const span of args.spans) {
    score += overlapCount(args.seed, span.matchedTerms) * 3;
    for (const turn of span.turns) {
      if (turn.role !== "user") continue;
      score += overlapCount(args.seed, tokenizeForPackage(turn.content));
    }
    bestRank = Math.min(bestRank, span.bestRank);
  }
  if (score <= 0) return 0;
  // Prefer higher lexical overlap; break ties with better BM25 rank.
  return score * 1000 + Math.max(0, 500 - bestRank);
}

/** Supporting turns: same-session always; sibling sessions for aggregate/order. */
export function supportingRefs(args: {
  selectedSessionIds: Set<string>;
  spans: SelectedSpan[];
  sessions?: TimestampedSession[];
  queryShape: ContextPackage["queryShape"];
  setBoundary: string;
  question: string;
  selectedTexts: string[];
  siblingSessionsEnabled: boolean;
  siblingSessionMax: number;
  fullSessionEnabled?: boolean;
  sessionTurnMax?: number;
}): Array<{ sessionId: string; turnIndex: number; why: string }> {
  if (args.selectedSessionIds.size === 0) return [];

  const allowedSessions = new Set(args.selectedSessionIds);
  const expandSiblings =
    args.siblingSessionsEnabled && SET_EXPAND_SHAPES.has(args.queryShape);
  const fullSessionEnabled = args.fullSessionEnabled ?? true;
  const sessionTurnMax = args.sessionTurnMax ?? 24;

  if (expandSiblings) {
    const seed = seedTokens({
      question: args.question,
      setBoundary: args.setBoundary,
      selectedTexts: args.selectedTexts,
    });
    const bySession = new Map<string, SelectedSpan[]>();
    for (const span of args.spans) {
      if (args.selectedSessionIds.has(span.sessionId)) continue;
      const list = bySession.get(span.sessionId) ?? [];
      list.push(span);
      bySession.set(span.sessionId, list);
    }
    const ranked = [...bySession.entries()]
      .map(([sessionId, sessionSpans]) => ({
        sessionId,
        score: scoreSiblingSession({ spans: sessionSpans, seed }),
      }))
      .filter((row) => row.score > 0)
      .sort((left, right) => right.score - left.score || left.sessionId.localeCompare(right.sessionId))
      .slice(0, args.siblingSessionMax);
    for (const row of ranked) {
      allowedSessions.add(row.sessionId);
    }
  }

  const extras: Array<{ sessionId: string; turnIndex: number; why: string }> = [];
  const seenExtra = new Set<string>();
  const pushExtra = (
    sessionId: string,
    turnIndex: number,
    why: string,
  ): void => {
    const key = `${sessionId}:${String(turnIndex)}`;
    if (seenExtra.has(key)) return;
    seenExtra.add(key);
    extras.push({ sessionId, turnIndex, why });
  };

  const appendSpanTurns = (sessionIds: Set<string>, sibling: boolean): void => {
    for (const span of args.spans) {
      if (!sessionIds.has(span.sessionId)) continue;
      for (const turn of span.turns) {
        if (turn.role !== "user" && args.queryShape !== "update-conflict") continue;
        pushExtra(
          span.sessionId,
          turn.turnIndex,
          sibling
            ? "supporting turn from sibling session (set expansion)"
            : "supporting turn from selected session",
        );
      }
    }
  };

  const appendFullSessionTurns = (sessionIds: Set<string>, sibling: boolean): void => {
    if (!fullSessionEnabled || !args.sessions) return;
    const byId = new Map(args.sessions.map((session) => [session.session_id, session]));
    const perSession = new Map<string, number>();
    for (const ref of extras) {
      if (!sessionIds.has(ref.sessionId)) continue;
      perSession.set(ref.sessionId, (perSession.get(ref.sessionId) ?? 0) + 1);
    }
    for (const sessionId of [...sessionIds].sort((left, right) => left.localeCompare(right))) {
      if (!sessionInBundle(args.spans, sessionId)) continue;
      const session = byId.get(sessionId);
      if (!session) continue;
      let taken = perSession.get(sessionId) ?? 0;
      for (let turnIndex = 0; turnIndex < session.turns.length; turnIndex += 1) {
        if (taken >= sessionTurnMax) break;
        const turn = session.turns[turnIndex];
        if (!turn) continue;
        if (turn.role !== "user" && args.queryShape !== "update-conflict") continue;
        const before = seenExtra.size;
        pushExtra(
          sessionId,
          turnIndex,
          sibling
            ? "supporting turn from sibling session (set expansion, full session)"
            : "supporting turn from selected session (full session)",
        );
        if (seenExtra.size > before) {
          taken += 1;
        }
      }
    }
  };

  const siblingIds = new Set(
    [...allowedSessions].filter((sessionId) => !args.selectedSessionIds.has(sessionId)),
  );

  // Selected sessions first so out-of-window gold is not crowded by siblings.
  appendSpanTurns(args.selectedSessionIds, false);
  appendFullSessionTurns(args.selectedSessionIds, false);
  appendSpanTurns(siblingIds, true);
  appendFullSessionTurns(siblingIds, true);
  return extras;
}

function sortWithinTier(items: ContextPackageItem[]): ContextPackageItem[] {
  const rank = (tier: ContextPackageItem["tier"]) => (tier === "selected" ? 0 : 1);
  return [...items].sort((left, right) => {
    const byTier = rank(left.tier) - rank(right.tier);
    if (byTier !== 0) return byTier;
    const byDate = left.date.localeCompare(right.date);
    if (byDate !== 0) return byDate;
    const bySession = left.sessionId.localeCompare(right.sessionId);
    if (bySession !== 0) return bySession;
    return left.turnIndex - right.turnIndex;
  });
}

export function buildContextPackage(args: {
  selectOutput: {
    queryShape: ContextPackage["queryShape"];
    setBoundary: string;
    candidateStatus: ContextPackage["candidateStatus"];
    missingRisk: string;
    items: Array<{ sessionId: string; turnIndex: number; why: string }>;
  };
  sessions: TimestampedSession[];
  spans: SelectedSpan[];
  packageMaxTurns: number;
  packageCharBudget: number;
  packageSupportingEnabled?: boolean;
  question?: string;
  siblingSessionsEnabled?: boolean;
  siblingSessionMax?: number;
  fullSessionEnabled?: boolean;
  sessionTurnMax?: number;
}): { package: ContextPackage; warnings: string[] } {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const items: ContextPackageItem[] = [];
  let characterCount = 0;
  const supportingEnabled = args.packageSupportingEnabled ?? true;
  const siblingSessionsEnabled = args.siblingSessionsEnabled ?? true;
  const siblingSessionMax = args.siblingSessionMax ?? 12;
  const fullSessionEnabled = args.fullSessionEnabled ?? true;
  const sessionTurnMax = args.sessionTurnMax ?? 24;

  const candidateStatus =
    args.selectOutput.candidateStatus === "none_found"
    || args.selectOutput.items.length === 0
      ? "none_found"
      : "found";

  // Empty selected set is the correct signal — do not invent supporting filler.
  if (candidateStatus === "none_found") {
    return {
      package: {
        queryShape: args.selectOutput.queryShape,
        setBoundary: args.selectOutput.setBoundary,
        candidateStatus: "none_found",
        missingRisk: args.selectOutput.missingRisk,
        items: [],
        characterCount: 0,
        estimatedTokens: 0,
      },
      warnings,
    };
  }

  const pushItem = (
    ref: { sessionId: string; turnIndex: number; why: string },
    tier: ContextPackageItem["tier"],
  ): boolean => {
    if (items.length >= args.packageMaxTurns) {
      warnings.push("dropped_package_max_turns");
      return false;
    }
    const key = `${ref.sessionId}:${String(ref.turnIndex)}`;
    if (seen.has(key)) return true;
    const resolved = resolveTurn(
      args.sessions,
      args.spans,
      ref.sessionId,
      ref.turnIndex,
      fullSessionEnabled,
    );
    if (!resolved) {
      if (tier === "selected") {
        warnings.push(`dropped_unknown_select:${key}`);
      }
      return true;
    }
    if (characterCount + resolved.text.length > args.packageCharBudget && items.length > 0) {
      warnings.push("dropped_package_char_budget");
      return false;
    }
    seen.add(key);
    characterCount += resolved.text.length;
    items.push({
      sessionId: ref.sessionId,
      turnIndex: ref.turnIndex,
      date: resolved.date,
      role: resolved.role,
      text: resolved.text,
      why: ref.why,
      tier,
    });
    return true;
  };

  for (const ref of args.selectOutput.items) {
    if (!pushItem(ref, "selected")) break;
  }

  if (supportingEnabled) {
    const selectedItems = items.filter((item) => item.tier === "selected");
    const selectedSessions = new Set(selectedItems.map((item) => item.sessionId));
    const extras = supportingRefs({
      selectedSessionIds: selectedSessions,
      spans: args.spans,
      sessions: args.sessions,
      queryShape: args.selectOutput.queryShape,
      setBoundary: args.selectOutput.setBoundary,
      question: args.question ?? "",
      selectedTexts: selectedItems.map((item) => item.text),
      siblingSessionsEnabled,
      siblingSessionMax,
      fullSessionEnabled,
      sessionTurnMax,
    });
    for (const ref of extras) {
      if (!pushItem(ref, "supporting")) break;
    }
  }

  const sorted = sortWithinTier(items);
  return {
    package: {
      queryShape: args.selectOutput.queryShape,
      setBoundary: args.selectOutput.setBoundary,
      candidateStatus: "found",
      missingRisk: args.selectOutput.missingRisk,
      items: sorted,
      characterCount,
      estimatedTokens: Math.ceil(characterCount / 4),
    },
    warnings,
  };
}

function mergeExpandedSpans(
  spans: SelectedSpan[],
  sessions: TimestampedSession[],
  expandSessionIds: string[],
  expandMax: number,
): { spans: SelectedSpan[]; warnings: string[] } {
  const warnings: string[] = [];
  const byId = new Map(sessions.map((session) => [session.session_id, session]));
  const covered = new Set(spans.map((span) => span.sessionId));
  const merged = [...spans];
  let added = 0;
  for (const sessionId of expandSessionIds) {
    if (added >= expandMax) break;
    if (covered.has(sessionId)) continue;
    const session = byId.get(sessionId);
    if (!session) {
      warnings.push(`expand_unknown_session:${sessionId}`);
      continue;
    }
    merged.push(sessionToFullSpan(session));
    covered.add(sessionId);
    added += 1;
  }
  return { spans: merged, warnings };
}

export function createSelectContextNode(runtime: WorkflowRuntime) {
  return async (state: MemoryStateType): Promise<MemoryStateUpdate> => {
    if (!state.retrieval) throw new Error("selectContext requires retrieval");
    if (!runtime.options.select_enabled) {
      return { currentNode: "selectContext" };
    }
    await runtime.events.record(
      "node_started",
      { node: "selectContext", call_key: "select:context" },
      null,
    );

    const sessions = dedupeSessionsById(state.sessions);
    const sessionIndexEnabled = runtime.options.session_index_enabled;
    const sessionExpandMax = runtime.options.session_expand_max;
    const sessionIndexText = sessionIndexEnabled
      ? formatSessionIndex(buildSessionIndex(sessions))
      : undefined;

    const selectSchema = sessionIndexEnabled
      ? SelectOutputWithExpandSchema
      : SelectOutputSchema;
    const schemaName = sessionIndexEnabled ? "select_v5" : "select_v1";

    const promptArgs = {
      question: state.question,
      questionDate: state.questionDate,
      retrieval: state.retrieval,
      packageMaxTurns: runtime.options.package_max_turns,
      promptName: runtime.options.select_prompt,
      ...(sessionIndexText !== undefined ? { sessionIndexText } : {}),
      sessionExpandMax,
    };
    const prompt = await renderSelectPrompt(promptArgs, runtime.prompts);
    const response = await runtime.models.generateStructured({
      role: "select",
      callKey: "select:context",
      prompt,
      schemaName,
      schema: selectSchema,
      artifacts: runtime.artifacts,
    });

    let spans = state.retrieval.spans;
    let selectOutput: {
      queryShape: "lookup" | "aggregate" | "order" | "update-conflict";
      setBoundary: string;
      candidateStatus: "found" | "none_found";
      missingRisk: string;
      items: Array<{ sessionId: string; turnIndex: number; why: string }>;
    } = response.value;
    const expandWarnings: string[] = [];
    const expandSessions = sessionIndexEnabled
      ? (("expandSessions" in response.value
          ? response.value.expandSessions
          : []) as string[])
      : [];

    if (sessionIndexEnabled && expandSessions.length > 0) {
      const merged = mergeExpandedSpans(
        spans,
        sessions,
        expandSessions,
        sessionExpandMax,
      );
      spans = merged.spans;
      expandWarnings.push(...merged.warnings);
      if (merged.spans.length > state.retrieval.spans.length) {
        const expandedRetrieval = {
          ...state.retrieval,
          spans,
          characterCount: spans.reduce((total, span) => total + span.characterCount, 0),
        };
        const secondPrompt = await renderSelectPrompt(
          {
            question: state.question,
            questionDate: state.questionDate,
            retrieval: expandedRetrieval,
            packageMaxTurns: runtime.options.package_max_turns,
            promptName: runtime.options.select_prompt,
            ...(sessionIndexText !== undefined ? { sessionIndexText } : {}),
            sessionExpandMax: 0,
          },
          runtime.prompts,
        );
        const second = await runtime.models.generateStructured({
          role: "select",
          callKey: "select:context-expand",
          prompt: secondPrompt,
          schemaName,
          schema: selectSchema,
          artifacts: runtime.artifacts,
        });
        selectOutput = second.value;
      }
    }

    const built = buildContextPackage({
      selectOutput,
      sessions: state.sessions,
      spans,
      packageMaxTurns: runtime.options.package_max_turns,
      packageCharBudget: runtime.options.package_char_budget,
      packageSupportingEnabled: runtime.options.package_supporting_enabled,
      question: state.question,
      siblingSessionsEnabled: runtime.options.package_sibling_sessions_enabled,
      siblingSessionMax: runtime.options.package_sibling_session_max,
      fullSessionEnabled: runtime.options.package_full_session_enabled,
      sessionTurnMax: runtime.options.package_session_turn_max,
    });
    return {
      contextPackage: built.package,
      selectGeneration: response.generation,
      warnings: [...state.warnings, ...expandWarnings, ...built.warnings],
      currentNode: "selectContext",
    };
  };
}
