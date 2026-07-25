import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { ArtifactStore } from "../services/artifacts.js";
import { decodeContextoMutation } from "../services/contextoWire.js";
import { applyContextoMutation, semanticMemoryCatalog } from "../services/graphMutations.js";
import {
  ContextoSemanticWireResponseSchema,
  TimestampedSessionSchema,
  type JsonObject,
  type MasterContextGraph,
} from "../types.js";

const ArgumentsSchema = z.strictObject({
  sourceLab: z.string().min(1),
  sessionRun: z.string().min(1),
  outputRun: z.string().min(1),
  batchSize: z.number().int().positive().max(9),
});

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function sessionsFor(run: string, caseId: string) {
  const body = await readFile(resolve(run, "agent-artifacts", "cases", caseId, "sessions.jsonl"), "utf8");
  return body.split("\n").filter(Boolean).map((line) => TimestampedSessionSchema.parse(JSON.parse(line)));
}

async function main(): Promise<void> {
  const args = ArgumentsSchema.parse({
    sourceLab: argument("--source-lab"),
    sessionRun: argument("--session-run"),
    outputRun: argument("--output-run"),
    batchSize: Number(argument("--batch-size") ?? "3"),
  });
  const casesRoot = resolve(args.sourceLab, "agent-artifacts", "cases");
  const caseIds = (await readdir(casesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const cases = [];
  for (const caseId of caseIds) {
    const sessions = await sessionsFor(args.sessionRun, caseId);
    const callsRoot = resolve(casesRoot, caseId, "model-calls");
    const calls = (await readdir(callsRoot))
      .filter((name) => /^contexto-batch-\d+\.json$/.test(name))
      .sort();
    let graph: MasterContextGraph = { schemaVersion: 1, revision: 0, context: {}, provenanceByPointer: {} };
    let acceptedBatches = 0;
    let acceptedUpdates = 0;
    const rejectedUpdates: string[] = [];
    const auditWarnings: string[] = [];
    for (const [index, name] of calls.entries()) {
      const artifact = JSON.parse(await readFile(resolve(callsRoot, name), "utf8")) as unknown;
      const parsedArtifact = z.looseObject({ validatedResponse: ContextoSemanticWireResponseSchema }).parse(artifact);
      const batchId = `b${String(index + 1).padStart(4, "0")}`;
      const batchSessions = sessions.slice(index * args.batchSize, (index + 1) * args.batchSize);
      const mutation = decodeContextoMutation(parsedArtifact.validatedResponse.mutation, {
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
      acceptedUpdates += applied.acceptedUpdateCount;
      rejectedUpdates.push(...applied.rejectedUpdates.map((item) => `${batchId}:${String(item.index)} ${item.reason}`));
      auditWarnings.push(...applied.auditWarnings.map((warning) => `${batchId} ${warning}`));
      if (applied.acceptedUpdateCount > 0 || (mutation.mode === "semantic_updates" && mutation.updates.length === 0)) {
        acceptedBatches += 1;
      }
    }
    const output = new ArtifactStore(resolve(args.outputRun, "cases", caseId));
    await output.initialize();
    await output.writeAtomic("final-graph.json", graph as unknown as JsonObject);
    cases.push({
      case_id: caseId,
      source_call_count: calls.length,
      accepted_batches: acceptedBatches,
      accepted_updates: acceptedUpdates,
      rejected_updates: rejectedUpdates,
      audit_warnings: auditWarnings,
      semantic_memory_cells: semanticMemoryCatalog(graph).length,
      graph_revision: graph.revision,
    });
  }
  const report: JsonObject = {
    schema_version: 1,
    kind: "contexto_local_replay",
    source_lab: args.sourceLab,
    cases: cases as unknown as JsonObject[],
    totals: {
      source_calls: cases.reduce((sum, item) => sum + item.source_call_count, 0),
      accepted_batches: cases.reduce((sum, item) => sum + item.accepted_batches, 0),
      accepted_updates: cases.reduce((sum, item) => sum + item.accepted_updates, 0),
      rejected_updates: cases.reduce((sum, item) => sum + item.rejected_updates.length, 0),
      audit_warnings: cases.reduce((sum, item) => sum + item.audit_warnings.length, 0),
      semantic_memory_cells: cases.reduce((sum, item) => sum + item.semantic_memory_cells, 0),
    },
  };
  const root = new ArtifactStore(resolve(args.outputRun));
  await root.initialize();
  await root.writeAtomic("replay-summary.json", report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Contexto replay failed: ${message}\n`);
  process.exitCode = 1;
});
