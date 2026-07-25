import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { ArtifactStore, EventRecorder } from "../services/artifacts.js";
import { graphHash, replayMutationRecords } from "../services/graphMutations.js";
import { GraphMutationRecordSchema, MasterContextGraphSchema } from "../types.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const runRoot = argument("--run");
  if (!runRoot) throw new Error("--run is required");
  const casesRoot = resolve(runRoot, "agent-artifacts", "cases");
  const caseIds = (await readdir(casesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const verified = [];
  for (const caseId of caseIds) {
    const store = new ArtifactStore(resolve(casesRoot, caseId));
    const events = await new EventRecorder(store).replay();
    const records = events
      .filter((event) => ["graph_mutation_applied", "graph_mutation_rejected"].includes(event.event_type))
      .map((event) => GraphMutationRecordSchema.parse(event.payload));
    const replayed = replayMutationRecords(records);
    const snapshot = MasterContextGraphSchema.parse(await store.readJson("final-graph.json"));
    const replayHash = graphHash(replayed);
    const snapshotHash = graphHash(snapshot);
    if (replayHash !== snapshotHash) throw new Error(`final replay hash mismatch: ${caseId}`);
    verified.push({ case_id: caseId, mutation_count: records.length, graph_hash: replayHash });
  }
  process.stdout.write(`${JSON.stringify({ run: resolve(runRoot), verified }, null, 2)}\n`);
}

await main();
