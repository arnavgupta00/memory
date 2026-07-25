import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { ArtifactStore, EventRecorder } from "../src/services/artifacts.js";
import {
  fileSha256,
  IntegrityRecoveryManifestSchema,
  IntegrityRecoveryReportSchema,
  loadIntegrityRecovery,
  reconstructCaseIntegrity,
} from "../src/services/integrityRecovery.js";
import {
  applyContextoMutation,
  graphHash,
} from "../src/services/graphMutations.js";
import type {
  GraphMutationRecord,
  JsonObject,
  MasterContextGraph,
  SourceReference,
} from "../src/types.js";

const source: SourceReference = {
  sessionId: "s1",
  turnIndex: 0,
  sessionDate: "2025/01/01",
  batchId: "b0001",
  excerpt: "Grandfather's secret dry rub takes 24 hours.",
};

async function fixture(): Promise<{
  root: string;
  caseRoot: string;
  graph: MasterContextGraph;
}> {
  const root = await mkdtemp(join(tmpdir(), "memorybench-integrity-"));
  const caseRoot = join(root, "source", "agent-artifacts", "cases", "q1");
  const store = new ArtifactStore(caseRoot);
  await store.initialize();
  const mutation = {
    mode: "patch" as const,
    explanation: "retain a benign secret-named recipe path",
    operations: [{
      op: "add" as const,
      path: "/context/recipes",
      value: {
        grandfathers_secret_dry_rub: {
          duration_hours: 24,
        },
      },
      sources: [source],
      reason: "direct statement",
    }],
  };
  const applied = applyContextoMutation({
    graph: {
      schemaVersion: 1,
      revision: 0,
      context: {},
      provenanceByPointer: {},
    },
    mutation,
    batchId: "b0001",
    sessions: [{
      session_id: "s1",
      date: "2025/01/01",
      turns: [{ role: "user", content: source.excerpt ?? "" }],
    }],
    allowReplacement: true,
  });
  const record: GraphMutationRecord = {
    batchId: "b0001",
    sessionIds: ["s1"],
    mode: "patch",
    explanation: mutation.explanation,
    accepted: true,
    diffs: applied.diffs,
    graphRevisionBefore: 0,
    graphRevisionAfter: 1,
    graphHash: graphHash(applied.graph),
    mutation,
  };
  await new EventRecorder(store).record(
    "graph_mutation_applied",
    record as unknown as JsonObject,
    record.graphHash,
  );
  await writeFile(
    join(caseRoot, "final-graph.json"),
    `${JSON.stringify({
      ...applied.graph,
      provenanceByPointer: {
        "/context/recipes/grandfathers_secret_dry_rub/duration_hours":
          "[REDACTED]",
      },
    }, null, 2)}\n`,
  );
  return { root, caseRoot, graph: applied.graph };
}

describe("offline graph integrity recovery", () => {
  test("reconstructs from the verified event chain without changing source bytes", async () => {
    const { root, caseRoot, graph } = await fixture();
    const output = new ArtifactStore(join(root, "recovery"));
    await output.initialize();
    const originalBody = await readFile(join(caseRoot, "final-graph.json"));
    const proof = await reconstructCaseIntegrity({
      caseRoot,
      questionId: "q1",
      predictionGraphHash: graphHash(graph),
      outputStore: output,
    });

    expect(proof.source_snapshot_schema_valid).toBe(false);
    expect(proof.source_snapshot_schema_errors.length).toBeGreaterThan(0);
    expect(proof.replay_graph_hash).toBe(graphHash(graph));
    expect(proof.recovered_graph_hash).toBe(graphHash(graph));
    expect(await readFile(join(caseRoot, "final-graph.json"))).toEqual(
      originalBody,
    );
  });

  test("loads only a fully hash-bound recovery bundle", async () => {
    const { root, caseRoot, graph } = await fixture();
    const recoveryRoot = join(root, "recovery");
    const output = new ArtifactStore(recoveryRoot);
    await output.initialize();
    const proof = await reconstructCaseIntegrity({
      caseRoot,
      questionId: "q1",
      predictionGraphHash: graphHash(graph),
      outputStore: output,
    });
    const sourceManifest = Buffer.from("{\"run\":\"fixture\"}\n");
    const sourcePredictions = Buffer.from("{\"question_id\":\"q1\"}\n");
    const manifest = IntegrityRecoveryManifestSchema.parse({
      schema_version: 1,
      gate_id: "recovery-fixture",
      source_run_id: "run-fixture",
      source_run_path: join(root, "source"),
      source_manifest_sha256: fileSha256(sourceManifest),
      source_predictions_sha256: fileSha256(sourcePredictions),
      source_redaction_sha256: "a".repeat(64),
      source_redaction_test_sha256: "b".repeat(64),
      recovered_question_ids: ["q1"],
      read_only_source: true,
      command: ["fixture"],
    });
    const report = IntegrityRecoveryReportSchema.parse({
      schema_version: 1,
      gate_id: "recovery-fixture",
      source_run_id: "run-fixture",
      generated_at: "2026-07-24T00:00:00.000Z",
      cause: "artifact_redaction_corrupted_benign_json_pointer",
      recovery_method: "hash_validated_append_only_event_replay",
      recovered_case_count: 1,
      cases: [proof],
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
    await output.writeAtomic(
      "gate-manifest.json",
      manifest as unknown as JsonObject,
    );
    await output.writeAtomic(
      "gate-report.json",
      report as unknown as JsonObject,
    );

    const loaded = await loadIntegrityRecovery({
      recoveryRoot,
      sourceRunId: "run-fixture",
      sourceManifestSha256: fileSha256(sourceManifest),
      sourcePredictionsSha256: fileSha256(sourcePredictions),
      currentSourceCaseRoots: new Map([["q1", caseRoot]]),
    });
    expect(loaded.proofComplete).toBe(true);
    const recovered = loaded.graphsByQuestionId.get("q1");
    expect(recovered).toBeDefined();
    if (recovered === undefined) throw new Error("missing recovered graph");
    expect(graphHash(recovered)).toBe(graphHash(graph));
  });

  test("refuses recovery when replay and prediction hashes differ", async () => {
    const { root, caseRoot } = await fixture();
    const output = new ArtifactStore(join(root, "recovery"));
    await output.initialize();
    await expect(reconstructCaseIntegrity({
      caseRoot,
      questionId: "q1",
      predictionGraphHash: "0".repeat(64),
      outputStore: output,
    })).rejects.toThrow("does not match prediction");
  });
});
