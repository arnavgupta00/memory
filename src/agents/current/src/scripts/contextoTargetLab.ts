import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { ArtifactStore } from "../services/artifacts.js";
import { classifyContextoCoverage } from "../services/contextoCoverage.js";
import { decodeContextoMutation } from "../services/contextoWire.js";
import {
  applyContextoMutation,
  graphHash,
  semanticMemoryCatalog,
} from "../services/graphMutations.js";
import { ModelGateway } from "../services/modelGateway.js";
import { personalSignalIndex } from "../services/personalSignals.js";
import { PromptLoader } from "../services/promptLoader.js";
import {
  ContextoSemanticWireResponseSchema,
  GraphMutationRecordSchema,
  ProviderRoleConfigSchema,
  TimestampedSessionSchema,
  type GraphMutationRecord,
  type JsonObject,
  type MasterContextGraph,
  type TimestampedSession,
} from "../types.js";

const ArgumentsSchema = z.strictObject({
  sourceRun: z.string().min(1),
  outputRun: z.string().min(1),
  targets: z.record(z.string().min(1), z.array(z.number().int().positive()).min(1)),
  batchSize: z.number().int().positive().max(9),
  model: z.string().min(1),
  reasoningEffort: z.enum(["minimal", "low", "medium", "high"]),
});

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function parseTargets(value: string): Record<string, number[]> {
  return Object.fromEntries(value.split(";").map((caseSpec) => {
    const [caseId, batches] = caseSpec.split(":");
    if (!caseId || !batches) throw new Error(`invalid target specification: ${caseSpec}`);
    return [caseId, batches.split(",").map(Number)];
  }));
}

async function sessionsFor(sourceRun: string, caseId: string): Promise<TimestampedSession[]> {
  const body = await readFile(
    resolve(sourceRun, "agent-artifacts", "cases", caseId, "sessions.jsonl"),
    "utf8",
  );
  return body
    .split("\n")
    .filter(Boolean)
    .map((line) => TimestampedSessionSchema.parse(JSON.parse(line)));
}

async function sourceRecord(
  sourceRun: string,
  caseId: string,
  batchNumber: number,
): Promise<GraphMutationRecord> {
  const batchId = `b${String(batchNumber).padStart(4, "0")}`;
  const body = await readFile(
    resolve(sourceRun, "agent-artifacts", "cases", caseId, "graph-mutations", `${batchId}.json`),
    "utf8",
  );
  return GraphMutationRecordSchema.parse(JSON.parse(body));
}

function applySourceRecord(args: {
  graph: MasterContextGraph;
  record: GraphMutationRecord;
  sessions: TimestampedSession[];
}): MasterContextGraph {
  if (!args.record.accepted || !args.record.mutation) return args.graph;
  const mutation = args.record.mutation.mode === "semantic_updates"
    ? {
        ...args.record.mutation,
        updates: args.record.mutation.updates.filter(
          (_, index) => !(args.record.rejectedUpdates ?? []).some((item) => item.index === index),
        ),
      }
    : args.record.mutation;
  return applyContextoMutation({
    graph: args.graph,
    mutation,
    batchId: args.record.batchId,
    sessions: args.sessions,
    allowReplacement: true,
  }).graph;
}

async function main(): Promise<void> {
  const args = ArgumentsSchema.parse({
    sourceRun: argument("--source-run"),
    outputRun: argument("--output-run"),
    targets: parseTargets(argument("--targets") ?? ""),
    batchSize: Number(argument("--batch-size") ?? "3"),
    model: argument("--model") ?? "gpt-5-nano-2025-08-07",
    reasoningEffort: argument("--reasoning-effort") ?? "low",
  });
  const role = ProviderRoleConfigSchema.parse({
    kind: "generation",
    provider: "openai",
    model: args.model,
    temperature: 1,
    reasoning_effort: args.reasoningEffort,
    max_output_tokens: 32000,
    timeout_seconds: 300,
    concurrency: 2,
    max_retries: 6,
    min_request_interval_seconds: 0,
    input_price_per_million: 0.05,
    output_price_per_million: 0.40,
  });
  const outputRoot = new ArtifactStore(resolve(args.outputRun));
  await outputRoot.initialize();
  const gateway = await ModelGateway.create({
    roles: { contexto: role, shino: role, reader: role, answer: role },
    captureModelIo: true,
    providerModelLimits: [{
      provider: "openai",
      model: args.model,
      max_concurrency: 2,
      token_budget: 160000,
      window_seconds: 60,
    }],
    scheduleStore: outputRoot,
  });
  const prompts = new PromptLoader();
  const results: JsonObject[] = [];
  for (const [caseId, targetNumbers] of Object.entries(args.targets).sort()) {
    const sessions = await sessionsFor(args.sourceRun, caseId);
    const targetSet = new Set(targetNumbers);
    const maximum = Math.max(...targetNumbers);
    let graph: MasterContextGraph = {
      schemaVersion: 1,
      revision: 0,
      context: {},
      provenanceByPointer: {},
    };
    const artifacts = new ArtifactStore(resolve(args.outputRun, "cases", caseId));
    await artifacts.initialize();
    for (let batchNumber = 1; batchNumber <= maximum; batchNumber += 1) {
      const batchId = `b${String(batchNumber).padStart(4, "0")}`;
      const batchSessions = sessions.slice(
        (batchNumber - 1) * args.batchSize,
        batchNumber * args.batchSize,
      );
      if (batchSessions.length !== args.batchSize) {
        throw new Error(`${caseId}/${batchId} does not contain a complete batch`);
      }
      if (!targetSet.has(batchNumber)) {
        graph = applySourceRecord({
          graph,
          record: await sourceRecord(args.sourceRun, caseId, batchNumber),
          sessions: batchSessions,
        });
        continue;
      }
      const beforeGraph = graph;
      const labelledSessions = batchSessions.map((session, sessionIndex) => ({
        sessionSlot: `session_${String(sessionIndex + 1)}`,
        date: session.date,
        turns: session.turns.map((turn, turnIndex) => ({
          turnSlot: `turn_${String(turnIndex + 1)}`,
          role: turn.role,
          content: turn.content,
        })),
      }));
      const prompt = await prompts.render("contexto", {
        batch_id: batchId,
        memory_catalog: JSON.stringify(semanticMemoryCatalog(graph), null, 2),
        personal_signals: JSON.stringify(personalSignalIndex(batchSessions), null, 2),
        sessions: JSON.stringify(labelledSessions, null, 2),
      });
      const response = await gateway.generateStructured({
        role: "contexto",
        callKey: `contexto:batch:${String(batchNumber).padStart(4, "0")}`,
        prompt,
        schemaName: "contexto_semantic_wire_response_v6",
        schema: ContextoSemanticWireResponseSchema,
        artifacts,
      });
      const mutation = decodeContextoMutation(response.value.mutation, {
        batchId,
        sessions: batchSessions,
        graph,
      });
      const applied = applyContextoMutation({
        graph,
        mutation,
        batchId,
        sessions: batchSessions,
        allowReplacement: false,
      });
      graph = applied.graph;
      const coverage = classifyContextoCoverage({
        batchId,
        sessions: batchSessions,
        beforeGraph,
        afterGraph: graph,
        mutation,
        rejectedUpdateIndices: applied.rejectedUpdates.map((item) => item.index),
      });
      const result: JsonObject = {
        case_id: caseId,
        batch_id: batchId,
        session_ids: batchSessions.map((session) => session.session_id),
        graph_revision_before: beforeGraph.revision,
        graph_revision_after: graph.revision,
        graph_hash: graphHash(graph),
        accepted_updates: applied.acceptedUpdateCount,
        rejected_updates: applied.rejectedUpdates as unknown as JsonObject[],
        audit_warnings: applied.auditWarnings,
        coverage: coverage as unknown as JsonObject,
        mutation: mutation as unknown as JsonObject,
        signal_resolutions: response.value.mutation.requiredSignalResolutions as unknown as JsonObject[],
        usage: response.call.usage as unknown as JsonObject,
        retry_count: response.call.retry_count,
      };
      await artifacts.writeAtomic(`targets/${batchId}.json`, result);
      results.push(result);
    }
    await artifacts.writeAtomic("final-graph.json", graph as unknown as JsonObject);
  }
  const calls = results.length;
  const report: JsonObject = {
    schema_version: 1,
    kind: "contexto_target_batch_lab",
    source_run: args.sourceRun,
    target_call_count: calls,
    expected_target_call_count: Object.values(args.targets).flat().length,
    results,
  };
  await outputRoot.writeAtomic("target-lab-report.json", report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
