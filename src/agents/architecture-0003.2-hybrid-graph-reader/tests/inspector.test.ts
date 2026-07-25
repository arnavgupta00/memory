import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { app } from "../inspector/server/app.js";
import { applyContextoMutation, graphHash } from "../src/services/graphMutations.js";
import type { GraphMutationRecord, JsonObject, MasterContextGraph } from "../src/types.js";

async function json(path: string, value: JsonObject): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

describe("Hono Memory Observatory", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("indexes, replays, and exports allowlisted TypeScript artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "memorybench-observatory-"));
    const run = join(root, "run-0003");
    const caseRoot = join(run, "agent-artifacts", "cases", "q1");
    await mkdir(join(caseRoot, "graph-mutations"), { recursive: true });
    await json(join(run, "manifest.json"), { status: "completed", completed_count: 1, selected_count: 1, config: { agent: { entrypoint: "src/agents/architecture-0003.2-hybrid-graph-reader/dist/host.js" } } });
    const initial: MasterContextGraph = { schemaVersion: 1, revision: 0, context: {}, provenanceByPointer: {} };
    const mutation = { mode: "patch" as const, explanation: "fixture", operations: [{ op: "add" as const, path: "/context/jason", value: { home: "Pune" }, sources: [{ sessionId: "s1", turnIndex: 0, sessionDate: "2025/01/01", batchId: "b0001", excerpt: null }], reason: "fixture" }] };
    const applied = applyContextoMutation({ graph: initial, mutation, batchId: "b0001", sessions: [{ session_id: "s1", date: "2025/01/01", turns: [{}] }], allowReplacement: true });
    const record: GraphMutationRecord = { batchId: "b0001", sessionIds: ["s1"], mode: "patch", explanation: "fixture", accepted: true, diffs: applied.diffs, graphRevisionBefore: 0, graphRevisionAfter: 1, graphHash: graphHash(applied.graph), mutation };
    await json(join(caseRoot, "graph-mutations", "b0001.json"), record as unknown as JsonObject);
    await json(join(caseRoot, "final-graph.json"), applied.graph as unknown as JsonObject);
    await json(join(caseRoot, "answer.json"), { hypothesis: "Pune" });
    await writeFile(join(caseRoot, "events.jsonl"), `${JSON.stringify({ sequence: 1, event_type: "graph_mutation_applied" })}\n`);
    vi.stubEnv("MEMORYBENCH_RUNS_DIR", root);

    const runs = await app.request("/api/runs");
    expect(await runs.json()).toMatchObject([{ id: "run-0003", has_graph_artifacts: true }]);
    const cases = await app.request("/api/runs/run-0003/cases");
    expect(await cases.json()).toMatchObject([{ id: "q1", batch_count: 1, summary_count: 0 }]);
    const replay = await app.request("/api/runs/run-0003/cases/q1?batch=1");
    expect((await replay.json() as { graph: MasterContextGraph }).graph.context).toEqual({ jason: { home: "Pune" } });
    const svg = await app.request("/api/runs/run-0003/cases/q1/export.svg?batch=1");
    expect(svg.headers.get("content-type")).toContain("image/svg+xml");
    expect(await svg.text()).toContain("jason");
    const traversal = await app.request("/api/runs/run-0003/cases/%2E%2E%2Fmanifest.json");
    expect(traversal.status).toBe(404);
    const invalidCursor = await app.request("/api/runs/run-0003/cases/q1/events", { headers: { "Last-Event-ID": "not-an-integer" } });
    expect(invalidCursor.status).toBe(400);
  });
});
