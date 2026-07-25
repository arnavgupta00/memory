import { resolve } from "node:path";

import { z } from "zod";

import type { WorkflowRuntime } from "../runtime.js";
import { ArtifactStore, EventRecorder } from "../services/artifacts.js";
import { replayMutationRecords } from "../services/graphMutations.js";
import { ModelGateway } from "../services/modelGateway.js";
import { PromptLoader } from "../services/promptLoader.js";
import { emptyState } from "../state.js";
import {
  GraphMutationRecordSchema,
  ProviderRoleConfigSchema,
  SessionSummaryRecordSchema,
  TimestampedSessionSchema,
  type JsonObject,
} from "../types.js";
import { createMemoryWorkflow } from "../workflow.js";

const ArgumentsSchema = z.strictObject({
  sourceCase: z.string().min(1),
  outputCase: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.enum(["minimal", "low", "medium", "high"]),
});

const PriorContextSchema = z.looseObject({
  question: z.string().min(1),
  questionDate: z.string().min(1),
});

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const args = ArgumentsSchema.parse({
    sourceCase: argument("--source-case"),
    outputCase: argument("--output-case"),
    model: argument("--model") ?? "gpt-5-nano-2025-08-07",
    reasoningEffort: argument("--reasoning-effort") ?? "minimal",
  });
  const source = new ArtifactStore(resolve(args.sourceCase));
  const output = new ArtifactStore(resolve(args.outputCase));
  await output.initialize();
  const committed = await new EventRecorder(source).replay();
  const sessions = committed
    .filter((event) => event.event_type === "session_ingested")
    .map((event) => TimestampedSessionSchema.parse(event.payload.session));
  const mutationRecords = committed
    .filter((event) => ["graph_mutation_applied", "graph_mutation_rejected"].includes(event.event_type))
    .map((event) => GraphMutationRecordSchema.parse(event.payload));
  const summaries = committed
    .filter((event) => event.event_type === "summary_window_created")
    .map((event) => SessionSummaryRecordSchema.parse(event.payload));
  const previous = PriorContextSchema.parse(await source.readJson("final-context.json"));
  const role = ProviderRoleConfigSchema.parse({
    kind: "generation",
    provider: "openai",
    model: args.model,
    temperature: 1,
    reasoning_effort: args.reasoningEffort,
    max_output_tokens: 32000,
    timeout_seconds: 300,
    concurrency: 1,
    max_retries: 10,
    min_request_interval_seconds: 0,
    input_price_per_million: 0.05,
    output_price_per_million: 0.40,
  });
  const runtime: WorkflowRuntime = {
    options: {
      graph_batch_size: 3,
      summary_batch_size: 9,
      latest_raw_sessions: 9,
      allow_graph_replacement: true,
    },
    artifacts: output,
    events: new EventRecorder(output),
    models: new ModelGateway({ contexto: role, shino: role, reader: role, answer: role }, true),
    prompts: new PromptLoader(),
  };
  const state = emptyState("answer-lab");
  state.sessions = sessions;
  state.graph = replayMutationRecords(mutationRecords);
  state.mutationRecords = mutationRecords;
  state.summaries = summaries;
  state.graphTrackedCount = mutationRecords.length * runtime.options.graph_batch_size;
  state.summaryTrackedCount = summaries.length * runtime.options.summary_batch_size;
  const answered = await createMemoryWorkflow(runtime).invoke({
    ...state,
    action: "answer",
    incomingSession: null,
    question: previous.question,
    questionDate: previous.questionDate,
  });
  const call = (await output.readJsonl("model-calls/calls"))[0];
  if (!answered.answerResult || !call) throw new Error("answer lab did not produce a result and call record");
  const inputTokens = typeof call.usage === "object" && call.usage !== null && !Array.isArray(call.usage)
    && typeof call.usage.input_tokens === "number" ? call.usage.input_tokens : 0;
  const outputTokens = typeof call.usage === "object" && call.usage !== null && !Array.isArray(call.usage)
    && typeof call.usage.output_tokens === "number" ? call.usage.output_tokens : 0;
  const report: JsonObject = {
    answer: answered.answerResult as unknown as JsonObject,
    selected_session_count:
      answered.finalContext?.evidencePackage.payload.sessions.length ?? 0,
    selected_graph_evidence_count:
      answered.finalContext?.evidencePackage.payload.graphEvidence.length ?? 0,
    evidence_prompt_token_estimate:
      answered.finalContext?.evidencePackage.promptTokenEstimate ?? 0,
    omitted_evidence_item_count:
      answered.finalContext?.evidencePackage.omittedItems.length ?? 0,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    estimated_cost_usd: inputTokens * 0.05 / 1_000_000 + outputTokens * 0.40 / 1_000_000,
  };
  await output.writeAtomic("answer-lab-summary.json", report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
