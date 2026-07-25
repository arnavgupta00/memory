import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { ArtifactStore, EventRecorder, sha256 } from "./artifacts.js";
import { graphHash, replayMutationRecords } from "./graphMutations.js";
import {
  GraphMutationRecordSchema,
  JsonValueSchema,
  MasterContextGraphSchema,
  type JsonObject,
  type MasterContextGraph,
} from "../types.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const IntegritySchemaIssueSchema = z.strictObject({
  code: z.string().min(1),
  path: z.string(),
  message: z.string().min(1),
});

export const IntegrityRecoveryCaseProofSchema = z.strictObject({
  schema_version: z.literal(1),
  question_id: z.string().min(1),
  source_final_graph_sha256: Sha256Schema,
  source_final_graph_semantic_sha256: Sha256Schema,
  source_events_sha256: Sha256Schema,
  source_snapshot_schema_valid: z.boolean(),
  source_snapshot_schema_errors: z.array(IntegritySchemaIssueSchema),
  source_snapshot_graph_hash: Sha256Schema.nullable(),
  event_count: z.number().int().nonnegative(),
  event_tip_hash: Sha256Schema.nullable(),
  mutation_count: z.number().int().nonnegative(),
  replay_graph_hash: Sha256Schema,
  prediction_graph_hash: Sha256Schema,
  recovered_graph_hash: Sha256Schema,
  recovered_final_graph_sha256: Sha256Schema,
  checks: z.strictObject({
    event_chain_valid: z.literal(true),
    replay_schema_valid: z.literal(true),
    replay_matches_prediction: z.literal(true),
    recovered_snapshot_schema_valid: z.literal(true),
    recovered_snapshot_matches_replay: z.literal(true),
    source_bytes_unchanged: z.literal(true),
  }),
  verdict: z.literal("passed"),
});
export type IntegrityRecoveryCaseProof = z.infer<
  typeof IntegrityRecoveryCaseProofSchema
>;

export const IntegrityRecoveryManifestSchema = z.strictObject({
  schema_version: z.literal(1),
  gate_id: z.string().min(1),
  source_run_id: z.string().min(1),
  source_run_path: z.string().min(1),
  source_manifest_sha256: Sha256Schema,
  source_predictions_sha256: Sha256Schema,
  source_redaction_sha256: Sha256Schema,
  source_redaction_test_sha256: Sha256Schema,
  recovered_question_ids: z.array(z.string().min(1)).min(1),
  read_only_source: z.literal(true),
  command: z.array(z.string()),
});
export type IntegrityRecoveryManifest = z.infer<
  typeof IntegrityRecoveryManifestSchema
>;

export const IntegrityRecoveryReportSchema = z.strictObject({
  schema_version: z.literal(1),
  gate_id: z.string().min(1),
  source_run_id: z.string().min(1),
  generated_at: z.string().min(1),
  cause: z.literal("artifact_redaction_corrupted_benign_json_pointer"),
  recovery_method: z.literal("hash_validated_append_only_event_replay"),
  recovered_case_count: z.number().int().positive(),
  cases: z.array(IntegrityRecoveryCaseProofSchema).min(1),
  checks: z.strictObject({
    every_event_chain_valid: z.literal(true),
    every_replay_matches_prediction: z.literal(true),
    every_recovered_graph_schema_valid: z.literal(true),
    every_source_artifact_unchanged: z.literal(true),
    redaction_regression_source_recorded: z.literal(true),
    redaction_regression_test_recorded: z.literal(true),
  }),
  verdict: z.literal("passed"),
});
export type IntegrityRecoveryReport = z.infer<
  typeof IntegrityRecoveryReportSchema
>;

export type LoadedIntegrityRecovery = {
  gateId: string;
  sourceRunId: string;
  proofComplete: true;
  graphsByQuestionId: ReadonlyMap<string, MasterContextGraph>;
  proofsByQuestionId: ReadonlyMap<string, IntegrityRecoveryCaseProof>;
  manifestSha256: string;
  reportSha256: string;
};

export function fileSha256(body: Buffer | string): string {
  return createHash("sha256").update(body).digest("hex");
}

function issuePath(path: readonly PropertyKey[]): string {
  return path.map((part) => String(part)).join(".");
}

function schemaErrors(
  result: z.ZodSafeParseError<unknown>,
): z.infer<typeof IntegritySchemaIssueSchema>[] {
  return result.error.issues.map((issue) => ({
    code: issue.code,
    path: issuePath(issue.path),
    message: issue.message,
  }));
}

export async function reconstructCaseIntegrity(args: {
  caseRoot: string;
  questionId: string;
  predictionGraphHash: string;
  outputStore: ArtifactStore;
}): Promise<IntegrityRecoveryCaseProof> {
  const sourceStore = new ArtifactStore(args.caseRoot);
  const finalGraphPath = resolve(args.caseRoot, "final-graph.json");
  const eventsPath = resolve(args.caseRoot, "events.jsonl");
  const [sourceFinalGraphBody, sourceEventsBody] = await Promise.all([
    readFile(finalGraphPath),
    readFile(eventsPath),
  ]);
  const sourceFinalGraphSha256 = fileSha256(sourceFinalGraphBody);
  const sourceEventsSha256 = fileSha256(sourceEventsBody);
  const rawSnapshot = JsonValueSchema.parse(
    JSON.parse(sourceFinalGraphBody.toString("utf8")),
  );
  const snapshotResult = MasterContextGraphSchema.safeParse(rawSnapshot);

  const events = await new EventRecorder(sourceStore).replay();
  const mutations = events
    .filter((event) =>
      ["graph_mutation_applied", "graph_mutation_rejected"].includes(
        event.event_type,
      )
    )
    .map((event) => GraphMutationRecordSchema.parse(event.payload));
  const replayed = MasterContextGraphSchema.parse(
    replayMutationRecords(mutations),
  );
  const replayGraphHash = graphHash(replayed);
  if (replayGraphHash !== args.predictionGraphHash) {
    throw new Error(
      `integrity recovery replay does not match prediction: ${args.questionId}`,
    );
  }

  await args.outputStore.writeAtomic(
    `cases/${args.questionId}/final-graph.json`,
    replayed as unknown as JsonObject,
  );
  const recoveredName = `cases/${args.questionId}/final-graph.json`;
  const recoveredRaw = await args.outputStore.readJson<unknown>(recoveredName);
  const recovered = MasterContextGraphSchema.parse(recoveredRaw);
  const recoveredBody = await readFile(
    resolve(args.outputStore.root, recoveredName),
  );
  if (graphHash(recovered) !== replayGraphHash) {
    throw new Error(
      `persisted integrity recovery does not match replay: ${args.questionId}`,
    );
  }

  const [sourceFinalGraphAfter, sourceEventsAfter] = await Promise.all([
    readFile(finalGraphPath),
    readFile(eventsPath),
  ]);
  const sourceBytesUnchanged =
    fileSha256(sourceFinalGraphAfter) === sourceFinalGraphSha256
    && fileSha256(sourceEventsAfter) === sourceEventsSha256;
  if (!sourceBytesUnchanged) {
    throw new Error(
      `integrity recovery modified source bytes: ${args.questionId}`,
    );
  }

  const proof = IntegrityRecoveryCaseProofSchema.parse({
    schema_version: 1,
    question_id: args.questionId,
    source_final_graph_sha256: sourceFinalGraphSha256,
    source_final_graph_semantic_sha256: sha256(rawSnapshot),
    source_events_sha256: sourceEventsSha256,
    source_snapshot_schema_valid: snapshotResult.success,
    source_snapshot_schema_errors: snapshotResult.success
      ? []
      : schemaErrors(snapshotResult),
    source_snapshot_graph_hash: snapshotResult.success
      ? graphHash(snapshotResult.data)
      : null,
    event_count: events.length,
    event_tip_hash: events.at(-1)?.event_hash ?? null,
    mutation_count: mutations.length,
    replay_graph_hash: replayGraphHash,
    prediction_graph_hash: args.predictionGraphHash,
    recovered_graph_hash: graphHash(recovered),
    recovered_final_graph_sha256: fileSha256(recoveredBody),
    checks: {
      event_chain_valid: true,
      replay_schema_valid: true,
      replay_matches_prediction: true,
      recovered_snapshot_schema_valid: true,
      recovered_snapshot_matches_replay: true,
      source_bytes_unchanged: true,
    },
    verdict: "passed",
  });
  await args.outputStore.writeAtomic(
    `cases/${args.questionId}/recovery-proof.json`,
    proof as unknown as JsonObject,
  );
  return proof;
}

export async function loadIntegrityRecovery(args: {
  recoveryRoot: string;
  sourceRunId: string;
  sourceManifestSha256: string;
  sourcePredictionsSha256: string;
  currentSourceCaseRoots: ReadonlyMap<string, string>;
}): Promise<LoadedIntegrityRecovery> {
  const recoveryRoot = resolve(args.recoveryRoot);
  const store = new ArtifactStore(recoveryRoot);
  const [manifestRaw, reportRaw] = await Promise.all([
    store.readJson<unknown>("gate-manifest.json"),
    store.readJson<unknown>("gate-report.json"),
  ]);
  const manifest = IntegrityRecoveryManifestSchema.parse(manifestRaw);
  const report = IntegrityRecoveryReportSchema.parse(reportRaw);
  if (
    manifest.source_run_id !== args.sourceRunId
    || report.source_run_id !== args.sourceRunId
    || report.gate_id !== manifest.gate_id
  ) {
    throw new Error("integrity recovery source or gate identity mismatch");
  }
  if (
    manifest.source_manifest_sha256 !== args.sourceManifestSha256
    || manifest.source_predictions_sha256 !== args.sourcePredictionsSha256
  ) {
    throw new Error("integrity recovery run-level source hash mismatch");
  }
  const reportIds = report.cases.map((item) => item.question_id).sort();
  const manifestIds = [...manifest.recovered_question_ids].sort();
  if (
    reportIds.length !== manifestIds.length
    || reportIds.some((id, index) => id !== manifestIds[index])
  ) {
    throw new Error("integrity recovery case manifest mismatch");
  }

  const graphs = new Map<string, MasterContextGraph>();
  const proofs = new Map<string, IntegrityRecoveryCaseProof>();
  for (const proof of report.cases) {
    const sourceCaseRoot = args.currentSourceCaseRoots.get(proof.question_id);
    if (sourceCaseRoot === undefined) {
      throw new Error(
        `integrity recovery names an unknown case: ${proof.question_id}`,
      );
    }
    const [sourceFinalGraphBody, sourceEventsBody, recoveredBody, proofRaw] =
      await Promise.all([
        readFile(resolve(sourceCaseRoot, "final-graph.json")),
        readFile(resolve(sourceCaseRoot, "events.jsonl")),
        readFile(
          resolve(
            recoveryRoot,
            "cases",
            proof.question_id,
            "final-graph.json",
          ),
        ),
        store.readJson<unknown>(
          `cases/${proof.question_id}/recovery-proof.json`,
        ),
      ]);
    const persistedProof = IntegrityRecoveryCaseProofSchema.parse(proofRaw);
    if (JSON.stringify(persistedProof) !== JSON.stringify(proof)) {
      throw new Error(
        `integrity recovery proof copies diverge: ${proof.question_id}`,
      );
    }
    if (
      fileSha256(sourceFinalGraphBody) !== proof.source_final_graph_sha256
      || fileSha256(sourceEventsBody) !== proof.source_events_sha256
      || fileSha256(recoveredBody) !== proof.recovered_final_graph_sha256
    ) {
      throw new Error(
        `integrity recovery case file hash mismatch: ${proof.question_id}`,
      );
    }
    const recovered = MasterContextGraphSchema.parse(
      JSON.parse(recoveredBody.toString("utf8")),
    );
    if (
      graphHash(recovered) !== proof.recovered_graph_hash
      || proof.recovered_graph_hash !== proof.replay_graph_hash
      || proof.replay_graph_hash !== proof.prediction_graph_hash
    ) {
      throw new Error(
        `integrity recovery graph proof mismatch: ${proof.question_id}`,
      );
    }
    graphs.set(proof.question_id, recovered);
    proofs.set(proof.question_id, proof);
  }

  return {
    gateId: manifest.gate_id,
    sourceRunId: manifest.source_run_id,
    proofComplete: true,
    graphsByQuestionId: graphs,
    proofsByQuestionId: proofs,
    manifestSha256: fileSha256(
      await readFile(resolve(recoveryRoot, "gate-manifest.json")),
    ),
    reportSha256: fileSha256(
      await readFile(resolve(recoveryRoot, "gate-report.json")),
    ),
  };
}
