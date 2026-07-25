import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";
import { z } from "zod";

import { PromptMessageSchema, type PromptEnvelope } from "../types.js";

const PromptDefinitionSchema = z.strictObject({
  schema_version: z.literal(1),
  id: z.string().min(1),
  description: z.string().min(1),
  output_contract: z.string().min(1),
  required_variables: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)),
  messages: z.array(PromptMessageSchema).min(1),
});
type PromptDefinition = z.infer<typeof PromptDefinitionSchema>;

const PLACEHOLDER = /\{([a-z][a-z0-9_]*)\}/g;

export class PromptLoader {
  readonly #root: string;
  readonly #cache = new Map<string, PromptDefinition>();

  constructor(root = fileURLToPath(new URL("../../prompts/", import.meta.url))) {
    this.#root = root;
  }

  async render(name: string, variables: Record<string, string>): Promise<PromptEnvelope> {
    const definition = await this.#load(name);
    const declared = new Set(definition.required_variables);
    const supplied = new Set(Object.keys(variables));
    const missing = [...declared].filter((key) => !supplied.has(key));
    const extra = [...supplied].filter((key) => !declared.has(key));
    if (missing.length || extra.length) {
      throw new Error(`prompt ${definition.id} variable mismatch: missing=${missing.join(",")} extra=${extra.join(",")}`);
    }
    return {
      promptId: definition.id,
      messages: definition.messages.map((message) => ({
        role: message.role,
        content: message.content.replace(PLACEHOLDER, (_match, key: string) => variables[key] ?? ""),
      })),
    };
  }

  async #load(name: string): Promise<PromptDefinition> {
    const cached = this.#cache.get(name);
    if (cached) return cached;
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`unsafe prompt name: ${name}`);
    const raw = yaml.load(await readFile(`${this.#root}/${name}.yaml`, "utf8"));
    const definition = PromptDefinitionSchema.parse(raw);
    const occurrences = new Map<string, number>();
    for (const message of definition.messages) {
      for (const match of message.content.matchAll(PLACEHOLDER)) {
        if (match[1]) occurrences.set(match[1], (occurrences.get(match[1]) ?? 0) + 1);
      }
    }
    const found = new Set(occurrences.keys());
    const declared = new Set(definition.required_variables);
    const undeclared = [...found].filter((key) => !declared.has(key));
    const unused = [...declared].filter((key) => !found.has(key));
    const repeated = [...occurrences].filter(([, count]) => count !== 1).map(([key]) => key);
    if (undeclared.length || unused.length || repeated.length) {
      throw new Error(`prompt ${definition.id} placeholder mismatch: undeclared=${undeclared.join(",")} unused=${unused.join(",")} repeated=${repeated.join(",")}`);
    }
    this.#cache.set(name, definition);
    return definition;
  }
}
