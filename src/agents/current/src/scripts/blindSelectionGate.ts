import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { ARCHITECTURE_ID } from "../architectureId.js";
import {
  blindSelectionPublicSummary,
  BlindDatasetCaseSchema,
  discoverExposedQuestionIds,
  selectBlindCases,
  verifyFrozenSourceManifest,
  writeBlindSelection,
} from "../services/blindSelection.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "../../../../..");
const ArgumentsSchema = z.strictObject({
  dataset: z.string().min(1),
  freezeManifest: z.string().min(1),
  runsRoot: z.string().min(1),
  output: z.string().min(1),
});

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const args = ArgumentsSchema.parse({
    dataset: argument("--dataset")
      ?? resolve(PROJECT_ROOT, "data/raw/longmemeval_s_cleaned.json"),
    freezeManifest: argument("--freeze-manifest"),
    runsRoot: argument("--runs-root")
      ?? resolve(PROJECT_ROOT, "runs"),
    output: argument("--output"),
  });
  const verified = await verifyFrozenSourceManifest({
    projectRoot: PROJECT_ROOT,
    manifestPath: resolve(args.freezeManifest),
    datasetPath: resolve(args.dataset),
    architectureId: ARCHITECTURE_ID,
  });
  const dataset = z.array(BlindDatasetCaseSchema).parse(
    JSON.parse(await readFile(resolve(args.dataset), "utf8")),
  );
  const knownQuestionIds = new Set(
    dataset.map((item) => item.question_id),
  );
  const exposedQuestionIds = await discoverExposedQuestionIds({
    runsRoot: resolve(args.runsRoot),
    knownQuestionIds,
  });
  const selection = selectBlindCases({
    dataset,
    datasetSha256: verified.datasetSha256,
    architectureId: ARCHITECTURE_ID,
    freezeManifestSha256: verified.manifestSha256,
    exposedQuestionIds,
  });
  const written = await writeBlindSelection(resolve(args.output), selection);
  process.stdout.write(`${JSON.stringify({
    ...blindSelectionPublicSummary(selection),
    selectionPath: written.selectionPath,
    hashPath: written.hashPath,
    fileSha256: written.fileSha256,
  }, null, 2)}\n`);
}

await main();
