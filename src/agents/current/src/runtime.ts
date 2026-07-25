import type { z } from "zod";

import type { ArchitectureOptions, RoleName } from "./config.js";
import type { ArtifactStore, EventRecorder } from "./services/artifacts.js";
import type { StructuredGeneration } from "./services/modelGateway.js";
import type { PromptLoader } from "./services/promptLoader.js";
import type { PromptEnvelope } from "./types.js";

export interface StructuredModelGateway {
  generateStructured<T>(args: {
    role: RoleName;
    callKey: string;
    prompt: PromptEnvelope;
    schemaName: string;
    schema: z.ZodType<T>;
    artifacts: ArtifactStore;
  }): Promise<StructuredGeneration<T>>;
}

export type WorkflowRuntime = {
  options: ArchitectureOptions;
  artifacts: ArtifactStore;
  events: EventRecorder;
  models: StructuredModelGateway;
  prompts: PromptLoader;
};
