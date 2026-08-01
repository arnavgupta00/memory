import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BEAM_ABILITIES,
  beamQuestionKey,
  loadBeamCanaryManifest,
  loadBeamProbes,
  type BeamProbe,
} from "../benchmarks/beam1m.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");

type Prediction = {
  question_id?: string;
  hypothesis?: string;
};

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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function loadPredictions(path: string): Map<string, string> {
  const predictions = new Map<string, string>();
  for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    const value = JSON.parse(line) as Prediction;
    if (typeof value.question_id !== "string" || typeof value.hypothesis !== "string") {
      throw new Error(`prediction line ${String(index + 1)} is missing question_id or hypothesis`);
    }
    if (predictions.has(value.question_id)) {
      throw new Error(`duplicate prediction for ${value.question_id}`);
    }
    predictions.set(value.question_id, value.hypothesis);
  }
  return predictions;
}

function assertFilename(value: string): void {
  if (!/^[A-Za-z0-9_.-]+\.json$/.test(value)) {
    throw new Error("--filename must be a path-safe .json filename");
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.manifest || !args["beam-root"] || !args.predictions || !args.out) {
    throw new Error("--manifest, --beam-root, --predictions, and --out are required");
  }
  const manifestPath = resolve(PROJECT_ROOT, args.manifest);
  const beamRoot = resolve(args["beam-root"]);
  const predictionsPath = resolve(PROJECT_ROOT, args.predictions);
  const outDir = resolve(PROJECT_ROOT, args.out);
  const filename = args.filename ?? "architecture-0008.json";
  assertFilename(filename);
  const manifest = loadBeamCanaryManifest(manifestPath);
  const predictions = loadPredictions(predictionsPath);
  const expectedKeys = new Set(manifest.question_keys);
  const unexpected = [...predictions.keys()].filter((key) => !expectedKeys.has(key));
  if (unexpected.length > 0) {
    throw new Error(`predictions contain questions outside the manifest: ${unexpected.join(", ")}`);
  }
  const missing = manifest.question_keys.filter((key) => !predictions.has(key));
  if (missing.length > 0) {
    throw new Error(`predictions are incomplete; missing ${String(missing.length)} questions`);
  }

  const exported: Array<Record<string, unknown>> = [];
  for (const conversationId of manifest.conversation_ids) {
    const probePath = resolve(
      beamRoot,
      String(conversationId),
      "probing_questions/probing_questions.json",
    );
    const probes = loadBeamProbes(probePath);
    const output = Object.fromEntries(BEAM_ABILITIES.map((ability) => {
      const questions = probes[ability].map((probe, index): BeamProbe & { llm_response: string } => {
        const key = beamQuestionKey(conversationId, ability, index + 1);
        const answer = predictions.get(key);
        if (answer === undefined) throw new Error(`missing prediction for ${key}`);
        return { ...probe, llm_response: answer };
      });
      return [ability, questions];
    }));
    const conversationDir = resolve(outDir, String(conversationId));
    mkdirSync(conversationDir, { recursive: true });
    const outputPath = resolve(conversationDir, filename);
    writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
    exported.push({
      conversation_id: conversationId,
      output_path: outputPath,
      output_sha256: sha256(readFileSync(outputPath)),
      questions: BEAM_ABILITIES.reduce(
        (total, ability) => total + (output[ability]?.length ?? 0),
        0,
      ),
    });
  }

  const exportManifest = {
    schema_version: 1,
    benchmark: "BEAM",
    tier: "1M",
    canary_manifest: basename(manifestPath),
    canary_manifest_sha256: sha256(readFileSync(manifestPath)),
    source_predictions: predictionsPath,
    source_predictions_sha256: sha256(readFileSync(predictionsPath)),
    official_result_filename: filename,
    conversations: exported,
  };
  writeFileSync(
    resolve(outDir, "export-manifest.json"),
    `${JSON.stringify(exportManifest, null, 2)}\n`,
  );
  console.log(JSON.stringify(exportManifest, null, 2));
}

main();
