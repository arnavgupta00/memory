import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import { z } from "zod";

import type { JsonObject } from "../types.js";
import { sha256 } from "./artifacts.js";

export const OFFICIAL_QUESTION_TYPES = [
  "single-session-user",
  "single-session-assistant",
  "single-session-preference",
  "multi-session",
  "knowledge-update",
  "temporal-reasoning",
] as const;

export const REQUIRED_ABSTENTION_TYPES = [
  "knowledge-update",
  "multi-session",
  "single-session-user",
  "temporal-reasoning",
] as const;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const RelativePathSchema = z.string().min(1).refine(
  (value) => !value.startsWith("/") && !value.split("/").includes(".."),
  "hash-manifest paths must be safe and project-relative",
);
const HashRecordSchema = z.record(RelativePathSchema, Sha256Schema).refine(
  (record) => Object.keys(record).length > 0,
  "hash record must contain at least one file",
);

export const OfficialQuestionTypeSchema = z.enum(OFFICIAL_QUESTION_TYPES);
export type OfficialQuestionType = z.infer<typeof OfficialQuestionTypeSchema>;

export const BlindDatasetCaseSchema = z.object({
  question_id: z.string().min(1),
  question_type: OfficialQuestionTypeSchema,
});
export type BlindDatasetCase = z.infer<typeof BlindDatasetCaseSchema>;

export const FrozenSourceManifestSchema = z.strictObject({
  schema_version: z.literal(1),
  architecture_id: z.string().min(1),
  dataset_sha256: Sha256Schema,
  source_hashes: HashRecordSchema,
  prompt_hashes: HashRecordSchema,
  config_hashes: HashRecordSchema,
  frozen_at: z.string().min(1),
});
export type FrozenSourceManifest = z.infer<typeof FrozenSourceManifestSchema>;

const SelectedBlindCaseSchema = z.strictObject({
  questionId: z.string().min(1),
  questionType: OfficialQuestionTypeSchema,
  abstention: z.boolean(),
  selectionHash: Sha256Schema,
});

export const BlindSelectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  architectureId: z.string().min(1),
  datasetSha256: Sha256Schema,
  freezeManifestSha256: Sha256Schema,
  algorithm: z.literal(
    "sha256(dataset_sha256\\0architecture_id\\0question_id), ascending",
  ),
  accessPolicy: z.strictObject({
    state: z.literal("sealed"),
    unlockCondition: z.literal(
      "all_18_predictions_and_canonical_judgments_complete",
    ),
    questionAndSessionInspectionBeforeUnlock: z.literal("prohibited"),
    intermediateArtifactInspectionBeforeUnlock: z.literal("prohibited"),
  }),
  exclusions: z.strictObject({
    count: z.number().int().nonnegative(),
    questionIdsSha256: Sha256Schema,
  }),
  selected: z.array(SelectedBlindCaseSchema).length(18),
  selectionPayloadSha256: Sha256Schema,
});
export type BlindSelection = z.infer<typeof BlindSelectionSchema>;

const CanonicalJudgmentProofSchema = z.strictObject({
  question_id: z.string().min(1),
  autoeval_label: z.strictObject({
    model: z.literal("gpt-4o-2024-08-06"),
    label: z.boolean(),
  }),
});

export type BlindInspectionProof = {
  predictions: Array<{ question_id: string }>;
  judgments: Array<z.infer<typeof CanonicalJudgmentProofSchema>>;
};

function rawSha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeProjectPath(projectRoot: string, relativePath: string): string {
  RelativePathSchema.parse(relativePath);
  const root = resolve(projectRoot);
  const path = resolve(root, relativePath);
  if (!path.startsWith(`${root}${sep}`)) {
    throw new Error(`hash-manifest path escapes project root: ${relativePath}`);
  }
  return path;
}

export async function verifyFrozenSourceManifest(args: {
  projectRoot: string;
  manifestPath: string;
  datasetPath: string;
  architectureId: string;
}): Promise<{
  manifest: FrozenSourceManifest;
  manifestSha256: string;
  datasetSha256: string;
}> {
  const body = await readFile(resolve(args.manifestPath));
  const manifest = FrozenSourceManifestSchema.parse(
    JSON.parse(body.toString("utf8")),
  );
  const datasetSha256 = rawSha256(await readFile(resolve(args.datasetPath)));
  if (manifest.architecture_id !== args.architectureId) {
    throw new Error(
      `frozen architecture ${manifest.architecture_id} does not match ${args.architectureId}`,
    );
  }
  if (manifest.dataset_sha256 !== datasetSha256) {
    throw new Error("frozen dataset hash does not match the selection dataset");
  }
  const groups = [
    manifest.source_hashes,
    manifest.prompt_hashes,
    manifest.config_hashes,
  ];
  for (const group of groups) {
    for (const [relativePath, expectedHash] of Object.entries(group)) {
      const actualHash = rawSha256(
        await readFile(safeProjectPath(args.projectRoot, relativePath)),
      );
      if (actualHash !== expectedHash) {
        throw new Error(`frozen file hash mismatch: ${relativePath}`);
      }
    }
  }
  return {
    manifest,
    manifestSha256: rawSha256(body),
    datasetSha256,
  };
}

async function walkDirectories(
  root: string,
  visit: (path: string, entries: Dirent[]) => Promise<void>,
): Promise<void> {
  const entries: Dirent[] = await readdir(
    root,
    { withFileTypes: true },
  ).catch(() => []);
  await visit(root, entries);
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await walkDirectories(resolve(root, entry.name), visit);
    }
  }
}

function collectKnownStrings(
  value: unknown,
  knownQuestionIds: ReadonlySet<string>,
  exposed: Set<string>,
): void {
  if (typeof value === "string") {
    if (knownQuestionIds.has(value)) exposed.add(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectKnownStrings(item, knownQuestionIds, exposed));
    return;
  }
  if (value === null || typeof value !== "object") return;
  Object.values(value).forEach((item) =>
    collectKnownStrings(item, knownQuestionIds, exposed)
  );
}

const EXPOSURE_FILE_NAMES = new Set([
  "manifest.json",
  "gate-manifest.json",
  "gate-report.json",
  "blind-selection.json",
]);

export async function discoverExposedQuestionIds(args: {
  runsRoot: string;
  knownQuestionIds: ReadonlySet<string>;
}): Promise<Set<string>> {
  const exposed = new Set<string>();
  await walkDirectories(resolve(args.runsRoot), async (path, entries) => {
    if (path.endsWith(`${sep}cases`)) {
      for (const entry of entries) {
        if (entry.isDirectory() && args.knownQuestionIds.has(entry.name)) {
          exposed.add(entry.name);
        }
      }
    }
    await Promise.all(
      entries
        .filter((entry) =>
          entry.isFile() && EXPOSURE_FILE_NAMES.has(entry.name)
        )
        .map(async (entry) => {
          const body = await readFile(resolve(path, entry.name), "utf8");
          collectKnownStrings(
            JSON.parse(body) as unknown,
            args.knownQuestionIds,
            exposed,
          );
        }),
    );
  });
  return exposed;
}

function selectionHash(
  datasetSha256: string,
  architectureId: string,
  questionId: string,
): string {
  return rawSha256(
    `${datasetSha256}\u0000${architectureId}\u0000${questionId}`,
  );
}

function ranked(
  cases: readonly BlindDatasetCase[],
  datasetSha256: string,
  architectureId: string,
): Array<BlindDatasetCase & { selectionHash: string }> {
  return cases
    .map((item) => ({
      ...item,
      selectionHash: selectionHash(
        datasetSha256,
        architectureId,
        item.question_id,
      ),
    }))
    .sort((left, right) =>
      left.selectionHash.localeCompare(right.selectionHash)
      || left.question_id.localeCompare(right.question_id)
    );
}

export function selectBlindCases(args: {
  dataset: readonly BlindDatasetCase[];
  datasetSha256: string;
  architectureId: string;
  freezeManifestSha256: string;
  exposedQuestionIds: ReadonlySet<string>;
}): BlindSelection {
  Sha256Schema.parse(args.datasetSha256);
  Sha256Schema.parse(args.freezeManifestSha256);
  const uniqueIds = new Set(args.dataset.map((item) => item.question_id));
  if (uniqueIds.size !== args.dataset.length) {
    throw new Error("blind-selection dataset contains duplicate question IDs");
  }
  const eligible = args.dataset.filter(
    (item) => !args.exposedQuestionIds.has(item.question_id),
  );
  const requiredAbstentions = new Set<OfficialQuestionType>(
    REQUIRED_ABSTENTION_TYPES,
  );
  const selected: Array<z.infer<typeof SelectedBlindCaseSchema>> = [];
  for (const questionType of OFFICIAL_QUESTION_TYPES) {
    const typeCases = eligible.filter(
      (item) => item.question_type === questionType,
    );
    const abstentions = ranked(
      typeCases.filter((item) => item.question_id.endsWith("_abs")),
      args.datasetSha256,
      args.architectureId,
    );
    const answerable = ranked(
      typeCases.filter((item) => !item.question_id.endsWith("_abs")),
      args.datasetSha256,
      args.architectureId,
    );
    const selectedForType = requiredAbstentions.has(questionType)
      ? [abstentions[0], ...answerable.slice(0, 2)]
      : answerable.slice(0, 3);
    if (
      selectedForType.length !== 3
      || selectedForType.some((item) => item === undefined)
    ) {
      throw new Error(
        `insufficient untouched cases for blind stratum ${questionType}`,
      );
    }
    selected.push(
      ...selectedForType.map((item) => {
        if (item === undefined) throw new Error("unreachable blind stratum gap");
        return {
          questionId: item.question_id,
          questionType: item.question_type,
          abstention: item.question_id.endsWith("_abs"),
          selectionHash: item.selectionHash,
        };
      }),
    );
  }
  const ordered = [...selected].sort((left, right) =>
    left.selectionHash.localeCompare(right.selectionHash)
    || left.questionId.localeCompare(right.questionId)
  );
  const excludedIds = [...args.exposedQuestionIds]
    .filter((questionId) => uniqueIds.has(questionId))
    .sort();
  const payload = {
    schemaVersion: 1 as const,
    architectureId: args.architectureId,
    datasetSha256: args.datasetSha256,
    freezeManifestSha256: args.freezeManifestSha256,
    algorithm:
      "sha256(dataset_sha256\\0architecture_id\\0question_id), ascending" as const,
    accessPolicy: {
      state: "sealed" as const,
      unlockCondition:
        "all_18_predictions_and_canonical_judgments_complete" as const,
      questionAndSessionInspectionBeforeUnlock: "prohibited" as const,
      intermediateArtifactInspectionBeforeUnlock: "prohibited" as const,
    },
    exclusions: {
      count: excludedIds.length,
      questionIdsSha256: rawSha256(excludedIds.join("\n")),
    },
    selected: ordered,
  };
  return BlindSelectionSchema.parse({
    ...payload,
    selectionPayloadSha256: sha256(payload as unknown as JsonObject),
  });
}

function sameQuestionIdSet(
  selected: readonly string[],
  candidate: readonly string[],
): boolean {
  return (
    selected.length === candidate.length
    && new Set(candidate).size === candidate.length
    && selected.every((questionId) => candidate.includes(questionId))
  );
}

function selectionPayload(
  selection: BlindSelection,
): Omit<BlindSelection, "selectionPayloadSha256"> {
  return {
    schemaVersion: selection.schemaVersion,
    architectureId: selection.architectureId,
    datasetSha256: selection.datasetSha256,
    freezeManifestSha256: selection.freezeManifestSha256,
    algorithm: selection.algorithm,
    accessPolicy: selection.accessPolicy,
    exclusions: selection.exclusions,
    selected: selection.selected,
  };
}

export function verifyBlindSelectionSeal(
  selection: BlindSelection,
): BlindSelection {
  const parsed = BlindSelectionSchema.parse(selection);
  const actualHash = sha256(
    selectionPayload(parsed) as unknown as JsonObject,
  );
  if (actualHash !== parsed.selectionPayloadSha256) {
    throw new Error("blind-selection payload hash mismatch");
  }
  return parsed;
}

export function assertBlindInspectionUnlocked(
  selection: BlindSelection,
  proof: BlindInspectionProof,
): void {
  const verified = verifyBlindSelectionSeal(selection);
  const selectedIds = verified.selected.map((item) => item.questionId);
  const predictions = z.array(
    z.strictObject({ question_id: z.string().min(1) }),
  ).parse(proof.predictions);
  const judgments = z.array(CanonicalJudgmentProofSchema).parse(
    proof.judgments,
  );
  if (
    !sameQuestionIdSet(
      selectedIds,
      predictions.map((item) => item.question_id),
    )
    || !sameQuestionIdSet(
      selectedIds,
      judgments.map((item) => item.question_id),
    )
  ) {
    throw new Error(
      "blind inspection remains sealed until all 18 predictions and canonical judgments complete",
    );
  }
}

async function refuseExisting(path: string): Promise<void> {
  const exists = await access(path).then(() => true).catch(() => false);
  if (exists) throw new Error(`blind-selection artifact already exists: ${path}`);
}

export async function writeBlindSelection(
  outputDirectory: string,
  selection: BlindSelection,
): Promise<{ selectionPath: string; hashPath: string; fileSha256: string }> {
  const parsed = verifyBlindSelectionSeal(selection);
  const selectionPath = resolve(outputDirectory, "blind-selection.json");
  const hashPath = resolve(outputDirectory, "blind-selection.sha256");
  await Promise.all([
    refuseExisting(selectionPath),
    refuseExisting(hashPath),
  ]);
  await mkdir(dirname(selectionPath), { recursive: true });
  const body = `${JSON.stringify(parsed, null, 2)}\n`;
  const fileSha256 = rawSha256(body);
  await writeFile(selectionPath, body, { encoding: "utf8", flag: "wx" });
  await writeFile(
    hashPath,
    `${fileSha256}  blind-selection.json\n`,
    { encoding: "utf8", flag: "wx" },
  );
  return { selectionPath, hashPath, fileSha256 };
}

export function blindSelectionPublicSummary(selection: BlindSelection): {
  selectedCount: number;
  selectionPayloadSha256: string;
  sealed: true;
} {
  const parsed = verifyBlindSelectionSeal(selection);
  return {
    selectedCount: parsed.selected.length,
    selectionPayloadSha256: parsed.selectionPayloadSha256,
    sealed: true,
  };
}
