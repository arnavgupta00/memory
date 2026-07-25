import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import { redact } from "./redaction.js";
import type { JsonObject, JsonValue } from "../types.js";

const SAFE_RELATIVE = /^[a-zA-Z0-9][a-zA-Z0-9_.\-/]*$/;

function stable(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key] ?? null)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: JsonValue | string): string {
  const body = typeof value === "string" ? value : stable(value);
  return createHash("sha256").update(body).digest("hex");
}

export class ArtifactStore {
  readonly root: string;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(root: string) {
    this.root = resolve(root);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async append(stream: string, value: JsonObject): Promise<void> {
    const path = this.#path(stream.endsWith(".jsonl") ? stream : `${stream}.jsonl`);
    const body = `${JSON.stringify(redact(value))}\n`;
    this.#writeChain = this.#writeChain.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const existing = await readFile(path, "utf8").catch(() => "");
      await writeFile(path, existing + body, "utf8");
    });
    await this.#writeChain;
  }

  async writeAtomic(name: string, value: JsonValue | string): Promise<void> {
    const path = this.#path(name);
    await mkdir(dirname(path), { recursive: true });
    const sanitized = redact(value);
    const body = typeof sanitized === "string" ? sanitized : `${JSON.stringify(sanitized, null, 2)}\n`;
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, body, "utf8");
    await rename(temporary, path);
  }

  async readJson<T>(name: string): Promise<T | null> {
    const path = this.#path(name);
    const body = await readFile(path, "utf8").catch(() => null);
    return body === null ? null : (JSON.parse(body) as T);
  }

  async readJsonl(name: string): Promise<JsonObject[]> {
    const path = this.#path(name.endsWith(".jsonl") ? name : `${name}.jsonl`);
    const body = await readFile(path, "utf8").catch(() => "");
    return body
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JsonObject);
  }

  async exists(name: string): Promise<boolean> {
    return stat(this.#path(name)).then(() => true).catch(() => false);
  }

  #path(name: string): string {
    if (!SAFE_RELATIVE.test(name) || name.split("/").includes("..")) {
      throw new Error(`unsafe artifact name: ${name}`);
    }
    const path = resolve(this.root, name);
    if (path !== this.root && !path.startsWith(`${this.root}${sep}`)) {
      throw new Error(`artifact escapes case root: ${name}`);
    }
    return path;
  }
}

export type ArchitectureEvent = {
  sequence: number;
  schema_version: 1;
  event_type: string;
  recorded_at: string;
  previous_event_hash: string | null;
  graph_state_hash: string | null;
  payload: JsonObject;
  event_hash: string;
};

export class EventRecorder {
  readonly #store: ArtifactStore;

  constructor(store: ArtifactStore) {
    this.#store = store;
  }

  async record(eventType: string, payload: JsonObject, graphHash: string | null): Promise<ArchitectureEvent> {
    const existing = await this.replay();
    const previous = existing.at(-1)?.event_hash;
    const unsigned = {
      sequence: existing.length + 1,
      schema_version: 1 as const,
      event_type: eventType,
      recorded_at: new Date().toISOString(),
      previous_event_hash: typeof previous === "string" ? previous : null,
      graph_state_hash: graphHash,
      payload,
    };
    const sanitized = redact(unsigned as unknown as JsonObject);
    if (sanitized === null || Array.isArray(sanitized) || typeof sanitized !== "object") {
      throw new Error("redacted event must remain an object");
    }
    const event = {
      ...sanitized,
      event_hash: sha256(sanitized),
    } as unknown as ArchitectureEvent;
    await this.#store.append("events", event as unknown as JsonObject);
    return event;
  }

  async replay(): Promise<ArchitectureEvent[]> {
    const raw = await this.#store.readJsonl("events");
    const events: ArchitectureEvent[] = [];
    let previous: string | null = null;
    for (const [index, item] of raw.entries()) {
      if (
        item.schema_version !== 1 ||
        item.sequence !== index + 1 ||
        item.previous_event_hash !== previous ||
        typeof item.event_type !== "string" ||
        typeof item.recorded_at !== "string" ||
        item.payload === null ||
        item.payload === undefined ||
        Array.isArray(item.payload) ||
        typeof item.payload !== "object" ||
        typeof item.event_hash !== "string"
      ) {
        throw new Error(`invalid event chain record at sequence ${String(index + 1)}`);
      }
      const event = item as unknown as ArchitectureEvent;
      const { event_hash: eventHash, ...unsigned } = event;
      if (sha256(unsigned as unknown as JsonObject) !== eventHash) {
        throw new Error(`event hash mismatch at sequence ${String(event.sequence)}`);
      }
      events.push(event);
      previous = eventHash;
    }
    return events;
  }
}
