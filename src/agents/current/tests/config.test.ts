import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";
import { describe, expect, test } from "vitest";

import { ArchitectureOptionsSchema } from "../src/config.js";

describe("architecture cadence configuration", () => {
  test("accepts B3/C9 and B9/C9", () => {
    expect(ArchitectureOptionsSchema.parse({ graph_batch_size: 3, summary_batch_size: 9, latest_raw_sessions: 9 }).graph_batch_size).toBe(3);
    expect(ArchitectureOptionsSchema.parse({ graph_batch_size: 9, summary_batch_size: 9, latest_raw_sessions: 9 }).graph_batch_size).toBe(9);
  });

  test.each([
    { graph_batch_size: 10, summary_batch_size: 9, latest_raw_sessions: 9 },
    { graph_batch_size: 4, summary_batch_size: 9, latest_raw_sessions: 9 },
    { graph_batch_size: 3, summary_batch_size: 9, latest_raw_sessions: 7 },
  ])("rejects invalid B/C/tail invariant: $graph_batch_size/$summary_batch_size", (options) => {
    expect(() => ArchitectureOptionsSchema.parse(options)).toThrow();
  });

  test("controlled OpenAI pair differs only in name and graph batch size", async () => {
    const root = fileURLToPath(new URL("../configs/", import.meta.url));
    const load = async (name: string): Promise<Record<string, unknown>> =>
      yaml.load(await readFile(`${root}/${name}`, "utf8")) as Record<string, unknown>;
    const b3 = await load("architecture-0003-openai-b3-c9.yaml");
    const b9 = await load("architecture-0003-openai-b9-c9.yaml");
    b3.name = "controlled";
    b9.name = "controlled";
    const b3Agent = b3.agent as { options: Record<string, unknown> };
    const b9Agent = b9.agent as { options: Record<string, unknown> };
    b3Agent.options.graph_batch_size = 0;
    b9Agent.options.graph_batch_size = 0;
    expect(b3).toEqual(b9);
  });
});
