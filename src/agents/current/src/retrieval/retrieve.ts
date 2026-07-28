import type { TimestampedSession } from "../types.js";
import { Bm25Index } from "./bm25.js";
import { estimatePromptTokens, selectSpans } from "./select.js";
import { expandSeriesSiblingSpans } from "./seriesExpand.js";
import {
  DEFAULT_RETRIEVAL_OPTIONS,
  type RetrievalInput,
  type RetrievalOptions,
  type RetrievalResult,
} from "./types.js";
import { buildTurnWindows } from "./windows.js";

export function resolveRetrievalOptions(
  options: Partial<RetrievalOptions> | undefined,
): RetrievalOptions {
  return {
    ...DEFAULT_RETRIEVAL_OPTIONS,
    ...options,
  };
}

/** LongMemEval repeats a few session IDs with identical content and different dates. */
export function dedupeSessionsById(sessions: TimestampedSession[]): TimestampedSession[] {
  const seen = new Set<string>();
  const unique: TimestampedSession[] = [];
  for (const session of sessions) {
    if (seen.has(session.session_id)) continue;
    seen.add(session.session_id);
    unique.push(session);
  }
  return unique;
}

export function retrieveMemory(input: RetrievalInput & {
  seriesExpandEnabled?: boolean;
  seriesExpandMax?: number;
}): RetrievalResult {
  const options = resolveRetrievalOptions(input.options);
  const sessions = dedupeSessionsById(input.sessions);
  const windows = buildTurnWindows(
    sessions,
    options.windowTurns,
    options.windowStride,
  );
  const index = new Bm25Index(windows.map((window) => window.document));
  const ranked = index.search(input.question, options.topK, options.temporalBoost);
  let spans = selectSpans({
    sessions,
    windows,
    ranked,
    charBudget: options.charBudget,
    maxTurnChars: options.maxTurnChars,
  });
  if (input.seriesExpandEnabled) {
    spans = expandSeriesSiblingSpans({
      sessions,
      spans,
      maxSessions: input.seriesExpandMax ?? 16,
    });
  }
  const characterCount = spans.reduce((total, span) => total + span.characterCount, 0);
  return {
    windows,
    ranked,
    spans,
    characterCount,
    estimatedTokens: estimatePromptTokens(characterCount),
    options,
  };
}
