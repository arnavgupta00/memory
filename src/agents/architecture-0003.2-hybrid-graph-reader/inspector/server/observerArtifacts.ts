import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import type { JsonObject, JsonValue } from "../../src/types.js";

export type CoverageTotals = {
  graphCovered: number;
  duplicate: number;
  sessionIndexFallback: number;
  highPrioritySignals: number;
};

export type RetrievalChannelCounts = {
  session: number;
  graphCell: number;
  summary: number;
  coverageFallback: number;
  tail: number;
};

export type RoleCallMetric = {
  role: string;
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalLatencyMs: number;
  averageLatencyMs: number;
  retries: number;
  models: string[];
};

export type ObserverArtifacts = {
  schemaVersion: 1;
  legacy: boolean;
  coverage: {
    available: boolean;
    totals: CoverageTotals;
    records: JsonObject[];
  };
  retrieval: {
    available: boolean;
    question: string | null;
    questionDate: string | null;
    algorithm: string | null;
    parameters: JsonObject;
    indexed: RetrievalChannelCounts;
    candidates: RetrievalChannelCounts;
    sessions: JsonValue[];
    graphCells: JsonValue[];
    summaries: JsonValue[];
    coverageFallbackSessions: JsonValue[];
    tailSessions: JsonValue[];
  };
  readerPlan: JsonObject | null;
  finalContext: {
    available: boolean;
    kind: "compact_reader_context" | "legacy_full_context" | "unavailable";
    value: JsonObject | null;
  };
  roleMetrics: RoleCallMetric[];
};

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function asArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function numberValue(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringValue(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

async function readOptionalJson(path: string): Promise<JsonObject | null> {
  try {
    return asObject(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return null;
  }
}

async function readCoverageRecords(
  casePath: string,
  batchLimit?: number,
): Promise<JsonObject[]> {
  const directory = resolve(casePath, "contexto-coverage");
  const files = (await readdir(directory).catch(() => []))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const selected = batchLimit === undefined ? files : files.slice(0, batchLimit);
  const records = await Promise.all(
    selected.map((name) => readOptionalJson(resolve(directory, name))),
  );
  return records.filter((record): record is JsonObject => record !== null);
}

function coverageTotals(records: JsonObject[]): CoverageTotals {
  return records.reduce<CoverageTotals>(
    (totals, record) => {
      const counts = asObject(record.counts);
      totals.graphCovered += numberValue(counts.graphCovered);
      totals.duplicate += numberValue(counts.duplicate);
      totals.sessionIndexFallback += numberValue(
        counts.sessionIndexFallback,
      );
      totals.highPrioritySignals += numberValue(record.highPrioritySignalCount);
      return totals;
    },
    {
      graphCovered: 0,
      duplicate: 0,
      sessionIndexFallback: 0,
      highPrioritySignals: 0,
    },
  );
}

function retrievalCounts(
  value: JsonObject,
  source: "documentCounts" | "candidateArrays",
): RetrievalChannelCounts {
  if (source === "documentCounts") {
    const counts = asObject(value.documentCounts);
    return {
      session: numberValue(counts.session),
      graphCell: numberValue(counts.graph_cell),
      summary: numberValue(counts.summary),
      coverageFallback: numberValue(counts.coverage_fallback),
      tail: numberValue(counts.tail),
    };
  }
  return {
    session: asArray(value.sessions).length,
    graphCell: asArray(value.graphCells).length,
    summary: asArray(value.summaries).length,
    coverageFallback: asArray(value.coverageFallbackSessions).length,
    tail: asArray(value.tailSessions).length,
  };
}

type MutableRoleMetric = Omit<
  RoleCallMetric,
  "averageLatencyMs" | "models"
> & {
  models: Set<string>;
};

function callRecord(item: JsonObject): JsonObject {
  const nested = asObject(item.call);
  return Object.keys(nested).length > 0 ? nested : item;
}

function roleMetrics(modelCalls: JsonObject[]): RoleCallMetric[] {
  const metrics = new Map<string, MutableRoleMetric>();
  for (const artifact of modelCalls) {
    const call = callRecord(artifact);
    const role = stringValue(call.role) ?? "unknown";
    const metric = metrics.get(role) ?? {
      role,
      calls: 0,
      failures: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalLatencyMs: 0,
      retries: 0,
      models: new Set<string>(),
    };
    metric.calls += 1;
    const usage = asObject(call.usage);
    metric.inputTokens += numberValue(usage.input_tokens);
    metric.outputTokens += numberValue(usage.output_tokens);
    metric.totalTokens += numberValue(usage.total_tokens);
    metric.totalLatencyMs += numberValue(call.latency_ms);
    metric.retries += numberValue(call.retry_count);
    if (artifact.artifactType === "failure") metric.failures += 1;
    const model = stringValue(call.model);
    if (model) metric.models.add(model);
    metrics.set(role, metric);
  }
  const preferredRoleOrder = ["contexto", "shino", "reader", "answer"];
  return [...metrics.values()]
    .map((metric) => ({
      ...metric,
      averageLatencyMs:
        metric.calls === 0 ? 0 : metric.totalLatencyMs / metric.calls,
      models: [...metric.models].sort(),
    }))
    .sort((left, right) => {
      const leftIndex = preferredRoleOrder.indexOf(left.role);
      const rightIndex = preferredRoleOrder.indexOf(right.role);
      if (leftIndex === -1 && rightIndex === -1) {
        return left.role.localeCompare(right.role);
      }
      if (leftIndex === -1) return 1;
      if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    });
}

export async function readObserverArtifacts(args: {
  casePath: string;
  modelCalls: JsonObject[];
  batchLimit?: number;
}): Promise<ObserverArtifacts> {
  const coverageRecords = await readCoverageRecords(
    args.casePath,
    args.batchLimit,
  );
  const [retrievalManifest, retrievalCandidates, readerPlan, finalContext] =
    await Promise.all([
      readOptionalJson(resolve(args.casePath, "retrieval/index-manifest.json")),
      readOptionalJson(resolve(args.casePath, "retrieval/candidates.json")),
      readOptionalJson(resolve(args.casePath, "reader-plan.json")),
      readOptionalJson(resolve(args.casePath, "final-context.json")),
    ]);
  const candidateValue = retrievalCandidates ?? {};
  const manifestValue = retrievalManifest ?? {};
  const compactFinalContext =
    finalContext !== null
    && Object.hasOwn(finalContext, "readerPlan")
    && Object.hasOwn(finalContext, "evidencePackage");
  const hasObserverArtifacts =
    coverageRecords.length > 0
    || retrievalCandidates !== null
    || readerPlan !== null
    || finalContext !== null
    || args.modelCalls.length > 0;

  return {
    schemaVersion: 1,
    legacy: !hasObserverArtifacts,
    coverage: {
      available: coverageRecords.length > 0,
      totals: coverageTotals(coverageRecords),
      records: coverageRecords,
    },
    retrieval: {
      available:
        retrievalManifest !== null || retrievalCandidates !== null,
      question: stringValue(candidateValue.question),
      questionDate: stringValue(candidateValue.questionDate),
      algorithm: stringValue(manifestValue.algorithm),
      parameters: asObject(manifestValue.parameters),
      indexed: retrievalCounts(manifestValue, "documentCounts"),
      candidates: retrievalCounts(candidateValue, "candidateArrays"),
      sessions: asArray(candidateValue.sessions),
      graphCells: asArray(candidateValue.graphCells),
      summaries: asArray(candidateValue.summaries),
      coverageFallbackSessions: asArray(
        candidateValue.coverageFallbackSessions,
      ),
      tailSessions: asArray(candidateValue.tailSessions),
    },
    readerPlan,
    finalContext: {
      available: finalContext !== null,
      kind:
        finalContext === null
          ? "unavailable"
          : compactFinalContext
            ? "compact_reader_context"
            : "legacy_full_context",
      value: finalContext,
    },
    roleMetrics: roleMetrics(args.modelCalls),
  };
}
