import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  materializeMapperPages,
  type MapperMaterialization,
} from "../ingestion/structuredEventMaterializerV1.js";
import {
  AttemptSchema,
  MapperPageOutputSchema,
  type Quarantine,
} from "../ingestion/structuredEventSchemaV1.js";
import type { PreparedSession } from "../ingestion/structuredEventWorkflowV1.js";
import { bindMapperPageToHostManifest } from "./beamStructuredEventIngestionV1.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");

function parseArgs(argv: string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value?.startsWith("--")) continue;
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) output[value.slice(2)] = "true";
    else {
      output[value.slice(2)] = next;
      index += 1;
    }
  }
  return output;
}

function pathValue(value: string | undefined): string {
  if (!value) throw new Error("required path argument is missing");
  return isAbsolute(value) ? value : resolve(PROJECT_ROOT, value);
}

function summary(value: MapperMaterialization): Record<string, unknown> {
  const issueCodes = new Map<string, number>();
  for (const quarantine of value.quarantines) {
    for (const current of quarantine.issues) issueCodes.set(current.code, (issueCodes.get(current.code) ?? 0) + 1);
  }
  const countErrors = (pattern: string): number => value.completionErrors.filter((error) => error.includes(pattern)).length;
  return {
    complete: value.complete,
    counts: {
      records: value.records.length,
      mentions: value.mentions.length,
      assistantBlocks: value.assistantBlocks.length,
      assistantBlockItems: value.assistantBlockItems.length,
      coverageRows: value.coverageRows.length,
      quarantines: value.quarantines.length,
      completionErrors: value.completionErrors.length,
    },
    quarantineIssueCodes: Object.fromEntries([...issueCodes].sort()),
    quarantineRoots: value.quarantines.map((entry: Quarantine) => ({
      objectType: entry.objectType,
      localObjectKey: entry.localObjectKey,
      issueCount: entry.issues.length,
      firstIssue: entry.issues[0]?.detail ?? null,
    })),
    completionErrorCategories: {
      danglingRouteKey: countErrors("dangling routed keys"),
      routeMismatch: countErrors("does not match its materialized objects"),
      quarantineBacklog: countErrors("quarantine backlog"),
      other: value.completionErrors.filter((error) =>
        !error.includes("dangling routed keys")
        && !error.includes("does not match its materialized objects")
        && !error.includes("quarantine backlog")).length,
    },
    completionErrors: value.completionErrors,
  };
}

const args = parseArgs(process.argv.slice(2));
const inputPath = pathValue(args.input);
const outputPath = pathValue(args.out);
const retained = JSON.parse(readFileSync(inputPath, "utf8")) as Record<string, unknown>;
const session = retained.session as PreparedSession;
// Retained runs from before occurrence-bound mentions predate sourceSegmentId.
// Replay them as the explicit nullable form without mutating the artifact.
const pages = (retained.outputs as Array<Record<string, unknown>>).map((value) => {
  const migrated = MapperPageOutputSchema.parse({
    ...value,
    mentions: Array.isArray(value.mentions)
      ? value.mentions.map((mention) => {
        const draft = mention as Record<string, unknown>;
        return { ...draft, sourceSegmentId: draft.sourceSegmentId ?? null };
      })
      : value.mentions,
  });
  return bindMapperPageToHostManifest(migrated, {
    targetSessionOpaqueId: migrated.targetSessionOpaqueId,
    pageNumber: migrated.pageNumber,
    pageCount: migrated.pageCount,
    expectedSegmentIds: migrated.expectedSegmentIds,
  });
});
const attempts = (retained.attempts as unknown[]).map((value) => AttemptSchema.parse(value));
const activeAttempts = new Map<number, (typeof attempts)[number]>();
for (const attempt of attempts) activeAttempts.set(attempt.pageNumber, attempt);
const before = retained.materialized as MapperMaterialization;
const after = materializeMapperPages({
  rawTurns: session.rawTurns,
  expectedTargetOpaqueId: session.opaqueSessionId,
  targetRawTurnIds: new Set(session.rawTurns.map((turn) => turn.rawTurnId)),
  expectedSegments: session.segments,
  pages,
  attemptsByPage: activeAttempts,
});
const report = {
  schemaVersion: 1,
  mode: "offline_no_model_calls",
  inputPath,
  before: summary(before),
  after: summary(after),
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
