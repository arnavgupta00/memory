import { describe, expect, it } from "vitest";

import { ArchitectureOptionsSchema } from "../src/config.js";
import { createMemoryWorkflow } from "../src/workflow.js";
import type { WorkflowRuntime } from "../src/runtime.js";

function runtime(selectEnabled: boolean): WorkflowRuntime {
  return {
    options: ArchitectureOptionsSchema.parse({
      select_enabled: selectEnabled,
      answer_prompt: selectEnabled ? "answer-v5-package" : "answer-v2-evidence",
    }),
    artifacts: {} as WorkflowRuntime["artifacts"],
    events: {} as WorkflowRuntime["events"],
    models: {} as WorkflowRuntime["models"],
    prompts: {} as WorkflowRuntime["prompts"],
  };
}

describe("workflow select bypass", () => {
  it("compiles with select_enabled false (0004.2 A/B path)", () => {
    const graph = createMemoryWorkflow(runtime(false));
    expect(graph).toBeTruthy();
    expect(runtime(false).options.select_enabled).toBe(false);
  });

  it("compiles with select_enabled true (0005 path)", () => {
    const graph = createMemoryWorkflow(runtime(true));
    expect(graph).toBeTruthy();
    expect(runtime(true).options.select_enabled).toBe(true);
  });
});
