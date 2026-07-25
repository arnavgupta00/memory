import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";
import { z } from "zod";

const PromptMessageSchema = z.strictObject({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

const PromptDefinitionSchema = z.strictObject({
  schema_version: z.literal(1),
  id: z.string().min(1),
  description: z.string().min(1),
  output_contract: z.string().min(1),
  required_variables: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)),
  messages: z.array(PromptMessageSchema).min(1),
});
type PromptDefinition = z.infer<typeof PromptDefinitionSchema>;

/** Mustache-style fill-ins: {{variable_name}} */
const PLACEHOLDER = /\{\{([a-z][a-z0-9_]*)\}\}/g;

export type PromptEnvelope = {
  promptId: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
};

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
      throw new Error(
        `prompt ${definition.id} variable mismatch: missing=${missing.join(",")} extra=${extra.join(",")}`,
      );
    }
    return {
      promptId: definition.id,
      messages: definition.messages.map((message) => ({
        role: message.role,
        content: message.content.replace(PLACEHOLDER, (_match, key: string) => {
          const value = variables[key];
          if (value === undefined) {
            throw new Error(`prompt ${definition.id} missing value for {{${key}}}`);
          }
          return value;
        }),
      })),
    };
  }

  async #load(name: string): Promise<PromptDefinition> {
    const cached = this.#cache.get(name);
    if (cached) return cached;
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`unsafe prompt name: ${name}`);
    const raw: unknown = yaml.load(await readFile(`${this.#root}/${name}.yaml`, "utf8"));
    const definition = PromptDefinitionSchema.parse(raw);
    const found = new Set<string>();
    for (const message of definition.messages) {
      for (const match of message.content.matchAll(PLACEHOLDER)) {
        if (match[1]) found.add(match[1]);
      }
    }
    const declared = new Set(definition.required_variables);
    const undeclared = [...found].filter((key) => !declared.has(key));
    const unused = [...declared].filter((key) => !found.has(key));
    if (undeclared.length || unused.length) {
      throw new Error(
        `prompt ${definition.id} placeholder mismatch: undeclared=${undeclared.join(",")} unused=${unused.join(",")}`,
      );
    }
    this.#cache.set(name, definition);
    return definition;
  }
}
