import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { prepareBeamDataset } from "../benchmarks/beam1m.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const DEFAULT_MANIFEST = resolve(
  PROJECT_ROOT,
  "src/agents/current/eval-slices/beam-1m/beam-1m-canary-a-development-v1.json",
);

function parseArgs(argv: string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith("--")) continue;
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) output[key] = "true";
    else {
      output[key] = value;
      index += 1;
    }
  }
  return output;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args["beam-root"]) {
    throw new Error("--beam-root is required and must point to the official BEAM chats/1M directory");
  }
  const beamRoot = resolve(args["beam-root"]);
  const manifestPath = resolve(args.manifest ?? DEFAULT_MANIFEST);
  const outDir = resolve(args.out ?? resolve(PROJECT_ROOT, "runs/beam-1m-canary-a/input"));
  const allowOfficialReencoding = args["allow-official-parquet-reencoding"] === "true";
  const prepared = prepareBeamDataset({
    beamRoot,
    manifestPath,
    allowOfficialReencoding,
  });
  mkdirSync(outDir, { recursive: true });

  const outputs = {
    "dataset.json": prepared.dataset,
    "oracle.json": prepared.oracle,
    "slice.json": prepared.slice,
  };
  for (const [filename, value] of Object.entries(outputs)) {
    writeFileSync(resolve(outDir, filename), `${JSON.stringify(value, null, 2)}\n`);
  }
  const sourceManifest = {
    schema_version: 1,
    benchmark: "BEAM",
    tier: "1M",
    canary_manifest_path: manifestPath,
    canary_manifest_sha256: sha256(readFileSync(manifestPath)),
    adapter: "beam-1m-to-architecture-case-bundle-v1",
    source_encoding: allowOfficialReencoding
      ? "official-huggingface-parquet-reencoded-json"
      : "original-json-bytes",
    memory_unit: "official BEAM turn group beginning at a main question",
    time_policy:
      "carry the latest explicit batch/message time_anchor; preserve session ordinal in every date label",
    question_count: prepared.dataset.cases.length,
    conversation_count: prepared.dataset.conversations.length,
    unique_session_count: prepared.dataset.conversations.reduce(
      (total, conversation) => total + conversation.session_ids.length,
      0,
    ),
    gold_visibility: "oracle.json only; excluded from dataset.json and all inference prompts",
    source_files: prepared.sourceFiles,
    output_sha256: Object.fromEntries(
      Object.keys(outputs).map((filename) => [filename, sha256(readFileSync(resolve(outDir, filename)))]),
    ),
  };
  writeFileSync(
    resolve(outDir, "source-manifest.json"),
    `${JSON.stringify(sourceManifest, null, 2)}\n`,
  );
  console.log(JSON.stringify({ out_dir: outDir, ...sourceManifest }, null, 2));
}

main();
