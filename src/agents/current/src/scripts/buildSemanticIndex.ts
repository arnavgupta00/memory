import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadArchitectureCases } from "../benchmarks/architectureDataset.js";
import {
  semanticCorpusHash,
  semanticSessionsFromCase,
  SEMANTIC_CHUNKER_VERSION,
} from "../retrieval/semanticChunker.js";
import {
  buildSemanticCorpus,
  writeSemanticCorpus,
  writeSemanticIndexSet,
} from "../retrieval/semanticIndex.js";
import { loadAnnotations } from "../retrieval/notesIndex.js";
import {
  createSemanticProvider,
  defaultSemanticProviderConfig,
} from "../retrieval/semanticProviders.js";
import type {
  SemanticCorpusManifest,
  SemanticIndexSetManifest,
  SemanticProviderId,
  SemanticSession,
} from "../retrieval/semanticTypes.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");

function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals <= 0) continue;
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function parseArgs(argv: string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith("--")) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) output[argument.slice(2)] = "true";
    else {
      output[argument.slice(2)] = value;
      index += 1;
    }
  }
  return output;
}

function required(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

function parseProvider(value: string | undefined): SemanticProviderId {
  const provider = value ?? "voyage";
  if (provider !== "voyage" && provider !== "gemini" && provider !== "openai") {
    throw new Error("--provider must be voyage, gemini, or openai");
  }
  return provider;
}

async function main(): Promise<void> {
  loadDotEnv(resolve(PROJECT_ROOT, ".env"));
  const cli = parseArgs(process.argv.slice(2));
  const datasetPath = resolve(PROJECT_ROOT, required(cli.dataset, "--dataset"));
  const annotationsPath = resolve(PROJECT_ROOT, required(cli.annotations, "--annotations"));
  const outRoot = resolve(PROJECT_ROOT, required(cli.out, "--out"));
  const providerId = parseProvider(cli.provider);
  const maxConcurrency = Number(cli.concurrency ?? "8");
  const corpusConcurrency = Math.max(1, Number(cli["corpus-concurrency"] ?? "3"));
  const defaults = defaultSemanticProviderConfig(providerId, maxConcurrency);
  const config = {
    ...defaults,
    ...(cli.model ? { model: cli.model } : {}),
    ...(cli.dimension ? { dimension: Number(cli.dimension) } : {}),
  };
  const provider = createSemanticProvider(config);
  const annotations = loadAnnotations(annotationsPath);
  const cases = loadArchitectureCases(datasetPath);
  const corpusLimit = cli.limit ? Number(cli.limit) : undefined;
  const unique = new Map<string, SemanticSession[]>();
  for (const item of cases) {
    const sessions = semanticSessionsFromCase(item, annotations);
    const hash = semanticCorpusHash(sessions);
    if (!unique.has(hash)) unique.set(hash, sessions);
  }
  const entries = [...unique.entries()].slice(0, corpusLimit);
  const manifests = Array<SemanticCorpusManifest | undefined>(entries.length);
  let cursor = 0;
  let completed = 0;
  console.log(
    `semantic-index provider=${config.provider} model=${config.model} `
    + `dimension=${String(config.dimension)} corpora=${String(entries.length)}`,
  );

  async function worker(): Promise<void> {
    while (cursor < entries.length) {
      const index = cursor;
      cursor += 1;
      const entry = entries[index];
      if (!entry) continue;
      const [corpusHash, sessions] = entry;
      const manifestPath = resolve(outRoot, corpusHash, "manifest.json");
      let manifest: SemanticCorpusManifest;
      if (existsSync(manifestPath) && cli.force !== "true") {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as SemanticCorpusManifest;
        if (
          manifest.provider !== config.provider
          || manifest.model !== config.model
          || manifest.dimension !== config.dimension
          || manifest.chunker_version !== SEMANTIC_CHUNKER_VERSION
        ) {
          throw new Error(`existing semantic corpus has incompatible configuration: ${manifestPath}`);
        }
      } else {
        const corpus = await buildSemanticCorpus({ sessions, provider });
        writeSemanticCorpus(outRoot, corpus);
        manifest = corpus.manifest;
      }
      manifests[index] = manifest;
      completed += 1;
      console.log(
        `semantic-index progress=${String(completed)}/${String(entries.length)} `
        + `sessions=${String(manifest.session_count)} chunks=${String(manifest.chunk_count)} `
        + `tokens=${String(manifest.input_tokens)}`,
      );
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(corpusConcurrency, Math.max(entries.length, 1)) }, () => worker()),
  );
  const finished = manifests.filter(
    (item): item is SemanticCorpusManifest => item !== undefined,
  );
  const indexSet: SemanticIndexSetManifest = {
    schema_version: 1,
    format: "semantic-index-set-v1",
    provider: config.provider,
    model: config.model,
    dimension: config.dimension,
    chunker_version: SEMANTIC_CHUNKER_VERSION,
    corpora: finished.map((item) => ({
      corpus_hash: item.corpus_hash,
      session_count: item.session_count,
      chunk_count: item.chunk_count,
    })),
    total_input_tokens: finished.reduce((sum, item) => sum + item.input_tokens, 0),
    total_embedding_requests: finished.reduce((sum, item) => sum + item.embedding_requests, 0),
    exact_token_count: finished.every((item) => item.exact_token_count),
    created_at: new Date().toISOString(),
  };
  writeSemanticIndexSet(outRoot, indexSet);
  console.log(`wrote ${resolve(outRoot, "index-set.json")}`);
  console.log(JSON.stringify(indexSet, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
