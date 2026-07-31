import { createHash } from "node:crypto";

import type { SessionAnnotation } from "./notesIndex.js";

export type OpaqueSessionSpace = {
  sessionIds: string[];
  datesBySessionId: Map<string, string>;
  annotations: Map<string, SessionAnnotation>;
  realToOpaque: Map<string, string>;
  opaqueToReal: Map<string, string>;
};

function stableShuffleKey(namespace: string, sessionId: string): string {
  return createHash("sha256")
    .update("hop-retrieve-opaque-v1\0")
    .update(namespace)
    .update("\0")
    .update(sessionId)
    .digest("hex");
}

/**
 * Build deterministic, per-case opaque handles without using gold labels.
 *
 * Handles are assigned after a hash-based permutation so neither the original
 * haystack position nor the raw identifier is encoded in the visible handle.
 * The returned sessionIds preserve the original occurrence order for grep
 * semantics; only their labels change.
 */
export function buildOpaqueSessionSpace(args: {
  namespace: string;
  sessionIds: string[];
  datesBySessionId: Map<string, string>;
  annotations: Map<string, SessionAnnotation>;
}): OpaqueSessionSpace {
  const uniqueRealIds = [...new Set(args.sessionIds)];
  const shuffledRealIds = [...uniqueRealIds].sort((left, right) => {
    const byHash = stableShuffleKey(args.namespace, left).localeCompare(
      stableShuffleKey(args.namespace, right),
    );
    return byHash || left.localeCompare(right);
  });

  const realToOpaque = new Map<string, string>();
  const opaqueToReal = new Map<string, string>();
  for (let index = 0; index < shuffledRealIds.length; index += 1) {
    const realId = shuffledRealIds[index];
    if (!realId) continue;
    const opaqueId = `memory_${String(index + 1).padStart(3, "0")}`;
    realToOpaque.set(realId, opaqueId);
    opaqueToReal.set(opaqueId, realId);
  }

  const sessionIds = args.sessionIds.flatMap((realId) => {
    const opaqueId = realToOpaque.get(realId);
    return opaqueId ? [opaqueId] : [];
  });
  const datesBySessionId = new Map<string, string>();
  const annotations = new Map<string, SessionAnnotation>();
  for (const [realId, opaqueId] of realToOpaque) {
    datesBySessionId.set(opaqueId, args.datesBySessionId.get(realId) ?? "");
    const annotation = args.annotations.get(realId);
    if (annotation) annotations.set(opaqueId, annotation);
  }

  return {
    sessionIds,
    datesBySessionId,
    annotations,
    realToOpaque,
    opaqueToReal,
  };
}

/** Refuse an API call if any raw per-case identifier reached model input. */
export function assertNoRawSessionIdLeak(
  modelInput: string,
  rawSessionIds: Iterable<string>,
): void {
  for (const sessionId of rawSessionIds) {
    if (sessionId.length > 0 && modelInput.includes(sessionId)) {
      throw new Error("raw session ID leaked into hop-retriever model input");
    }
  }
}
