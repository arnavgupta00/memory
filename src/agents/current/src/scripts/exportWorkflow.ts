import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { ArtifactStore, EventRecorder } from "../services/artifacts.js";
import { ModelGateway } from "../services/modelGateway.js";
import { PromptLoader } from "../services/promptLoader.js";
import { createMemoryWorkflow } from "../workflow.js";

const temporaryArtifacts = new ArtifactStore(fileURLToPath(new URL("../../.diagram-artifacts/", import.meta.url)));
await temporaryArtifacts.initialize();
const roles = {
  contexto: { kind: "generation" as const, provider: "openai" as const, model: "diagram", temperature: 0, max_output_tokens: 1, timeout_seconds: 1, concurrency: 1, max_retries: 0, min_request_interval_seconds: 0 },
  shino: { kind: "generation" as const, provider: "openai" as const, model: "diagram", temperature: 0, max_output_tokens: 1, timeout_seconds: 1, concurrency: 1, max_retries: 0, min_request_interval_seconds: 0 },
  reader: { kind: "generation" as const, provider: "openai" as const, model: "diagram", temperature: 0, max_output_tokens: 1, timeout_seconds: 1, concurrency: 1, max_retries: 0, min_request_interval_seconds: 0 },
  answer: { kind: "generation" as const, provider: "openai" as const, model: "diagram", temperature: 0, max_output_tokens: 1, timeout_seconds: 1, concurrency: 1, max_retries: 0, min_request_interval_seconds: 0 },
};
const workflow = createMemoryWorkflow({
  options: { graph_batch_size: 3, summary_batch_size: 9, latest_raw_sessions: 9, allow_graph_replacement: true },
  artifacts: temporaryArtifacts,
  events: new EventRecorder(temporaryArtifacts),
  models: new ModelGateway(roles, false),
  prompts: new PromptLoader(),
});
const graph = await workflow.getGraphAsync();
const output = fileURLToPath(new URL("../../architecture/generated-workflow.mmd", import.meta.url));
await mkdir(fileURLToPath(new URL("../../architecture/", import.meta.url)), { recursive: true });
await writeFile(output, graph.drawMermaid(), "utf8");
