import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "vitest";

import {
  assertBlindInspectionUnlocked,
  blindSelectionPublicSummary,
  discoverExposedQuestionIds,
  OFFICIAL_QUESTION_TYPES,
  REQUIRED_ABSTENTION_TYPES,
  selectBlindCases,
  verifyFrozenSourceManifest,
  verifyBlindSelectionSeal,
  writeBlindSelection,
  type BlindDatasetCase,
} from "../src/services/blindSelection.js";

const ARCHITECTURE_ID = "0003.2-hybrid-graph-reader";
const DATASET_HASH = "a".repeat(64);
const FREEZE_HASH = "b".repeat(64);

function hash(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function syntheticDataset(): BlindDatasetCase[] {
  return OFFICIAL_QUESTION_TYPES.flatMap((questionType) => {
    const answerable = Array.from({ length: 6 }, (_, index) => ({
      question_id: `${questionType}-answerable-${String(index)}`,
      question_type: questionType,
    }));
    const abstentions = REQUIRED_ABSTENTION_TYPES.includes(
      questionType as (typeof REQUIRED_ABSTENTION_TYPES)[number],
    )
      ? Array.from({ length: 2 }, (_, index) => ({
          question_id: `${questionType}-${String(index)}_abs`,
          question_type: questionType,
        }))
      : [];
    return [...answerable, ...abstentions];
  });
}

describe("Gate 7 blind selection", () => {
  test("deterministically selects three per type and exactly four abstentions", () => {
    const dataset = syntheticDataset();
    const exposed = new Set([
      dataset[0]?.question_id ?? "",
      dataset.at(-1)?.question_id ?? "",
    ]);
    const first = selectBlindCases({
      dataset,
      datasetSha256: DATASET_HASH,
      architectureId: ARCHITECTURE_ID,
      freezeManifestSha256: FREEZE_HASH,
      exposedQuestionIds: exposed,
    });
    const second = selectBlindCases({
      dataset: [...dataset].reverse(),
      datasetSha256: DATASET_HASH,
      architectureId: ARCHITECTURE_ID,
      freezeManifestSha256: FREEZE_HASH,
      exposedQuestionIds: exposed,
    });

    expect(second).toEqual(first);
    expect(first.selected).toHaveLength(18);
    expect(first.selected.some((item) =>
      exposed.has(item.questionId)
    )).toBe(false);
    for (const questionType of OFFICIAL_QUESTION_TYPES) {
      expect(first.selected.filter((item) =>
        item.questionType === questionType
      )).toHaveLength(3);
    }
    const abstentions = first.selected.filter((item) => item.abstention);
    expect(abstentions).toHaveLength(4);
    expect(new Set(abstentions.map((item) => item.questionType))).toEqual(
      new Set(REQUIRED_ABSTENTION_TYPES),
    );
  });

  test("discovers exposure from run manifests, repair reports, and case directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "memorybench-blind-exposure-"));
    const known = new Set(["q-run", "q-gate", "q-report", "q-directory"]);
    await Promise.all([
      mkdir(resolve(root, "run-a"), { recursive: true }),
      mkdir(resolve(root, "local-archive/fix-gates/gate-a/cases/q-directory"), {
        recursive: true,
      }),
    ]);
    await Promise.all([
      writeFile(
        resolve(root, "run-a/manifest.json"),
        JSON.stringify({ selected_question_ids: ["q-run"] }),
      ),
      writeFile(
        resolve(root, "local-archive/fix-gates/gate-a/gate-manifest.json"),
        JSON.stringify({ cases: ["q-gate"] }),
      ),
      writeFile(
        resolve(root, "local-archive/fix-gates/gate-a/gate-report.json"),
        JSON.stringify({ evaluation: [{ questionId: "q-report" }] }),
      ),
    ]);

    expect(await discoverExposedQuestionIds({
      runsRoot: root,
      knownQuestionIds: known,
    })).toEqual(known);
  });

  test("verifies every frozen source, prompt, config, and dataset hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "memorybench-blind-freeze-"));
    const files = {
      "src/agent.ts": "source",
      "prompts/answer.yaml": "prompt",
      "configs/run.yaml": "config",
      "data/dataset.json": "dataset",
    };
    for (const [relativePath, body] of Object.entries(files)) {
      const path = resolve(root, relativePath);
      await mkdir(resolve(path, ".."), { recursive: true });
      await writeFile(path, body);
    }
    const manifest = {
      schema_version: 1,
      architecture_id: ARCHITECTURE_ID,
      dataset_sha256: hash(files["data/dataset.json"]),
      source_hashes: { "src/agent.ts": hash(files["src/agent.ts"]) },
      prompt_hashes: {
        "prompts/answer.yaml": hash(files["prompts/answer.yaml"]),
      },
      config_hashes: { "configs/run.yaml": hash(files["configs/run.yaml"]) },
      frozen_at: "2026-07-24T00:00:00Z",
    };
    const manifestPath = resolve(root, "freeze-manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(verifyFrozenSourceManifest({
      projectRoot: root,
      manifestPath,
      datasetPath: resolve(root, "data/dataset.json"),
      architectureId: ARCHITECTURE_ID,
    })).resolves.toMatchObject({
      datasetSha256: manifest.dataset_sha256,
    });

    await writeFile(resolve(root, "prompts/answer.yaml"), "tampered");
    await expect(verifyFrozenSourceManifest({
      projectRoot: root,
      manifestPath,
      datasetPath: resolve(root, "data/dataset.json"),
      architectureId: ARCHITECTURE_ID,
    })).rejects.toThrow("frozen file hash mismatch");
  });

  test("writes a sealed, hashed selection without exposing IDs in the public summary", async () => {
    const root = await mkdtemp(join(tmpdir(), "memorybench-blind-output-"));
    const selection = selectBlindCases({
      dataset: syntheticDataset(),
      datasetSha256: DATASET_HASH,
      architectureId: ARCHITECTURE_ID,
      freezeManifestSha256: FREEZE_HASH,
      exposedQuestionIds: new Set(),
    });
    const written = await writeBlindSelection(root, selection);
    const body = await readFile(written.selectionPath, "utf8");
    const hashBody = await readFile(written.hashPath, "utf8");
    expect(hash(body)).toBe(written.fileSha256);
    expect(hashBody).toBe(
      `${written.fileSha256}  blind-selection.json\n`,
    );
    const summary = blindSelectionPublicSummary(selection);
    expect(summary).toEqual({
      selectedCount: 18,
      selectionPayloadSha256: selection.selectionPayloadSha256,
      sealed: true,
    });
    const firstSelectedId = selection.selected[0]?.questionId;
    if (firstSelectedId === undefined) {
      throw new Error("selection unexpectedly empty");
    }
    expect(JSON.stringify(summary)).not.toContain(firstSelectedId);
    const tampered = structuredClone(selection);
    const firstSelected = tampered.selected[0];
    if (firstSelected === undefined) {
      throw new Error("selection unexpectedly empty");
    }
    firstSelected.questionId = "tampered-question-id";
    expect(() => verifyBlindSelectionSeal(tampered)).toThrow(
      "payload hash mismatch",
    );
    await expect(writeBlindSelection(root, selection)).rejects.toThrow(
      "already exists",
    );
  });

  test("keeps inspection sealed until all selected predictions and canonical judgments exist", () => {
    const selection = selectBlindCases({
      dataset: syntheticDataset(),
      datasetSha256: DATASET_HASH,
      architectureId: ARCHITECTURE_ID,
      freezeManifestSha256: FREEZE_HASH,
      exposedQuestionIds: new Set(),
    });
    const ids = selection.selected.map((item) => item.questionId);
    const completeProof = {
      predictions: ids.map((question_id) => ({ question_id })),
      judgments: ids.map((question_id) => ({
        question_id,
        autoeval_label: {
          model: "gpt-4o-2024-08-06" as const,
          label: true,
        },
      })),
    };
    expect(() => assertBlindInspectionUnlocked(
      selection,
      { ...completeProof, judgments: completeProof.judgments.slice(1) },
    )).toThrow("remains sealed");
    expect(() =>
      assertBlindInspectionUnlocked(selection, completeProof)
    ).not.toThrow();
  });
});
