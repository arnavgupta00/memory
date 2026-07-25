import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import { readObserverArtifacts } from "./observerArtifacts.js";
import { replayMutationRecords } from "../../src/services/graphMutations.js";
import { renderGraphSvg } from "../../src/services/svg.js";
import {
  GraphMutationRecordSchema,
  MasterContextGraphSchema,
  type GraphMutationRecord,
  type JsonObject,
  type JsonValue,
} from "../../src/types.js";

const app = new Hono();

function runsRoot(): string {
  return resolve(process.env.MEMORYBENCH_RUNS_DIR ?? resolve(process.cwd(), "runs"));
}

async function readJson(path: string): Promise<unknown> {
  const body = await readFile(path, "utf8").catch(() => null);
  return body === null ? null : JSON.parse(body);
}

async function readJsonl(path: string): Promise<JsonObject[]> {
  const body = await readFile(path, "utf8").catch(() => "");
  return body
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonObject);
}

async function manifests(root: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name === "manifest.json") output.push(path);
    }
  };
  await visit(root);
  return output;
}

async function runMap(): Promise<Map<string, string>> {
  const root = runsRoot();
  const result = new Map<string, string>();
  for (const manifest of await manifests(root)) {
    const directory = resolve(manifest, "..");
    const relative = directory.slice(root.length + 1);
    result.set(relative.split(sep).join("~"), directory);
  }
  return result;
}

async function runPath(runId: string): Promise<string> {
  const path = (await runMap()).get(runId);
  if (!path) throw new Error("run not found");
  return path;
}

async function casePath(runId: string, caseId: string): Promise<string> {
  const root = resolve(await runPath(runId), "agent-artifacts", "cases");
  const path = resolve(root, caseId);
  if (!path.startsWith(`${root}${sep}`) || !(await stat(path).then((item) => item.isDirectory()).catch(() => false))) {
    throw new Error("case artifacts not found");
  }
  return path;
}

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function scalarString(value: JsonValue | undefined, fallback: string): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : fallback;
}

async function mutationRecords(path: string): Promise<GraphMutationRecord[]> {
  const directory = resolve(path, "graph-mutations");
  const files = (await readdir(directory).catch(() => [])).filter((name) => /^b\d+\.json$/.test(name)).sort();
  return Promise.all(files.map(async (name) => GraphMutationRecordSchema.parse(await readJson(resolve(directory, name)))));
}

async function modelCallArtifacts(path: string): Promise<JsonObject[]> {
  const directory = resolve(path, "model-calls");
  const files = (await readdir(directory).catch(() => []))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const detailed = (
    await Promise.all(files.map(async (name) => asObject(await readJson(resolve(directory, name)))))
  ).filter((item) => Object.keys(item).length > 0);
  const failures = (await readJsonl(resolve(directory, "failures.jsonl"))).map((item) => ({
    artifactType: "failure",
    ...item,
  }));
  if (detailed.length || failures.length) return [...detailed, ...failures];
  return readJsonl(resolve(directory, "calls.jsonl"));
}

async function snapshot(runId: string, caseId: string, batch?: number) {
  const path = await casePath(runId, caseId);
  const allEvents = await readJsonl(resolve(path, "events.jsonl"));
  const records = await mutationRecords(path);
  const selectedRecords = batch === undefined ? records : records.slice(0, batch);
  const finalGraphRaw = await readJson(resolve(path, "final-graph.json"));
  let graph: JsonObject = asObject(finalGraphRaw);
  if (batch !== undefined && records.length) {
    graph = replayMutationRecords(selectedRecords) as unknown as JsonObject;
  }
  const allowedSequence = batch === undefined
    ? Number.POSITIVE_INFINITY
    : Number(
        allEvents
          .filter((event) => ["graph_mutation_applied", "graph_mutation_rejected", "batch_applied"].includes(scalarString(event.event_type, "")))
          .at(batch - 1)?.sequence ?? 0,
      );
  const events = allEvents.filter((event) => Number(event.sequence ?? 0) <= allowedSequence);
  const answer = asObject(await readJson(resolve(path, "answer.json")));
  const modelCalls = await modelCallArtifacts(path);
  return {
    run_id: runId,
    case_id: caseId,
    graph,
    events,
    sessions: await readJsonl(resolve(path, "sessions.jsonl")),
    summaries: await readJsonl(resolve(path, "summaries.jsonl")),
    mutations: selectedRecords,
    model_calls: modelCalls,
    observer: await readObserverArtifacts({
      casePath: path,
      modelCalls,
      ...(batch === undefined ? {} : { batchLimit: batch }),
    }),
    answer: Object.keys(answer).length ? answer : null,
    status: Object.keys(answer).length ? "completed" : "live",
  };
}

app.get("/api/runs", async (context) => {
  const root = runsRoot();
  const runs = await runMap();
  const summaries = await Promise.all(
    [...runs.entries()].map(async ([id, path]) => {
      const manifest = asObject(await readJson(resolve(path, "manifest.json")));
      const config = asObject(manifest.config);
      const agent = asObject(config.agent);
      const artifacts = resolve(path, "agent-artifacts", "cases");
      return {
        id,
        relative_path: path.slice(root.length + 1),
        status: scalarString(manifest.status, "legacy"),
        architecture: scalarString(agent.entrypoint, "legacy"),
        completed_count: Number(manifest.completed_count ?? 0),
        selected_count: Number(manifest.selected_count ?? 0),
        has_graph_artifacts: await stat(artifacts).then((item) => item.isDirectory()).catch(() => false),
        root: path.slice(root.length + 1),
      };
    }),
  );
  return context.json(summaries.sort((left, right) => right.id.localeCompare(left.id)));
});

app.get("/api/runs/:runId/cases", async (context) => {
  try {
    const runId = context.req.param("runId");
    const root = resolve(await runPath(runId), "agent-artifacts", "cases");
    const names = await readdir(root).catch(() => []);
    const cases = await Promise.all(
      names.map(async (id) => {
        const path = resolve(root, id);
        const events = await readJsonl(resolve(path, "events.jsonl"));
        const records = await mutationRecords(path);
        return {
          id,
          event_count: events.length,
          batch_count: Math.max(
            records.length,
            events.filter((event) => event.event_type === "batch_applied").length,
          ),
          summary_count: (await readJsonl(resolve(path, "summaries.jsonl"))).length,
          has_final_graph: await stat(resolve(path, "final-graph.json")).then(() => true).catch(() => false),
          has_answer: await stat(resolve(path, "answer.json")).then(() => true).catch(() => false),
        };
      }),
    );
    return context.json(cases);
  } catch (error) {
    return context.json({ error: error instanceof Error ? error.message : String(error) }, 404);
  }
});

app.get("/api/runs/:runId/cases/:caseId", async (context) => {
  try {
    const rawBatch = context.req.query("batch");
    const batch = rawBatch === undefined ? undefined : Number(rawBatch);
    return context.json(await snapshot(context.req.param("runId"), context.req.param("caseId"), batch));
  } catch (error) {
    return context.json({ error: error instanceof Error ? error.message : String(error) }, 404);
  }
});

app.get("/api/runs/:runId/cases/:caseId/export.svg", async (context) => {
  try {
    const rawBatch = context.req.query("batch");
    const data = await snapshot(
      context.req.param("runId"),
      context.req.param("caseId"),
      rawBatch === undefined ? undefined : Number(rawBatch),
    );
    const graph = MasterContextGraphSchema.safeParse(data.graph);
    if (graph.success) return context.body(renderGraphSvg(graph.data), 200, { "Content-Type": "image/svg+xml" });
    const path = await casePath(context.req.param("runId"), context.req.param("caseId"));
    const legacy = await readFile(resolve(path, "final.svg"), "utf8");
    return context.body(legacy, 200, { "Content-Type": "image/svg+xml" });
  } catch (error) {
    return context.json({ error: error instanceof Error ? error.message : String(error) }, 404);
  }
});

app.get("/api/runs/:runId/cases/:caseId/events", async (context) => {
  try {
    const path = resolve(await casePath(context.req.param("runId"), context.req.param("caseId")), "events.jsonl");
    const requested = Number(context.req.query("after") ?? context.req.header("Last-Event-ID") ?? 0);
    if (!Number.isSafeInteger(requested) || requested < 0) {
      return context.json({ error: "event cursor must be a non-negative integer" }, 400);
    }
    return streamSSE(context, async (stream) => {
      let last = requested;
      while (!stream.aborted) {
        const fresh = (await readJsonl(path)).filter((event) => Number(event.sequence ?? 0) > last);
        for (const event of fresh) {
          last = Number(event.sequence ?? last);
          await stream.writeSSE({ id: String(last), event: "memory", data: JSON.stringify(event) });
        }
        if (!fresh.length) await stream.writeSSE({ event: "keep-alive", data: "{}" });
        await stream.sleep(1000);
      }
    });
  } catch (error) {
    return context.json({ error: error instanceof Error ? error.message : String(error) }, 404);
  }
});

const webRoot = resolve(
  process.env.MEMORYBENCH_WEB_DIST ?? fileURLToPath(new URL("../web/dist/", import.meta.url)),
);
app.use("/assets/*", serveStatic({ root: webRoot }));
app.get("*", async (context) => {
  const index = await readFile(resolve(webRoot, "index.html"), "utf8").catch(() => "Memory Observatory UI is not built.");
  return context.html(index);
});

export { app };
