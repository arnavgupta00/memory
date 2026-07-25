import { personalSignals } from "./personalSignals.js";
import { graphHash, semanticMemoryCatalog } from "./graphMutations.js";
import { sha256 } from "./artifacts.js";
import type {
  ContextoCoverageRecord,
  ContextoMutation,
  MasterContextGraph,
  SemanticMemoryUpdate,
  TimestampedSession,
} from "../types.js";

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "had", "has", "have",
  "i", "in", "is", "it", "me", "my", "of", "on", "or", "our", "the", "to", "was", "we",
  "were", "with",
]);
const ANCHOR_WORDS = new Set([
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
  "twelve", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august", "september",
  "october", "november", "december", "today", "yesterday", "tomorrow",
]);

function normalize(value: string): string {
  return value
    .toLocaleLowerCase()
    .replaceAll(/[‘’]/g, "'")
    .replaceAll(/[“”]/g, "\"")
    .replaceAll(/[–—]/g, "-")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function tokens(value: string): string[] {
  return normalize(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function anchors(value: string): string[] {
  const result = tokens(value).filter((token) =>
    /\d/u.test(token) || ANCHOR_WORDS.has(token)
  );
  return [...new Set(result)];
}

function semanticTerms(value: string): string[] {
  return [...new Set(tokens(value).filter((token) =>
    token.length >= 3 && !STOP_WORDS.has(token) && !ANCHOR_WORDS.has(token) && !/\d/u.test(token)
  ))];
}

function pointerFor(update: SemanticMemoryUpdate): string {
  return `/context/${[update.domain, ...update.path].join("/")}`;
}

function sourceMatchesSignal(update: SemanticMemoryUpdate, signal: {
  sessionId: string;
  turnIndex: number;
  text: string;
}): boolean {
  const signalText = normalize(signal.text);
  return update.sources.some((source) => {
    if (
      source.sessionId !== signal.sessionId
      || source.turnIndex !== signal.turnIndex
      || source.excerpt === null
    ) {
      return false;
    }
    const excerpt = normalize(source.excerpt);
    return excerpt.includes(signalText) || signalText.includes(excerpt);
  });
}

function updateMatchesSignal(update: SemanticMemoryUpdate, signalText: string): {
  requiredAnchors: string[];
  matchedAnchors: string[];
  semanticMatch: boolean;
} {
  const requiredAnchors = anchors(signalText);
  const updateText = JSON.stringify({
    domain: update.domain,
    path: update.path,
    value: update.value,
    effectiveAt: update.effectiveAt,
    unit: update.unit,
    reason: update.reason,
  });
  const updateTokens = new Set(tokens(updateText));
  const matchedAnchors = requiredAnchors.filter((anchor) => updateTokens.has(anchor));
  const semanticMatch = semanticTerms(signalText).some((term) => updateTokens.has(term));
  return { requiredAnchors, matchedAnchors, semanticMatch };
}

function isDuplicate(beforeGraph: MasterContextGraph, update: SemanticMemoryUpdate): boolean {
  const path = [update.domain, ...update.path].join("/");
  const existing = semanticMemoryCatalog(beforeGraph).find((item) => item.path === path);
  if (!existing || existing.current === null || typeof existing.current !== "object") return false;
  const current = existing.current;
  if (Array.isArray(current) || current.value === undefined) return false;
  return sha256(current.value) === sha256(update.value)
    && (current.effective_at ?? null) === update.effectiveAt
    && (current.unit ?? null) === update.unit;
}

export function classifyContextoCoverage(args: {
  batchId: string;
  sessions: TimestampedSession[];
  beforeGraph: MasterContextGraph;
  afterGraph: MasterContextGraph;
  mutation: ContextoMutation | null;
  rejectedUpdateIndices: number[];
}): ContextoCoverageRecord {
  const signals = personalSignals(args.sessions).filter((signal) => signal.priority === "high");
  const rejected = new Set(args.rejectedUpdateIndices);
  const updates = args.mutation?.mode === "semantic_updates"
    ? args.mutation.updates.map((update, index) => ({ update, index }))
      .filter(({ index }) => !rejected.has(index))
    : [];
  const coverageSignals = signals.map((signal) => {
    const candidates = updates.flatMap(({ update, index }) => {
      if (!sourceMatchesSignal(update, signal)) return [];
      const match = updateMatchesSignal(update, signal.text);
      if (
        match.matchedAnchors.length !== match.requiredAnchors.length
        || !match.semanticMatch
      ) {
        return [];
      }
      return [{ update, index, ...match }];
    });
    if (candidates.length === 0) {
      return {
        signalId: signal.signalId,
        sessionId: signal.sessionId,
        turnIndex: signal.turnIndex,
        text: signal.text,
        status: "session_index_fallback" as const,
        requiredAnchors: anchors(signal.text),
        matchedAnchors: [],
        matchedUpdateIndices: [],
        matchedPointers: [],
        rationale: "no_deterministic_match" as const,
      };
    }
    const duplicate = candidates.every(({ update }) => isDuplicate(args.beforeGraph, update));
    return {
      signalId: signal.signalId,
      sessionId: signal.sessionId,
      turnIndex: signal.turnIndex,
      text: signal.text,
      status: duplicate ? "duplicate" as const : "graph_covered" as const,
      requiredAnchors: candidates[0]?.requiredAnchors ?? [],
      matchedAnchors: [...new Set(candidates.flatMap((candidate) => candidate.matchedAnchors))],
      matchedUpdateIndices: candidates.map((candidate) => candidate.index),
      matchedPointers: [...new Set(candidates.map(({ update }) => pointerFor(update)))],
      rationale: duplicate ? "existing_memory" as const : "accepted_update" as const,
    };
  });
  return {
    schemaVersion: 1,
    batchId: args.batchId,
    graphRevisionBefore: args.beforeGraph.revision,
    graphRevisionAfter: args.afterGraph.revision,
    graphHash: graphHash(args.afterGraph),
    highPrioritySignalCount: coverageSignals.length,
    counts: {
      graphCovered: coverageSignals.filter((signal) => signal.status === "graph_covered").length,
      duplicate: coverageSignals.filter((signal) => signal.status === "duplicate").length,
      sessionIndexFallback: coverageSignals.filter(
        (signal) => signal.status === "session_index_fallback"
      ).length,
    },
    signals: coverageSignals,
  };
}
