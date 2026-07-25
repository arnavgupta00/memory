import { access, readFile, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { z } from "zod";

import { ArtifactStore } from "../services/artifacts.js";
import {
  fileSha256,
  IntegrityRecoveryManifestSchema,
  IntegrityRecoveryReportSchema,
  reconstructCaseIntegrity,
} from "../services/integrityRecovery.js";
import { graphHash } from "../services/graphMutations.js";
import {
  JsonValueSchema,
  MasterContextGraphSchema,
  type JsonObject,
} from "../types.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "../../../../..");

const ArgumentsSchema = z.strictObject({
  runId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
  output: z.string().min(1),
  redactionSource: z.string().min(1),
  redactionTest: z.string().min(1),
});

const PredictionSchema = z.looseObject({
  question_id: z.string().min(1),
  trace: z.looseObject({
    graph_hash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function refuseExistingOutput(path: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if (
      error !== null
      && typeof error === "object"
      && "code" in error
      && error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
  throw new Error(`integrity recovery output already exists and is immutable: ${path}`);
}

function parsePredictions(body: string): z.infer<typeof PredictionSchema>[] {
  return body
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => PredictionSchema.parse(JSON.parse(line)));
}

async function main(): Promise<void> {
  const args = ArgumentsSchema.parse({
    runId: argument("--run-id"),
    output: argument("--output"),
    redactionSource: argument("--redaction-source")
      ?? resolve(PROJECT_ROOT, "src/agents/architecture-0003.2-hybrid-graph-reader/src/services/redaction.ts"),
    redactionTest: argument("--redaction-test")
      ?? resolve(PROJECT_ROOT, "src/agents/architecture-0003.2-hybrid-graph-reader/tests/artifactsAndCache.test.ts"),
  });
  const runRoot = resolve(PROJECT_ROOT, "runs", args.runId);
  const outputRoot = resolve(args.output);
  await refuseExistingOutput(outputRoot);

  const manifestPath = resolve(runRoot, "manifest.json");
  const predictionsPath = resolve(runRoot, "predictions.jsonl");
  const [
    sourceManifestBody,
    sourcePredictionsBody,
    redactionSourceBody,
    redactionTestBody,
  ] = await Promise.all([
    readFile(manifestPath),
    readFile(predictionsPath),
    readFile(resolve(args.redactionSource)),
    readFile(resolve(args.redactionTest)),
  ]);
  const predictions = parsePredictions(sourcePredictionsBody.toString("utf8"));
  const predictionById = new Map(
    predictions.map((prediction) => [prediction.question_id, prediction]),
  );
  const casesRoot = resolve(runRoot, "agent-artifacts", "cases");
  const caseIds = (await readdir(casesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const recoverableCaseIds: string[] = [];
  for (const questionId of caseIds) {
    const prediction = predictionById.get(questionId);
    if (prediction === undefined) {
      throw new Error(`integrity recovery found a case without prediction: ${questionId}`);
    }
    const raw = JsonValueSchema.parse(
      JSON.parse(
        await readFile(
          resolve(casesRoot, questionId, "final-graph.json"),
          "utf8",
        ),
      ),
    );
    const snapshot = MasterContextGraphSchema.safeParse(raw);
    if (
      !snapshot.success
      || graphHash(snapshot.data) !== prediction.trace.graph_hash
    ) {
      recoverableCaseIds.push(questionId);
    }
  }
  if (recoverableCaseIds.length === 0) {
    throw new Error("integrity recovery found no invalid or hash-divergent snapshots");
  }

  const output = new ArtifactStore(outputRoot);
  await output.initialize();
  const proofs = [];
  for (const questionId of recoverableCaseIds) {
    const prediction = predictionById.get(questionId);
    if (prediction === undefined) {
      throw new Error(`missing prediction during recovery: ${questionId}`);
    }
    proofs.push(await reconstructCaseIntegrity({
      caseRoot: resolve(casesRoot, questionId),
      questionId,
      predictionGraphHash: prediction.trace.graph_hash,
      outputStore: output,
    }));
  }

  const [manifestAfter, predictionsAfter] = await Promise.all([
    readFile(manifestPath),
    readFile(predictionsPath),
  ]);
  if (
    fileSha256(manifestAfter) !== fileSha256(sourceManifestBody)
    || fileSha256(predictionsAfter) !== fileSha256(sourcePredictionsBody)
  ) {
    throw new Error("integrity recovery modified run-level source bytes");
  }

  const gateId = basename(outputRoot);
  const report = IntegrityRecoveryReportSchema.parse({
    schema_version: 1,
    gate_id: gateId,
    source_run_id: args.runId,
    generated_at: new Date().toISOString(),
    cause: "artifact_redaction_corrupted_benign_json_pointer",
    recovery_method: "hash_validated_append_only_event_replay",
    recovered_case_count: proofs.length,
    cases: proofs,
    checks: {
      every_event_chain_valid: true,
      every_replay_matches_prediction: true,
      every_recovered_graph_schema_valid: true,
      every_source_artifact_unchanged: true,
      redaction_regression_source_recorded: true,
      redaction_regression_test_recorded: true,
    },
    verdict: "passed",
  });
  const manifest = IntegrityRecoveryManifestSchema.parse({
    schema_version: 1,
    gate_id: gateId,
    source_run_id: args.runId,
    source_run_path: runRoot,
    source_manifest_sha256: fileSha256(sourceManifestBody),
    source_predictions_sha256: fileSha256(sourcePredictionsBody),
    source_redaction_sha256: fileSha256(redactionSourceBody),
    source_redaction_test_sha256: fileSha256(redactionTestBody),
    recovered_question_ids: recoverableCaseIds,
    read_only_source: true,
    command: process.argv,
  });
  await Promise.all([
    output.writeAtomic("gate-report.json", report as unknown as JsonObject),
    output.writeAtomic("gate-manifest.json", manifest as unknown as JsonObject),
  ]);
  process.stdout.write(`${JSON.stringify({
    verdict: report.verdict,
    recovered_case_count: report.recovered_case_count,
    recovered_question_ids: recoverableCaseIds,
    checks: report.checks,
  }, null, 2)}\n`);
}

await main();
