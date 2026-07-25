import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { type WorkflowRuntime } from "../runtime.js";
import { ArtifactStore, EventRecorder } from "../services/artifacts.js";
import { semanticMemoryCatalog } from "../services/graphMutations.js";
import { ModelGateway } from "../services/modelGateway.js";
import { PromptLoader } from "../services/promptLoader.js";
import { errorMessage } from "../services/redaction.js";
import { emptyState } from "../state.js";
import {
  ModelCallRecordSchema,
  ProviderRoleConfigSchema,
  TimestampedSessionSchema,
  type JsonObject,
  type ModelCallRecord,
} from "../types.js";
import { createMemoryWorkflow } from "../workflow.js";

const DEFAULT_CASES = [
  "e47becba",
  "db467c8c",
  "a11281a2",
  "c8090214",
  "71315a70",
  "gpt4_1e4a8aeb",
];

const ArgumentsSchema = z.strictObject({
  sourceRun: z.string().min(1),
  outputRun: z.string().min(1),
  cases: z.array(z.string().min(1)).min(1),
  batchSize: z.number().int().positive().max(9),
  startBatch: z.number().int().positive(),
  maxBatches: z.number().int().positive().nullable(),
  model: z.string().min(1),
  reasoningEffort: z.enum(["minimal", "low", "medium", "high"]),
});

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function argumentsFromProcess() {
  return ArgumentsSchema.parse({
    sourceRun: argument("--source-run") ?? "runs/arch0003-openai-b3-c9-random6-seed2002",
    outputRun: argument("--output-run") ?? "runs/local-archive/contexto-semantic-v2-lab",
    cases: (argument("--cases") ?? DEFAULT_CASES.join(",")).split(",").filter(Boolean),
    batchSize: Number(argument("--batch-size") ?? "3"),
    startBatch: Number(argument("--start-batch") ?? "1"),
    maxBatches: argument("--max-batches") === undefined ? null : Number(argument("--max-batches")),
    model: argument("--model") ?? "gpt-5-nano-2025-08-07",
    reasoningEffort: argument("--reasoning-effort") ?? "low",
  });
}

async function sessionsFor(sourceRun: string, caseId: string) {
  const path = resolve(sourceRun, "agent-artifacts", "cases", caseId, "sessions.jsonl");
  const body = await readFile(path, "utf8");
  return body.split("\n").filter(Boolean).map((line) => TimestampedSessionSchema.parse(JSON.parse(line)));
}

function usage(calls: ModelCallRecord[]) {
  return calls.reduce(
    (total, call) => ({
      input_tokens: total.input_tokens + (call.usage.input_tokens ?? 0),
      output_tokens: total.output_tokens + (call.usage.output_tokens ?? 0),
      total_tokens: total.total_tokens + (call.usage.total_tokens ?? 0),
    }),
    { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  );
}

async function main(): Promise<void> {
  const args = argumentsFromProcess();
  const role = ProviderRoleConfigSchema.parse({
    kind: "generation",
    provider: "openai",
    model: args.model,
    temperature: 1,
    reasoning_effort: args.reasoningEffort,
    max_output_tokens: 32000,
    timeout_seconds: 300,
    concurrency: 2,
    max_retries: 10,
    min_request_interval_seconds: 2,
    input_price_per_million: 0.05,
    output_price_per_million: 0.40,
  });
  const models = new ModelGateway({ contexto: role, shino: role, reader: role, answer: role }, true);
  const summaryBatchSize = 126;
  if (summaryBatchSize % args.batchSize !== 0) throw new Error("lab summary cadence must be divisible by B");

  const summaries = await Promise.all(args.cases.map(async (caseId) => {
    const artifacts = new ArtifactStore(resolve(args.outputRun, "agent-artifacts", "cases", caseId));
    await artifacts.initialize();
    try {
      const allSessions = await sessionsFor(args.sourceRun, caseId);
      const start = (args.startBatch - 1) * args.batchSize;
      const available = allSessions.slice(start);
      const sessions = args.maxBatches === null
        ? available
        : available.slice(0, args.maxBatches * args.batchSize);
      const runtime: WorkflowRuntime = {
        options: {
          graph_batch_size: args.batchSize,
          summary_batch_size: summaryBatchSize,
          latest_raw_sessions: summaryBatchSize - 1,
          allow_graph_replacement: false,
        },
        artifacts,
        events: new EventRecorder(artifacts),
        models,
        prompts: new PromptLoader(),
      };
      const workflow = createMemoryWorkflow(runtime);
      let state = emptyState(caseId);
      for (const session of sessions) {
        state = await workflow.invoke({ ...state, action: "ingest", incomingSession: session });
      }
      const calls = (await artifacts.readJsonl("model-calls/calls")).map((item) => ModelCallRecordSchema.parse(item));
      const acceptedUpdates = state.mutationRecords.reduce((sum, record) => sum + (record.acceptedUpdateCount ?? 0), 0);
      const rejectedUpdates = state.mutationRecords.reduce((sum, record) => sum + (record.rejectedUpdates?.length ?? 0), 0);
      const auditWarnings = state.mutationRecords.reduce((sum, record) => sum + (record.auditWarnings?.length ?? 0), 0);
      return {
        case_id: caseId,
        failure: null,
        session_count: sessions.length,
        expected_contexto_calls: Math.floor(sessions.length / args.batchSize),
        actual_contexto_calls: calls.filter((call) => call.role === "contexto").length,
        fully_or_partially_applied_batches: state.mutationRecords.filter((record) => record.accepted).length,
        rejected_batches: state.mutationRecords.filter((record) => !record.accepted).length,
        accepted_updates: acceptedUpdates,
        rejected_updates: rejectedUpdates,
        audit_warnings: auditWarnings,
        semantic_memory_cells: semanticMemoryCatalog(state.graph).length,
        graph_revision: state.graph.revision,
        usage: usage(calls),
      };
    } catch (error) {
      const failure = errorMessage(error);
      await artifacts.writeAtomic("failure.json", { case_id: caseId, failure });
      const calls = (await artifacts.readJsonl("model-calls/calls")).map((item) => ModelCallRecordSchema.parse(item));
      return {
        case_id: caseId,
        failure,
        session_count: 0,
        expected_contexto_calls: 0,
        actual_contexto_calls: calls.filter((call) => call.role === "contexto").length,
        fully_or_partially_applied_batches: 0,
        rejected_batches: 0,
        accepted_updates: 0,
        rejected_updates: 0,
        audit_warnings: 0,
        semantic_memory_cells: 0,
        graph_revision: 0,
        usage: usage(calls),
      };
    }
  }));

  const totals = summaries.reduce(
    (sum, item) => ({
      expected_contexto_calls: sum.expected_contexto_calls + item.expected_contexto_calls,
      actual_contexto_calls: sum.actual_contexto_calls + item.actual_contexto_calls,
      applied_batches: sum.applied_batches + item.fully_or_partially_applied_batches,
      rejected_batches: sum.rejected_batches + item.rejected_batches,
      accepted_updates: sum.accepted_updates + item.accepted_updates,
      rejected_updates: sum.rejected_updates + item.rejected_updates,
      audit_warnings: sum.audit_warnings + item.audit_warnings,
      semantic_memory_cells: sum.semantic_memory_cells + item.semantic_memory_cells,
      input_tokens: sum.input_tokens + item.usage.input_tokens,
      output_tokens: sum.output_tokens + item.usage.output_tokens,
      total_tokens: sum.total_tokens + item.usage.total_tokens,
      failed_cases: sum.failed_cases + (item.failure === null ? 0 : 1),
    }),
    {
      expected_contexto_calls: 0,
      actual_contexto_calls: 0,
      applied_batches: 0,
      rejected_batches: 0,
      accepted_updates: 0,
      rejected_updates: 0,
      audit_warnings: 0,
      semantic_memory_cells: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      failed_cases: 0,
    },
  );
  const report: JsonObject = {
    schema_version: 1,
    kind: "contexto_semantic_memory_lab",
    source_run: args.sourceRun,
    model: args.model,
    reasoning_effort: args.reasoningEffort,
    graph_batch_size: args.batchSize,
    start_batch: args.startBatch,
    max_batches_per_case: args.maxBatches,
    cases: summaries as unknown as JsonObject[],
    totals,
    estimated_cost_usd: totals.input_tokens * 0.05 / 1_000_000 + totals.output_tokens * 0.40 / 1_000_000,
  };
  const root = new ArtifactStore(resolve(args.outputRun));
  await root.initialize();
  await root.writeAtomic("lab-summary.json", report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
