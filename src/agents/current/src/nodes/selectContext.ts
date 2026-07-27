import { renderSelectPrompt } from "../answer/renderAnswerPrompt.js";
import type { WorkflowRuntime } from "../runtime.js";
import type { MemoryStateType, MemoryStateUpdate } from "../state.js";
import {
  SelectOutputSchema,
  type ContextPackage,
  type ContextPackageItem,
  type TimestampedSession,
} from "../types.js";
import type { SelectedSpan } from "../retrieval/types.js";

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

function resolveTurn(
  sessions: TimestampedSession[],
  spans: SelectedSpan[],
  sessionId: string,
  turnIndex: number,
): { date: string; role: "user" | "assistant"; text: string } | null {
  const session = sessions.find((item) => item.session_id === sessionId);
  if (!session) return null;
  if (turnIndex < 0 || turnIndex >= session.turns.length) return null;
  const inBundle = spans.some(
    (span) =>
      span.sessionId === sessionId
      && turnIndex >= span.startTurn
      && turnIndex <= span.endTurn,
  );
  if (!inBundle) return null;
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
  queryShape: ContextPackage["queryShape"];
  setBoundary: string;
  question: string;
  selectedTexts: string[];
  siblingSessionsEnabled: boolean;
  siblingSessionMax: number;
}): Array<{ sessionId: string; turnIndex: number; why: string }> {
  if (args.selectedSessionIds.size === 0) return [];

  const allowedSessions = new Set(args.selectedSessionIds);
  const expandSiblings =
    args.siblingSessionsEnabled && SET_EXPAND_SHAPES.has(args.queryShape);

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
  for (const span of args.spans) {
    if (!allowedSessions.has(span.sessionId)) continue;
    const fromSelected = args.selectedSessionIds.has(span.sessionId);
    for (const turn of span.turns) {
      if (turn.role !== "user" && args.queryShape !== "update-conflict") continue;
      extras.push({
        sessionId: span.sessionId,
        turnIndex: turn.turnIndex,
        why: fromSelected
          ? "supporting turn from selected session"
          : "supporting turn from sibling session (set expansion)",
      });
    }
  }
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
}): { package: ContextPackage; warnings: string[] } {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const items: ContextPackageItem[] = [];
  let characterCount = 0;
  const supportingEnabled = args.packageSupportingEnabled ?? true;
  const siblingSessionsEnabled = args.siblingSessionsEnabled ?? true;
  const siblingSessionMax = args.siblingSessionMax ?? 12;

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
    const resolved = resolveTurn(args.sessions, args.spans, ref.sessionId, ref.turnIndex);
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
      queryShape: args.selectOutput.queryShape,
      setBoundary: args.selectOutput.setBoundary,
      question: args.question ?? "",
      selectedTexts: selectedItems.map((item) => item.text),
      siblingSessionsEnabled,
      siblingSessionMax,
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
    const prompt = await renderSelectPrompt(
      {
        question: state.question,
        questionDate: state.questionDate,
        retrieval: state.retrieval,
        packageMaxTurns: runtime.options.package_max_turns,
        promptName: runtime.options.select_prompt,
      },
      runtime.prompts,
    );
    const response = await runtime.models.generateStructured({
      role: "select",
      callKey: "select:context",
      prompt,
      schemaName: "select_v1",
      schema: SelectOutputSchema,
      artifacts: runtime.artifacts,
    });
    const built = buildContextPackage({
      selectOutput: response.value,
      sessions: state.sessions,
      spans: state.retrieval.spans,
      packageMaxTurns: runtime.options.package_max_turns,
      packageCharBudget: runtime.options.package_char_budget,
      packageSupportingEnabled: runtime.options.package_supporting_enabled,
      question: state.question,
      siblingSessionsEnabled: runtime.options.package_sibling_sessions_enabled,
      siblingSessionMax: runtime.options.package_sibling_session_max,
    });
    return {
      contextPackage: built.package,
      selectGeneration: response.generation,
      warnings: [...state.warnings, ...built.warnings],
      currentNode: "selectContext",
    };
  };
}
