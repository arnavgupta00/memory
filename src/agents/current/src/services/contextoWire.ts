import type {
  ContextoMutation,
  ContextoWireMutation,
  JsonObject,
  JsonTreeObject,
  JsonTreeValue,
  JsonValue,
  MasterContextGraph,
  SemanticMemoryWireUpdate,
  TimestampedSession,
} from "../types.js";
import { MemoryDomainSchema } from "../types.js";
import { semanticMemoryCatalog } from "./graphMutations.js";
import { personalSignalIndex, type IndexedPersonalSignal } from "./personalSignals.js";
import { boundMutationSourceExcerpts } from "./sourceExcerpts.js";

export function decodeJsonTree(value: JsonTreeValue): JsonValue {
  if (value.kind === "string" || value.kind === "number" || value.kind === "boolean") {
    return value.value;
  }
  if (value.kind === "null") return null;
  if (value.kind === "array") return value.items.map(decodeJsonTree);
  return decodeJsonTreeObject(value);
}

export function decodeJsonTreeObject(value: JsonTreeObject): JsonObject {
  const output: JsonObject = {};
  for (const entry of value.entries) {
    if (Object.hasOwn(output, entry.key)) {
      throw new Error(`tagged JSON object contains duplicate key: ${entry.key}`);
    }
    output[entry.key] = decodeJsonTree(entry.value);
  }
  return output;
}

function normalizeEvidence(value: string): string {
  const normalized = value
    .toLocaleLowerCase()
    .replaceAll(/\\(["'])/g, "$1")
    .replaceAll(/[‘’]/g, "'")
    .replaceAll(/[“”]/g, '"')
    .replaceAll(/[–—]/g, "-")
    .replaceAll(/\s+([,.;:!?])/g, "$1")
    .replaceAll(/\s+/g, " ")
    .trim();
  if (
    normalized.length >= 2
    && ((normalized.startsWith('"') && normalized.endsWith('"'))
      || (normalized.startsWith("'") && normalized.endsWith("'")))
  ) {
    return normalized.slice(1, -1).trim();
  }
  return normalized;
}

function evidenceTokens(value: string): string[] {
  return normalizeEvidence(value)
    .replaceAll(/[^\p{L}\p{N}']+/gu, " ")
    .split(" ")
    .filter(Boolean);
}

function bestWindowCoverage(needle: string[], haystack: string[]): number {
  if (needle.length < 6 || haystack.length === 0) return 0;
  const minimumWindow = Math.max(1, Math.floor(needle.length * 0.75));
  const maximumWindow = Math.min(haystack.length, Math.ceil(needle.length * 1.25));
  let best = 0;
  for (let size = minimumWindow; size <= maximumWindow; size += 1) {
    for (let start = 0; start + size <= haystack.length; start += 1) {
      const window = haystack.slice(start, start + size);
      const counts = new Map<string, number>();
      for (const token of window) counts.set(token, (counts.get(token) ?? 0) + 1);
      let matched = 0;
      for (const token of needle) {
        const count = counts.get(token) ?? 0;
        if (count > 0) {
          matched += 1;
          counts.set(token, count - 1);
        }
      }
      best = Math.max(best, matched / needle.length);
    }
  }
  return best;
}

function slotIndex(slot: string): number {
  return Number(slot.slice(slot.indexOf("_") + 1)) - 1;
}

function isStrictPathPrefix(parent: string[], child: string[]): boolean {
  return parent.length < child.length && parent.every((segment, index) => child[index] === segment);
}

function normalizeMaterializedSignalUpdates(
  signal: IndexedPersonalSignal,
  updates: SemanticMemoryWireUpdate[],
): SemanticMemoryWireUpdate[] {
  const resolvedDate = signal.operandHints.resolvedDates[0]?.isoDate;
  if (!resolvedDate || !signal.reasons.includes("completed_event")) return updates;
  const datedUpdates = updates.map((update) =>
    update.memoryType === "event" && update.effectiveAt === null
      ? { ...update, effectiveAt: resolvedDate }
      : update
  );
  const stableEventPath = ["user", "autobiographical_events", signal.signalId];
  if (datedUpdates.some((update) =>
    update.domain === "events"
    && update.path.length === stableEventPath.length
    && update.path.every((segment, index) => segment === stableEventPath[index])
  )) {
    return datedUpdates;
  }
  return [
    ...datedUpdates,
    {
      domain: "events",
      path: stableEventPath,
      memoryType: "event",
      updateMode: "set",
      value: {
        kind: "object",
        entries: [
          { key: "statement", value: { kind: "string", value: signal.text } },
          { key: "occurred_on", value: { kind: "string", value: resolvedDate } },
        ],
      },
      effectiveAt: resolvedDate,
      unit: null,
      sources: [{
        sessionSlot: signal.sessionSlot,
        turnSlot: signal.turnSlot,
        evidenceQuote: signal.text,
      }],
      reason: "deterministic dated-event preservation for a materialized personal signal",
    },
  ];
}

const FREQUENCY_PATH_STOP_WORDS = new Set([
  "account",
  "activity",
  "current",
  "event",
  "fact",
  "frequency",
  "measurement",
  "people",
  "preference",
  "routine",
  "routines",
  "schedule",
  "user",
  "weekly",
]);

function lexicalTokens(value: string): string[] {
  return value
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/gu)
    .filter((token) => token.length >= 3 && !FREQUENCY_PATH_STOP_WORDS.has(token));
}

function deterministicFrequencyUpdates(
  signals: IndexedPersonalSignal[],
  existingUpdates: SemanticMemoryWireUpdate[],
  graph: MasterContextGraph | undefined,
): SemanticMemoryWireUpdate[] {
  if (!graph) return [];
  const catalog = semanticMemoryCatalog(graph);
  return signals.flatMap((signal) => {
    const frequency = signal.operandHints.frequencies[0];
    if (!frequency) return [];
    const signalTokens = new Set(lexicalTokens(signal.text));
    const candidates = catalog.flatMap((item) => {
      const path = typeof item.path === "string" ? item.path : null;
      if (!path || !path.toLocaleLowerCase().includes("frequency")) return [];
      const parts = path.split("/").filter(Boolean);
      const domain = MemoryDomainSchema.safeParse(parts[0]);
      if (!domain.success || parts.length < 3) return [];
      const score = lexicalTokens(path).filter((token) => signalTokens.has(token)).length;
      return score > 0 ? [{ path, parts, domain: domain.data, score }] : [];
    }).sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
    const best = candidates[0];
    if (!best || (candidates[1]?.score ?? -1) === best.score) return [];
    const relativePath = best.parts.slice(1);
    if (existingUpdates.some((update) =>
      update.domain === best.domain
      && update.path.length === relativePath.length
      && update.path.every((segment, index) => segment === relativePath[index])
    )) {
      return [];
    }
    return [{
      domain: best.domain,
      path: relativePath,
      memoryType: "fact",
      updateMode: "set",
      value: {
        kind: "string",
        value: frequency.surface.replace(/\btimes?\s+a\s+/iu, "times per "),
      },
      effectiveAt: null,
      unit: frequency.unit,
      sources: [{
        sessionSlot: signal.sessionSlot,
        turnSlot: signal.turnSlot,
        evidenceQuote: signal.text,
      }],
      reason: "deterministic update of one unambiguous existing frequency facet",
    }];
  });
}

function deterministicOperandLedgerUpdates(
  signals: IndexedPersonalSignal[],
): SemanticMemoryWireUpdate[] {
  return signals.flatMap((signal) => {
    const basePath = ["user", "signal_operands", signal.signalId];
    const source = {
      sessionSlot: signal.sessionSlot,
      turnSlot: signal.turnSlot,
      evidenceQuote: signal.text,
    };
    return [
      ...signal.operandHints.resolvedDates.map((operand, index) => ({
        domain: "measurements" as const,
        path: [...basePath, `resolved_date_${String(index + 1)}`],
        memoryType: "measurement" as const,
        updateMode: "set" as const,
        value: { kind: "string" as const, value: operand.isoDate },
        effectiveAt: operand.isoDate,
        unit: "date",
        sources: [source],
        reason: "deterministic normalized date operand from a high-priority signal",
      })),
      ...signal.operandHints.clockTimes.map((operand, index) => ({
        domain: "measurements" as const,
        path: [...basePath, `clock_time_${String(index + 1)}`],
        memoryType: "measurement" as const,
        updateMode: "set" as const,
        value: { kind: "string" as const, value: operand.normalized },
        effectiveAt: null,
        unit: "clock_time",
        sources: [source],
        reason: "deterministic normalized clock-time operand from a high-priority signal",
      })),
      ...signal.operandHints.durations.map((operand, index) => ({
        domain: "measurements" as const,
        path: [...basePath, `duration_${String(index + 1)}`],
        memoryType: "measurement" as const,
        updateMode: "set" as const,
        value: { kind: "number" as const, value: operand.value },
        effectiveAt: null,
        unit: operand.unit,
        sources: [source],
        reason: "deterministic normalized duration operand from a high-priority signal",
      })),
      ...signal.operandHints.frequencies.map((operand, index) => ({
        domain: "measurements" as const,
        path: [...basePath, `frequency_${String(index + 1)}`],
        memoryType: "measurement" as const,
        updateMode: "set" as const,
        value: { kind: "number" as const, value: operand.value },
        effectiveAt: null,
        unit: operand.unit,
        sources: [source],
        reason: "deterministic normalized frequency operand from a high-priority signal",
      })),
      ...signal.operandHints.numericRanges.map((operand, index) => ({
        domain: "measurements" as const,
        path: [...basePath, `numeric_range_${String(index + 1)}`],
        memoryType: "measurement" as const,
        updateMode: "set" as const,
        value: {
          kind: "object" as const,
          entries: [
            { key: "minimum", value: { kind: "number" as const, value: operand.minimum } },
            { key: "maximum", value: { kind: "number" as const, value: operand.maximum } },
          ],
        },
        effectiveAt: null,
        unit: operand.unit,
        sources: [source],
        reason: "deterministic normalized numeric-range operand from a high-priority signal",
      })),
    ];
  });
}

function resolveEvidence(
  sessions: TimestampedSession[],
  sessionIndex: number,
  turnIndex: number,
  evidenceQuote: string,
): { session: TimestampedSession; turnIndex: number; excerpt: string | null; warning?: string } | null {
  const needle = normalizeEvidence(evidenceQuote);
  const declaredSession = sessions[sessionIndex];
  const declaredTurn = declaredSession?.turns[turnIndex];
  if (!declaredSession || !declaredTurn) return null;
  if (normalizeEvidence(declaredTurn.content).includes(needle)) {
    return { session: declaredSession, turnIndex, excerpt: evidenceQuote };
  }
  const matches = sessions.flatMap((session, index) =>
    session.turns.flatMap((turn, turnIndex) =>
      normalizeEvidence(turn.content).includes(needle) ? [{ session, index, turnIndex }] : [],
    ),
  );
  if (matches.length === 1 && matches[0]) {
    return {
      session: matches[0].session,
      turnIndex: matches[0].turnIndex,
      excerpt: evidenceQuote,
      warning: `evidence location corrected from session_${String(sessionIndex + 1)}/turn_${String(turnIndex + 1)} to session_${String(matches[0].index + 1)}/turn_${String(matches[0].turnIndex + 1)}`,
    };
  }

  const needleTokens = evidenceTokens(evidenceQuote);
  const candidates = sessions.flatMap((session, candidateSessionIndex) =>
    session.turns.map((turn, candidateTurnIndex) => ({
      session,
      sessionIndex: candidateSessionIndex,
      turnIndex: candidateTurnIndex,
      score: bestWindowCoverage(needleTokens, evidenceTokens(turn.content)),
    })),
  )
    .sort((left, right) => right.score - left.score);
  const best = candidates[0];
  const runnerUp = candidates[1];
  if (best && best.score >= 0.84 && (!runnerUp || best.score - runnerUp.score >= 0.08)) {
    return {
      session: best.session,
      turnIndex: best.turnIndex,
      excerpt: null,
      warning: `evidence quote resolved to session_${String(best.sessionIndex + 1)}/turn_${String(best.turnIndex + 1)} at ${best.score.toFixed(2)} token coverage`,
    };
  }
  return {
    session: declaredSession,
    turnIndex,
    excerpt: null,
    warning: "evidence quote did not match transcript; declared session/turn provenance retained for audit",
  };
}

export function decodeContextoMutation(
  wire: ContextoWireMutation,
  sourceContext?: {
    batchId: string;
    sessions: TimestampedSession[];
    graph?: MasterContextGraph;
  },
): ContextoMutation {
  if (wire.mode === "semantic_updates") {
    if (!sourceContext) throw new Error("semantic Contexto output requires batch source context");
    const { sessionAudits } = wire;
    const requiredSignals = personalSignalIndex(sourceContext.sessions).requiredHighPrioritySignals;
    const expectedSignalIds = new Set(requiredSignals.map((signal) => signal.signalId));
    const requiredSignalById = new Map(requiredSignals.map((signal) => [signal.signalId, signal]));
    const seenSignalIds = new Set<string>();
    const recognizedResolutions = wire.requiredSignalResolutions.filter((resolution) => {
      if (!expectedSignalIds.has(resolution.signalId) || seenSignalIds.has(resolution.signalId)) {
        return false;
      }
      seenSignalIds.add(resolution.signalId);
      return true;
    });
    const modelWireUpdates = [
      ...recognizedResolutions.flatMap((resolution) => {
        if (resolution.disposition !== "materialized") return [];
        const signal = requiredSignalById.get(resolution.signalId);
        return signal
          ? normalizeMaterializedSignalUpdates(signal, resolution.updates)
          : [];
      }),
      ...wire.additionalUpdates,
    ];
    const wireUpdates = [
      ...modelWireUpdates,
      ...deterministicFrequencyUpdates(requiredSignals, modelWireUpdates, sourceContext.graph),
      ...deterministicOperandLedgerUpdates(requiredSignals),
    ];
    const decodedUpdates = wireUpdates.map((update) => {
      const sourceWarnings: string[] = [];
      const decodedSources = update.sources.map((source) => {
        const sessionIndex = slotIndex(source.sessionSlot);
        const turnIndex = slotIndex(source.turnSlot);
        const resolved = resolveEvidence(sourceContext.sessions, sessionIndex, turnIndex, source.evidenceQuote);
        if (resolved?.warning) sourceWarnings.push(resolved.warning);
        return {
          sessionId: resolved?.session.session_id ?? `__invalid_evidence_${source.sessionSlot}`,
          turnIndex: resolved?.turnIndex ?? 0,
          sessionDate: resolved?.session.date ?? "__invalid_evidence__",
          batchId: sourceContext.batchId,
          excerpt: resolved?.excerpt ?? null,
        };
      });
      const validSources = decodedSources.filter((source) => !source.sessionId.startsWith("__invalid_evidence_"));
      const invalidCount = decodedSources.length - validSources.length;
      if (invalidCount > 0) {
        sourceWarnings.push(`${String(invalidCount)} evidence quote(s) could not be resolved`);
      }
      const normalizedPath = update.path.filter(
        (segment) => segment !== update.domain || update.path.length <= 2,
      );
      if (normalizedPath.length !== update.path.length) {
        sourceWarnings.push(`removed redundant domain segment '${update.domain}' from semantic path`);
      }
      return {
        ...update,
        path: normalizedPath,
        value: decodeJsonTree(update.value),
        sources: validSources.length > 0 ? validSources : decodedSources.slice(0, 1),
        ...(sourceWarnings.length === 0 ? {} : { sourceWarnings }),
      };
    });
    const redundantParentPaths = decodedUpdates
      .filter((candidate) => decodedUpdates.some((other) => isStrictPathPrefix(candidate.path, other.path)))
      .map((update) => update.path);
    const updates = decodedUpdates
      .filter((update) => !redundantParentPaths.some((path) => path.length === update.path.length && path.every((part, index) => update.path[index] === part)))
      .map((update) => {
        const removedParents = redundantParentPaths.filter((path) => isStrictPathPrefix(path, update.path));
        if (removedParents.length === 0) return update;
        return {
          ...update,
          sourceWarnings: [
            ...(update.sourceWarnings ?? []),
            ...removedParents.map((path) => `discarded redundant parent-value update at ${path.join("/")}`),
          ],
        };
      });
    return boundMutationSourceExcerpts({
      mode: wire.mode,
      batchSummary: wire.batchSummary,
      updates,
      ignoredSessions: sessionAudits.flatMap((item) =>
        item.disposition === "extract_personal_memory"
          ? []
          : [{
              sessionId: sourceContext.sessions[slotIndex(item.sessionSlot)]?.session_id
                ?? `__invalid_ignored_${item.sessionSlot}`,
              reason: item.disposition,
            }],
      ),
    });
  }
  if (wire.mode === "replace_graph") {
    return boundMutationSourceExcerpts({
      ...wire,
      graph: decodeJsonTreeObject(wire.graph),
    });
  }
  return boundMutationSourceExcerpts({
    ...wire,
    operations: wire.operations.map((operation) => {
      if (operation.op === "add" || operation.op === "replace") {
        return { ...operation, value: decodeJsonTree(operation.value) };
      }
      return operation;
    }),
  });
}
