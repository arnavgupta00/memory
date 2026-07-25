import {
  type ContextoMutation,
  type GraphDiff,
  type GraphMutationRecord,
  type JsonObject,
  type JsonPatchOperation,
  type JsonValue,
  type MasterContextGraph,
  type SemanticMemoryUpdate,
  type SourceReference,
} from "../types.js";
import { sha256 } from "./artifacts.js";

const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const FORBIDDEN_MEMORY_KEYS = new Set([
  "master",
  "master_graph",
  "context",
  "schema_version",
  "revision",
  "provenance",
  "provenance_by_pointer",
  "session",
  "sessions",
  "session_id",
  "turn",
  "turns",
  "role",
  "content",
  "message",
  "messages",
  "batch",
]);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function decodePointer(path: string): string[] {
  if (!path.startsWith("/context/")) throw new Error(`path must start with /context/: ${path}`);
  return path
    .slice(9)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function encodePointer(parts: string[]): string {
  return `/context/${parts.map((part) => part.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

function validateKey(key: string): void {
  if (DANGEROUS_KEYS.has(key) || key.startsWith("$") || !SNAKE_CASE.test(key)) {
    throw new Error(`unsafe or non-snake-case context key: ${key}`);
  }
}

function validateMemoryKey(key: string): void {
  validateKey(key);
  if (FORBIDDEN_MEMORY_KEYS.has(key)) {
    throw new Error(`forbidden transcript or runtime key in semantic memory: ${key}`);
  }
}

type JsonReference = { $ref: string };

function isReference(value: JsonObject): value is JsonReference {
  return Object.keys(value).length === 1 && typeof value.$ref === "string";
}

function validateValue(value: JsonValue, depth = 0): void {
  if (depth > 24) throw new Error("context tree exceeds maximum depth 24");
  if (Array.isArray(value)) {
    value.forEach((item) => validateValue(item, depth + 1));
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (isReference(value)) {
    if (!value.$ref.startsWith("/context/")) {
      throw new Error("$ref must contain an absolute context pointer");
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    validateKey(key);
    validateValue(item, depth + 1);
  }
}

function parentAt(root: JsonObject, parts: string[]): [JsonObject, string] {
  if (!parts.length) throw new Error("context root cannot be mutated directly");
  const key = parts.at(-1);
  if (!key) throw new Error("patch path has no terminal key");
  validateKey(key);
  let current: JsonObject = root;
  for (const part of parts.slice(0, -1)) {
    const next: JsonValue | undefined = current[part];
    if (next === undefined || next === null || Array.isArray(next) || typeof next !== "object") {
      throw new Error(`patch parent does not exist: ${part}`);
    }
    current = next;
  }
  return [current, key];
}

function leafPointers(value: JsonValue, parts: string[] = []): string[] {
  if (Array.isArray(value) || value === null || typeof value !== "object" || isReference(value)) {
    return parts.length ? [encodePointer(parts)] : [];
  }
  return Object.entries(value).flatMap(([key, child]) => leafPointers(child, [...parts, key]));
}

function validateSources(
  sources: SourceReference[],
  allowed: Map<string, { date: string; turnCount: number }>,
  batchId: string,
): void {
  for (const source of sources) {
    const session = allowed.get(source.sessionId);
    if (!session) throw new Error(`source session is outside current batch: ${source.sessionId}`);
    if (source.batchId !== batchId) throw new Error(`source batch mismatch: ${source.batchId}`);
    if (source.sessionDate !== session.date) throw new Error(`source date mismatch: ${source.sessionId}`);
    if (source.turnIndex >= session.turnCount) throw new Error(`source turn is outside session: ${source.sessionId}`);
  }
}

function mergeSources(existing: SourceReference[], incoming: SourceReference[]): SourceReference[] {
  const seen = new Set<string>();
  return [...existing, ...incoming].filter((source) => {
    const key = `${source.sessionId}:${source.turnIndex}:${source.batchId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceKey(source: SourceReference): string {
  return `${source.sessionId}:${String(source.turnIndex)}:${source.sessionDate}:${source.batchId}`;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMemoryCell(value: JsonValue | undefined): value is JsonObject {
  return isJsonObject(value)
    && typeof value.memory_type === "string"
    && isJsonObject(value.current)
    && isJsonObject(value.history);
}

function semanticParent(root: JsonObject, parts: string[]): [JsonObject, string] {
  if (!parts.length) throw new Error("semantic memory path cannot be empty");
  parts.forEach(validateMemoryKey);
  const key = parts.at(-1);
  if (!key) throw new Error("semantic memory path has no terminal key");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (next === undefined) {
      const branch: JsonObject = {};
      current[part] = branch;
      current = branch;
      continue;
    }
    if (!isJsonObject(next) || isMemoryCell(next)) {
      throw new Error(`semantic path crosses a value instead of a branch: ${part}`);
    }
    current = next;
  }
  return [current, key];
}

function reconcileObservationPath(context: JsonObject, parts: string[], update: SemanticMemoryUpdate): string[] {
  if (update.updateMode !== "record_observation") return parts;
  let current: JsonObject = context;
  for (const [index, part] of parts.entries()) {
    const next = current[part];
    if (isMemoryCell(next)) {
      if (next.memory_type !== update.memoryType) {
        throw new Error(`observation path crosses a different memory type: ${encodePointer(parts.slice(0, index + 1))}`);
      }
      return parts.slice(0, index + 1);
    }
    if (next === undefined) return parts;
    if (!isJsonObject(next)) return parts;
    current = next;
  }
  return parts;
}

function moveProvenancePrefix(
  provenance: Record<string, SourceReference[]>,
  from: string,
  to: string,
): void {
  for (const [pointer, sources] of Object.entries({ ...provenance })) {
    if (pointer === from || pointer.startsWith(`${from}/`)) {
      provenance[`${to}${pointer.slice(from.length)}`] = sources;
      delete provenance[pointer];
    }
  }
}

function writeAssertionProvenance(
  provenance: Record<string, SourceReference[]>,
  cellParts: string[],
  assertion: JsonObject,
  sources: SourceReference[],
): void {
  const cellPointer = encodePointer(cellParts);
  provenance[cellPointer] = mergeSources(provenance[cellPointer] ?? [], sources);
  const currentParts = [...cellParts, "current"];
  const currentPointer = encodePointer(currentParts);
  for (const pointer of Object.keys(provenance)) {
    if (pointer === currentPointer || pointer.startsWith(`${currentPointer}/`)) delete provenance[pointer];
  }
  for (const pointer of leafPointers(assertion, currentParts)) provenance[pointer] = sources;
}

function distinctValues(left: JsonValue, right: JsonValue): JsonValue[] {
  const values = [
    ...(Array.isArray(left) ? left : [left]),
    ...(Array.isArray(right) ? right : [right]),
  ];
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = sha256(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function assertionFor(update: SemanticMemoryUpdate): JsonObject {
  const observedAt = update.sources.at(-1)?.sessionDate;
  if (!observedAt) throw new Error("semantic update has no resolvable observation date");
  return {
    value: clone(update.value),
    observed_at: observedAt,
    effective_at: update.effectiveAt,
    unit: update.unit,
  };
}

function comparableTime(value: JsonValue | undefined): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function applySemanticUpdate(
  context: JsonObject,
  provenance: Record<string, SourceReference[]>,
  update: SemanticMemoryUpdate,
): GraphDiff | null {
  if (/\bno new (?:durable )?(?:information|memory)\b/i.test(update.reason)) {
    throw new Error("semantic update declares that it contains no new durable memory");
  }
  const parts = reconcileObservationPath(context, [update.domain, ...update.path], update);
  const [parent, key] = semanticParent(context, parts);
  const before = parent[key];
  if (before !== undefined && !isMemoryCell(before)) {
    throw new Error(`semantic target is not a managed memory cell: ${encodePointer(parts)}`);
  }
  validateValue(update.value);
  const nextAssertion = assertionFor(update);
  if (before === undefined) {
    const cell: JsonObject = {
      memory_type: update.memoryType,
      current: nextAssertion,
      history: {},
    };
    parent[key] = cell;
    writeAssertionProvenance(provenance, parts, nextAssertion, update.sources);
    return { op: "add", path: encodePointer(parts), after: clone(cell) };
  }

  const current = before.current;
  const history = before.history;
  if (!isJsonObject(current) || !isJsonObject(history)) throw new Error("managed memory cell is malformed");
  const beforeCell = clone(before);
  const previousValue = current.value;
  if (previousValue === undefined) throw new Error("managed memory cell has no current value");
  const currentEffectiveAt = comparableTime(current.effective_at);
  const nextEffectiveAt = comparableTime(nextAssertion.effective_at);
  if (
    update.updateMode === "record_observation"
    && currentEffectiveAt !== null
    && nextEffectiveAt !== null
    && nextEffectiveAt < currentEffectiveAt
  ) {
    const beforeCell = clone(before);
    const historyKey = `observation_${sha256(nextAssertion).slice(0, 12)}`;
    history[historyKey] = clone(nextAssertion);
    const cellPointer = encodePointer(parts);
    provenance[cellPointer] = mergeSources(provenance[cellPointer] ?? [], update.sources);
    for (const pointer of leafPointers(nextAssertion, [...parts, "history", historyKey])) {
      provenance[pointer] = update.sources;
    }
    return { op: "replace", path: cellPointer, before: beforeCell, after: clone(before) };
  }
  const nextValue = update.updateMode === "append"
    ? distinctValues(previousValue, update.value)
    : update.value;
  const substantivelyEqual = sha256(previousValue) === sha256(nextValue)
    && current.effective_at === update.effectiveAt
    && current.unit === update.unit;
  if (substantivelyEqual && update.updateMode !== "record_observation") {
    writeAssertionProvenance(provenance, parts, current, update.sources);
    return null;
  }

  const historyKey = `observation_${sha256(current).slice(0, 12)}`;
  history[historyKey] = clone(current);
  const currentPointer = `${encodePointer(parts)}/current`;
  moveProvenancePrefix(provenance, currentPointer, `${encodePointer(parts)}/history/${historyKey}`);
  const replacement: JsonObject = {
    value: clone(nextValue),
    observed_at: nextAssertion.observed_at ?? null,
    effective_at: update.effectiveAt,
    unit: update.unit,
  };
  before.current = replacement;
  before.memory_type = update.memoryType;
  writeAssertionProvenance(provenance, parts, replacement, update.sources);
  return { op: "replace", path: encodePointer(parts), before: beforeCell, after: clone(before) };
}

export type SemanticUpdateRejection = { index: number; reason: string };

export function semanticMemoryCatalog(graph: MasterContextGraph): JsonObject[] {
  const result: JsonObject[] = [];
  const visit = (value: JsonValue, parts: string[]): void => {
    if (isMemoryCell(value)) {
      const history = value.history;
      result.push({
        path: parts.join("/"),
        memory_type: typeof value.memory_type === "string" ? value.memory_type : "fact",
        current: clone(value.current ?? null),
        history_count: isJsonObject(history) ? Object.keys(history).length : 0,
      });
      return;
    }
    if (isJsonObject(value)) {
      for (const [key, child] of Object.entries(value)) visit(child, [...parts, key]);
    }
  };
  visit(graph.context, []);
  return result;
}

function writeLeafProvenance(
  provenance: Record<string, SourceReference[]>,
  pathParts: string[],
  value: JsonValue,
  sources: SourceReference[],
  preserveExisting: boolean,
): void {
  const rootPath = encodePointer(pathParts);
  const existing = { ...provenance };
  for (const pointer of Object.keys(provenance)) {
    if (pointer === rootPath || pointer.startsWith(`${rootPath}/`)) delete provenance[pointer];
  }
  for (const pointer of leafPointers(value, pathParts)) {
    provenance[pointer] = mergeSources(preserveExisting ? existing[pointer] ?? [] : [], sources);
  }
}

function applyPatchOperation(
  context: JsonObject,
  provenance: Record<string, SourceReference[]>,
  operation: JsonPatchOperation,
): GraphDiff {
  const parts = decodePointer(operation.path);
  const [parent, key] = parentAt(context, parts);
  const before = parent[key];
  if (operation.op === "add") {
    if (before !== undefined) throw new Error(`add target already exists: ${operation.path}`);
    validateValue(operation.value);
    parent[key] = clone(operation.value);
    writeLeafProvenance(provenance, parts, operation.value, operation.sources, false);
    return { op: "add", path: operation.path, after: clone(operation.value) };
  }
  if (operation.op === "replace") {
    if (before === undefined) throw new Error(`replace target does not exist: ${operation.path}`);
    validateValue(operation.value);
    parent[key] = clone(operation.value);
    writeLeafProvenance(provenance, parts, operation.value, operation.sources, true);
    return { op: "replace", path: operation.path, before: clone(before), after: clone(operation.value) };
  }
  if (operation.op === "remove") {
    if (before === undefined) throw new Error(`remove target does not exist: ${operation.path}`);
    delete parent[key];
    for (const pointer of Object.keys(provenance)) {
      if (pointer === operation.path || pointer.startsWith(`${operation.path}/`)) delete provenance[pointer];
    }
    return { op: "remove", path: operation.path, before: clone(before) };
  }
  const fromParts = decodePointer(operation.from);
  const [fromParent, fromKey] = parentAt(context, fromParts);
  const moved = fromParent[fromKey];
  if (moved === undefined) throw new Error(`move source does not exist: ${operation.from}`);
  if (before !== undefined) throw new Error(`move target already exists: ${operation.path}`);
  delete fromParent[fromKey];
  parent[key] = moved;
  for (const [pointer, sources] of Object.entries({ ...provenance })) {
    if (pointer === operation.from || pointer.startsWith(`${operation.from}/`)) {
      const next = `${operation.path}${pointer.slice(operation.from.length)}`;
      provenance[next] = mergeSources(sources, pointer === operation.from ? operation.sources : []);
      delete provenance[pointer];
    }
  }
  return { op: "move", path: operation.path, from: operation.from, after: clone(moved) };
}

function validateReferences(context: JsonObject): void {
  const pointers = new Set(leafPointers(context));
  const visit = (value: JsonValue): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (value === null || typeof value !== "object") return;
    if (isReference(value)) {
      if (!pointers.has(value.$ref)) {
        throw new Error(`unresolved context reference: ${value.$ref}`);
      }
      return;
    }
    Object.values(value).forEach(visit);
  };
  visit(context);
}

export function applyContextoMutation(args: {
  graph: MasterContextGraph;
  mutation: ContextoMutation;
  batchId: string;
  sessions: Array<{ session_id: string; date: string; turns: unknown[] }>;
  allowReplacement: boolean;
}): {
  graph: MasterContextGraph;
  diffs: GraphDiff[];
  acceptedUpdateCount: number;
  rejectedUpdates: SemanticUpdateRejection[];
  auditWarnings: string[];
} {
  const allowed = new Map(
    args.sessions.map((session) => [session.session_id, { date: session.date, turnCount: session.turns.length }]),
  );
  const next = clone(args.graph);
  const beforeLeaves = new Set(leafPointers(next.context));
  let diffs: GraphDiff[] = [];

  if (args.mutation.mode === "semantic_updates") {
    const rejectedUpdates: SemanticUpdateRejection[] = [];
    const auditWarnings = args.mutation.updates.flatMap((update) => update.sourceWarnings ?? []);
    let acceptedUpdateCount = 0;
    for (const [index, update] of args.mutation.updates.entries()) {
      try {
        validateSources(update.sources, allowed, args.batchId);
        const trialContext = clone(next.context);
        const trialProvenance = clone(next.provenanceByPointer);
        const diff = applySemanticUpdate(trialContext, trialProvenance, update);
        validateValue(trialContext);
        validateReferences(trialContext);
        next.context = trialContext;
        next.provenanceByPointer = trialProvenance;
        if (diff) diffs.push(diff);
        acceptedUpdateCount += 1;
      } catch (error) {
        rejectedUpdates.push({ index, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    const cited = new Set(args.mutation.updates.flatMap((update) => update.sources.map((source) => source.sessionId)));
    const ignored = new Set<string>();
    for (const item of args.mutation.ignoredSessions) {
      if (!allowed.has(item.sessionId)) {
        auditWarnings.push(`ignored-session audit names a session outside current batch: ${item.sessionId}`);
      } else if (ignored.has(item.sessionId)) {
        auditWarnings.push(`ignored-session audit duplicates session: ${item.sessionId}`);
      } else if (cited.has(item.sessionId)) {
        auditWarnings.push(`session is both cited by memory and marked ignored: ${item.sessionId}`);
      }
      ignored.add(item.sessionId);
    }
    for (const sessionId of allowed.keys()) {
      if (!cited.has(sessionId) && !ignored.has(sessionId)) {
        auditWarnings.push(`session is missing from both semantic updates and ignored-session audit: ${sessionId}`);
      }
    }
    if (acceptedUpdateCount > 0) next.revision += 1;
    return { graph: next, diffs, acceptedUpdateCount, rejectedUpdates, auditWarnings };
  }

  if (args.mutation.mode === "patch") {
    for (const operation of args.mutation.operations) {
      validateSources(operation.sources, allowed, args.batchId);
      diffs.push(applyPatchOperation(next.context, next.provenanceByPointer, operation));
    }
  } else {
    if (!args.allowReplacement) throw new Error("whole-graph replacement is disabled");
    validateValue(args.mutation.graph);
    const migrationBySource = new Map(args.mutation.migration.map((item) => [item.from, item]));
    if (migrationBySource.size !== args.mutation.migration.length) {
      throw new Error("replacement contains duplicate migration sources");
    }
    for (const pointer of beforeLeaves) {
      if (!migrationBySource.has(pointer)) throw new Error(`replacement migration omits existing leaf: ${pointer}`);
    }
    for (const pointer of migrationBySource.keys()) {
      if (!beforeLeaves.has(pointer)) throw new Error(`replacement migration names unknown leaf: ${pointer}`);
    }
    const replacementProvenance = Object.fromEntries(
      args.mutation.provenance.map((item) => [item.pointer, item.sources]),
    );
    if (Object.keys(replacementProvenance).length !== args.mutation.provenance.length) {
      throw new Error("replacement contains duplicate provenance pointers");
    }
    const replacementLeaves = new Set(leafPointers(args.mutation.graph));
    const priorByTarget = new Map<string, SourceReference[]>();
    for (const item of args.mutation.migration) {
      validateSources(item.sources, allowed, args.batchId);
      if (item.outcome === "removed") {
        if (item.to !== null) throw new Error(`removed migration must use a null target: ${item.from}`);
        continue;
      }
      if (item.to === null) throw new Error(`migration target required: ${item.from}`);
      if (item.outcome === "preserved" && item.to !== item.from) {
        throw new Error(`preserved migration must keep its pointer: ${item.from}`);
      }
      if (!replacementLeaves.has(item.to)) throw new Error(`migration target is not a replacement leaf: ${item.to}`);
      const prior = next.provenanceByPointer[item.from];
      if (!prior?.length) throw new Error(`existing leaf lacks provenance: ${item.from}`);
      priorByTarget.set(item.to, mergeSources(priorByTarget.get(item.to) ?? [], prior));
    }
    for (const pointer of Object.keys(replacementProvenance)) {
      if (!replacementLeaves.has(pointer)) throw new Error(`replacement provenance names non-leaf: ${pointer}`);
    }
    for (const pointer of replacementLeaves) {
      const sources = replacementProvenance[pointer];
      if (!sources?.length) throw new Error(`replacement leaf lacks provenance: ${pointer}`);
      const prior = priorByTarget.get(pointer) ?? [];
      const sourceKeys = new Set(sources.map(sourceKey));
      for (const oldSource of prior) {
        if (!sourceKeys.has(sourceKey(oldSource))) {
          throw new Error(`replacement loses provenance at ${pointer}`);
        }
      }
      const priorKeys = new Set(prior.map(sourceKey));
      for (const source of sources) {
        if (!priorKeys.has(sourceKey(source))) validateSources([source], allowed, args.batchId);
      }
    }
    diffs = [
      {
        op: "replace",
        path: "/context",
        before: clone(next.context),
        after: clone(args.mutation.graph),
      },
    ];
    next.context = clone(args.mutation.graph);
    next.provenanceByPointer = replacementProvenance;
  }
  validateValue(next.context);
  validateReferences(next.context);
  next.revision += 1;
  return {
    graph: next,
    diffs,
    acceptedUpdateCount: args.mutation.mode === "patch" ? args.mutation.operations.length : 1,
    rejectedUpdates: [],
    auditWarnings: [],
  };
}

export function graphHash(graph: MasterContextGraph): string {
  return sha256(graph as unknown as JsonObject);
}

export function replayMutationRecords(
  records: GraphMutationRecord[],
  initial: MasterContextGraph = { schemaVersion: 1, revision: 0, context: {}, provenanceByPointer: {} },
): MasterContextGraph {
  let graph = clone(initial);
  for (const record of records) {
    if (!record.accepted || !record.mutation) continue;
    if (record.mutation.mode === "semantic_updates") {
      const rejectedIndices = new Set((record.rejectedUpdates ?? []).map((item) => item.index));
      if (rejectedIndices.size !== (record.rejectedUpdates ?? []).length) {
        throw new Error(`semantic replay has duplicate rejected-update indices: ${record.batchId}`);
      }
      for (const index of rejectedIndices) {
        if (index < 0 || index >= record.mutation.updates.length) {
          throw new Error(`semantic replay has invalid rejected-update index ${String(index)}: ${record.batchId}`);
        }
      }
      const acceptedUpdates = record.mutation.updates.filter((_, index) => !rejectedIndices.has(index));
      if (record.acceptedUpdateCount !== undefined && acceptedUpdates.length !== record.acceptedUpdateCount) {
        throw new Error(`semantic replay accepted-update count mismatch: ${record.batchId}`);
      }
      const sessionShapes = new Map<string, { session_id: string; date: string; maxTurn: number }>();
      for (const update of acceptedUpdates) {
        for (const source of update.sources) {
          const existing = sessionShapes.get(source.sessionId);
          sessionShapes.set(source.sessionId, {
            session_id: source.sessionId,
            date: source.sessionDate,
            maxTurn: Math.max(existing?.maxTurn ?? 0, source.turnIndex),
          });
        }
      }
      const replayed = applyContextoMutation({
        graph,
        mutation: { ...record.mutation, updates: acceptedUpdates },
        batchId: record.batchId,
        sessions: [...sessionShapes.values()].map((session) => ({
          session_id: session.session_id,
          date: session.date,
          turns: Array.from({ length: session.maxTurn + 1 }, () => ({})),
        })),
        allowReplacement: true,
      });
      graph = replayed.graph;
    } else if (record.mutation.mode === "patch") {
      const context = clone(graph.context);
      const provenance = clone(graph.provenanceByPointer);
      for (const operation of record.mutation.operations) {
        applyPatchOperation(context, provenance, operation);
      }
      graph = { ...graph, revision: graph.revision + 1, context, provenanceByPointer: provenance };
    } else {
      graph = {
        schemaVersion: 1,
        revision: graph.revision + 1,
        context: clone(record.mutation.graph),
        provenanceByPointer: Object.fromEntries(
          record.mutation.provenance.map((item) => [item.pointer, clone(item.sources)]),
        ),
      };
    }
    if (graphHash(graph) !== record.graphHash) throw new Error(`graph replay hash mismatch: ${record.batchId}`);
  }
  return graph;
}
