import { resolve, sep } from "node:path";
import { createInterface } from "node:readline";

import { z } from "zod";

import {
  ARCHITECTURE_ID,
  CASE_ARTIFACT_SCHEMA_VERSION,
} from "./architectureId.js";
import { HostInitializationSchema, type HostInitialization } from "./config.js";
import type { WorkflowRuntime } from "./runtime.js";
import { ArtifactStore, EventRecorder } from "./services/artifacts.js";
import { ModelGateway } from "./services/modelGateway.js";
import { PromptLoader } from "./services/promptLoader.js";
import { errorMessage } from "./services/redaction.js";
import { emptyState, type MemoryStateType } from "./state.js";
import {
  AnswerResultSchema,
  CaseMetadataSchema,
  ModelCallRecordSchema,
  TimestampedSessionSchema,
  type AnswerResult,
  type ModelCallRecord,
} from "./types.js";
import { createMemoryWorkflow } from "./workflow.js";

const PROTOCOL_VERSION = 1;
const RpcRequestSchema = z.strictObject({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1),
  method: z.enum(["initialize", "reset", "ingest", "answer", "shutdown"]),
  params: z.unknown(),
});

const ResetParamsSchema = z.strictObject({ case: CaseMetadataSchema });
const IngestParamsSchema = z.strictObject({
  caseId: z.string(),
  session: TimestampedSessionSchema,
});
const AnswerParamsSchema = z.strictObject({
  caseId: z.string(),
  question: z.string(),
  questionDate: z.string(),
});

type RpcResponse =
  | { protocolVersion: 1; id: string; ok: true; result: unknown }
  | {
      protocolVersion: 1;
      id: string;
      ok: false;
      error: { type: string; message: string };
    };

type CompiledWorkflow = ReturnType<typeof createMemoryWorkflow>;

class CaseRuntime {
  state: MemoryStateType;
  readonly artifacts: ArtifactStore;
  readonly workflow: CompiledWorkflow;
  #chain: Promise<void> = Promise.resolve();

  private constructor(
    state: MemoryStateType,
    artifacts: ArtifactStore,
    workflow: CompiledWorkflow,
  ) {
    this.state = state;
    this.artifacts = artifacts;
    this.workflow = workflow;
  }

  static async create(args: {
    initialization: HostInitialization;
    caseId: string;
    models: ModelGateway;
    prompts: PromptLoader;
  }): Promise<CaseRuntime> {
    if (!/^[A-Za-z0-9_.-]+$/.test(args.caseId)) {
      throw new Error(`unsafe case ID: ${args.caseId}`);
    }
    const casesRoot = resolve(args.initialization.runRoot, "agent-artifacts", "cases");
    const caseRoot = resolve(casesRoot, args.caseId);
    if (!caseRoot.startsWith(`${casesRoot}${sep}`)) {
      throw new Error("case artifact path escapes run root");
    }
    const artifacts = new ArtifactStore(caseRoot);
    await artifacts.initialize();
    const events = new EventRecorder(artifacts);
    const committed = await events.replay();
    const architectureMarker = await artifacts.readJson<{
      architectureId: string;
      artifactSchemaVersion: number;
    }>("architecture.json");
    if (architectureMarker === null) {
      if (committed.length > 0) {
        throw new Error(
          "refusing to resume case artifacts without an architecture marker",
        );
      }
      await artifacts.writeAtomic("architecture.json", {
        architectureId: ARCHITECTURE_ID,
        artifactSchemaVersion: CASE_ARTIFACT_SCHEMA_VERSION,
      });
    } else if (
      architectureMarker.architectureId !== ARCHITECTURE_ID
      || architectureMarker.artifactSchemaVersion !== CASE_ARTIFACT_SCHEMA_VERSION
    ) {
      throw new Error(
        `case artifacts belong to ${architectureMarker.architectureId} schema ${String(architectureMarker.artifactSchemaVersion)}`,
      );
    }
    const sessions = committed
      .filter((event) => event.event_type === "session_ingested")
      .map((event) => TimestampedSessionSchema.parse(event.payload.session));
    const state = emptyState(args.caseId);
    state.sessions = sessions;
    const runtime: WorkflowRuntime = {
      options: args.initialization.options,
      artifacts,
      events,
      models: args.models,
      prompts: args.prompts,
    };
    return new CaseRuntime(state, artifacts, createMemoryWorkflow(runtime));
  }

  async ingest(session: z.infer<typeof TimestampedSessionSchema>): Promise<void> {
    await this.#serialized(async () => {
      this.state = await this.workflow.invoke({
        ...this.state,
        action: "ingest",
        incomingSession: session,
      });
    });
  }

  async answer(
    question: string,
    questionDate: string,
  ): Promise<{ answer: AnswerResult; modelCalls: ModelCallRecord[] }> {
    return this.#serialized(async () => {
      this.state = await this.workflow.invoke({
        ...this.state,
        action: "answer",
        incomingSession: null,
        question,
        questionDate,
      });
      const answer = AnswerResultSchema.parse(this.state.answerResult);
      const modelCalls = (await this.artifacts.readJsonl("model-calls/calls")).map((item) =>
        ModelCallRecordSchema.parse(item),
      );
      return { answer, modelCalls };
    });
  }

  async #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.#chain.then(operation, operation);
    this.#chain = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }
}

class AgentHost {
  #initialization: HostInitialization | null = null;
  #models: ModelGateway | null = null;
  readonly #prompts = new PromptLoader();
  readonly #cases = new Map<string, CaseRuntime>();

  async dispatch(method: string, params: unknown): Promise<unknown> {
    if (method === "initialize") {
      if (this.#initialization) throw new Error("host is already initialized");
      this.#initialization = HostInitializationSchema.parse(params);
      const scheduleStore = new ArtifactStore(
        resolve(this.#initialization.runRoot, "agent-artifacts"),
      );
      const roles = {
        answer: this.#initialization.roles.answer,
        ...(this.#initialization.roles.select
          ? { select: this.#initialization.roles.select }
          : {}),
      };
      this.#models = await ModelGateway.create({
        roles,
        captureModelIo: this.#initialization.captureModelIo,
        providerModelLimits: this.#initialization.providerModelLimits,
        scheduleStore,
      });
      return { architectureId: ARCHITECTURE_ID, protocolVersion: PROTOCOL_VERSION };
    }
    if (method === "shutdown") return { shutdown: true };
    const initialization = this.#initialization;
    const models = this.#models;
    if (!initialization || !models) throw new Error("host must be initialized first");
    if (method === "reset") {
      const parsed = ResetParamsSchema.parse(params);
      const runtime = await CaseRuntime.create({
        initialization,
        caseId: parsed.case.question_id,
        models,
        prompts: this.#prompts,
      });
      this.#cases.set(parsed.case.question_id, runtime);
      return {
        caseId: parsed.case.question_id,
        processedSessions: runtime.state.sessions,
      };
    }
    if (method === "ingest") {
      const parsed = IngestParamsSchema.parse(params);
      const runtime = this.#case(parsed.caseId);
      await runtime.ingest(parsed.session);
      return { caseId: parsed.caseId, sessionId: parsed.session.session_id };
    }
    if (method === "answer") {
      const parsed = AnswerParamsSchema.parse(params);
      return this.#case(parsed.caseId).answer(parsed.question, parsed.questionDate);
    }
    throw new Error(`unknown RPC method: ${method}`);
  }

  #case(caseId: string): CaseRuntime {
    const runtime = this.#cases.get(caseId);
    if (!runtime) throw new Error(`case has not been reset: ${caseId}`);
    return runtime;
  }
}

function send(response: RpcResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

const host = new AgentHost();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  void (async () => {
    let id = "unknown";
    try {
      const request = RpcRequestSchema.parse(JSON.parse(line));
      id = request.id;
      const result = await host.dispatch(request.method, request.params);
      send({ protocolVersion: PROTOCOL_VERSION, id, ok: true, result });
      if (request.method === "shutdown") setImmediate(() => process.exit(0));
    } catch (error) {
      send({
        protocolVersion: PROTOCOL_VERSION,
        id,
        ok: false,
        error: {
          type: error instanceof Error ? error.name : "Error",
          message: errorMessage(error),
        },
      });
    }
  })();
});

process.on("uncaughtException", (error) => {
  process.stderr.write(`[memorybench-agent-host] ${errorMessage(error)}\n`);
  process.exitCode = 1;
});

process.on("unhandledRejection", (error) => {
  process.stderr.write(`[memorybench-agent-host] ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
