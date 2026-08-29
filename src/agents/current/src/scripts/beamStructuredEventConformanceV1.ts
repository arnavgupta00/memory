import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ApprovalExecutionBindingSchema,
  SignedApprovalReceiptSchema,
  appendApprovalTransition,
  verifyAndConsumeApproval,
  writeApprovalRequest,
  type ApprovalExecutionBinding,
} from "../ingestion/structuredEventApprovalV1.js";
import { canonicalJson, type JsonValue } from "../ingestion/structuredEventSchemaV1.js";
import {
  STRUCTURED_EVENT_REQUIREMENT_IDS_V1,
  STRUCTURED_EVENT_TRACEABILITY_V1,
} from "../ingestion/structuredEventTraceabilityV1.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const SPEC_PATH = resolve(PROJECT_ROOT, "src/agents/current/architecture/BEAM-1M-STRUCTURED-EVENT-INGESTION-V1-SPEC.md");
const SCHEMA_PATH = resolve(PROJECT_ROOT, "src/agents/current/src/ingestion/structuredEventSchemaV1.ts");
const TRACEABILITY_PATH = resolve(PROJECT_ROOT, "src/agents/current/src/ingestion/structuredEventTraceabilityV1.ts");
const PRODUCTION_PATHS = [
  SCHEMA_PATH,
  resolve(PROJECT_ROOT, "src/agents/current/src/ingestion/structuredEventMaterializerV1.ts"),
  resolve(PROJECT_ROOT, "src/agents/current/src/ingestion/structuredEventWorkflowV1.ts"),
  resolve(PROJECT_ROOT, "src/agents/current/src/ingestion/structuredEventEvaluationV1.ts"),
  resolve(PROJECT_ROOT, "src/agents/current/src/ingestion/structuredEventApprovalV1.ts"),
  resolve(PROJECT_ROOT, "src/agents/current/src/ingestion/structuredEventCustodyV1.ts"),
  resolve(PROJECT_ROOT, "src/agents/current/src/compression/structuredCall.ts"),
  resolve(PROJECT_ROOT, "src/agents/current/src/scripts/beamStructuredEventIngestionV1.ts"),
  resolve(PROJECT_ROOT, "src/agents/current/src/scripts/beamStructuredEventEvaluationV1.ts"),
  fileURLToPath(import.meta.url),
];
const TRACE_TEST_PATHS = [...new Set(STRUCTURED_EVENT_TRACEABILITY_V1
  .flatMap((group) => group.automatedTestFiles)
  .map((path) => resolve(PROJECT_ROOT, path)))];

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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fileSha(path: string): string {
  return sha256(readFileSync(path));
}

function implementationSha(): string {
  return sha256([...PRODUCTION_PATHS, TRACEABILITY_PATH, ...TRACE_TEST_PATHS]
    .map((path) => `${path}\0${fileSha(path)}`)
    .sort()
    .join("\n"));
}

function expectedBinding(args: Record<string, string>): ApprovalExecutionBinding {
  const configuration = {
    runner: "beamStructuredEventConformanceV1",
    rung: "L0",
    requirementIds: [...STRUCTURED_EVENT_REQUIREMENT_IDS_V1].sort(),
    paidModelCalls: 0,
  } satisfies JsonValue;
  const cohortHash = sha256(canonicalJson({
    specificationSha256: fileSha(SPEC_PATH),
    traceabilitySha256: fileSha(TRACEABILITY_PATH),
  }));
  return ApprovalExecutionBindingSchema.parse({
    rung: "L0",
    cohortHash,
    prerequisiteResultHashes: [],
    specificationSha256: fileSha(SPEC_PATH),
    codeSha256: implementationSha(),
    promptSha256s: [],
    schemaSha256: fileSha(SCHEMA_PATH),
    configurationSha256: sha256(canonicalJson(configuration)),
    models: [],
    forecastCostUsd: 0,
    hardSpendCeilingUsd: 0,
    priceTableSha256: sha256("no-paid-model-calls"),
    outputDirectory: pathValue(args.out),
  });
}

function escapedRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsDeclaration(paths: readonly string[], symbol: string): string | null {
  const declaration = new RegExp(
    `\\b(?:export\\s+)?(?:async\\s+)?(?:const|function|class|type|interface)\\s+${escapedRegex(symbol)}\\b`,
  );
  for (const path of paths) {
    if (existsSync(path) && declaration.test(readFileSync(path, "utf8"))) return path;
  }
  return null;
}

function containsLiteral(paths: readonly string[], value: string): string | null {
  for (const path of paths) {
    if (existsSync(path) && readFileSync(path, "utf8").includes(value)) return path;
  }
  return null;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function packet(args: Record<string, string>): Promise<void> {
  const binding = expectedBinding(args);
  const requestOut = pathValue(args["request-out"]);
  writeApprovalRequest(requestOut, binding, {
    objective: "Statically map every approved non-negotiable requirement to schema, production code, an automated test, and a runtime artifact contract.",
    inputs: { specificationSha256: binding.specificationSha256, codeSha256: binding.codeSha256 },
    expectedSpendUsd: { forecast: 0, hardCeiling: 0 },
    expectedWallTime: "under one minute",
    passFailGates: ["All requirement IDs mapped exactly once", "Zero blank or missing mappings"],
    stopConditions: ["Any missing mapping fails L0 and blocks L1"],
    retainedOutputDirectory: binding.outputDirectory,
  });
  console.log(JSON.stringify({ event: "l0_approval_request_written", requestOut, binding }, null, 2));
}

async function run(args: Record<string, string>): Promise<void> {
  const binding = expectedBinding(args);
  const receiptPath = pathValue(args.receipt);
  const ledgerPath = pathValue(args.ledger);
  if (ledgerPath !== resolve(binding.outputDirectory, "approval-ledger.jsonl")) {
    throw new Error("approval ledger must be the canonical ledger inside the bound output directory");
  }
  const verificationKey = process.env.BEAM_TEST_APPROVAL_HMAC_KEY;
  if (!verificationKey) throw new Error("BEAM_TEST_APPROVAL_HMAC_KEY is required");
  const receipt = SignedApprovalReceiptSchema.parse(JSON.parse(readFileSync(receiptPath, "utf8")));
  verifyAndConsumeApproval({
    signedReceipt: receipt,
    verificationKey: Buffer.from(verificationKey, "base64"),
    expectedKeyId: args["approval-key-id"] ?? "beam-test-control-v1",
    expectedExecution: binding,
    ledgerPath,
  });

  const expectedIds = new Set(STRUCTURED_EVENT_REQUIREMENT_IDS_V1);
  const seenIds = new Set<string>();
  const rows = STRUCTURED_EVENT_TRACEABILITY_V1.flatMap((group) => group.requirementIds.map((requirementId) => {
    seenIds.add(requirementId);
    // Schema contracts intentionally live beside their owning subsystem
    // (core representation, evaluation, approval, and custody). Search the
    // complete bound production set rather than assuming one central file.
    const schema = group.schemaSymbols.map((symbol) => ({ symbol, path: containsDeclaration(PRODUCTION_PATHS, symbol) }));
    const production = group.productionSymbols.map((symbol) => ({ symbol, path: containsDeclaration(PRODUCTION_PATHS, symbol) }));
    const tests = group.fixtureMarkers.map(({ path, marker }) => {
      const absolutePath = resolve(PROJECT_ROOT, path);
      const exists = existsSync(absolutePath);
      const hasRequiredFixture = exists && readFileSync(absolutePath, "utf8").includes(marker);
      return { path, marker, exists, hasRequiredFixture };
    });
    const runtime = group.runtimeArtifacts.map((artifact) => ({
      artifact,
      producerPath: containsLiteral(PRODUCTION_PATHS, artifact),
      retainedAtL0: false,
    }));
    const missing = [
      ...schema.filter((entry) => entry.path === null).map((entry) => `schema:${entry.symbol}`),
      ...production.filter((entry) => entry.path === null).map((entry) => `production:${entry.symbol}`),
      ...tests.filter((entry) => !entry.exists || !entry.hasRequiredFixture)
        .map((entry) => `test:${entry.path}#${entry.marker}`),
      ...runtime.filter((entry) => entry.producerPath === null).map((entry) => `runtime-producer:${entry.artifact}`),
    ];
    return { requirementId, schema, production, tests, runtime, missing, verdict: missing.length === 0 ? "mapped" : "missing" };
  }));
  const duplicateIds = [...seenIds].filter((id) => rows.filter((row) => row.requirementId === id).length !== 1);
  const absentIds = [...expectedIds].filter((id) => !seenIds.has(id));
  const unknownIds = [...seenIds].filter((id) => !expectedIds.has(id));
  const missingRows = rows.filter((row) => row.verdict !== "mapped");
  const passed = duplicateIds.length === 0 && absentIds.length === 0 && unknownIds.length === 0 && missingRows.length === 0;
  const reportPath = resolve(binding.outputDirectory, "l0-conformance-report.json");
  writeJson(reportPath, {
    schemaVersion: 1,
    rung: "L0",
    passed,
    evidenceScope: "independent requirement catalog, group-specific fixture marker, static declaration, and runtime-producer contract only",
    behaviorVerified: false,
    behavioralAdvancementRequires: "L1 deterministic adversarial fixtures plus user acceptance",
    exactCounts: {
      mappedRequirements: rows.length - missingRows.length,
      requiredRequirements: expectedIds.size,
      missingRequirements: missingRows.length,
    },
    duplicateIds,
    absentIds,
    unknownIds,
    rows,
  });
  appendApprovalTransition({
    ledgerPath,
    nonce: receipt.payload.nonce,
    signatureHex: receipt.signatureHex,
    nextState: passed ? "passed" : "failed",
    resultSha256: fileSha(reportPath),
  });
  if (!passed) throw new Error("L0 conformance failed; escalation is blocked");
  console.log(JSON.stringify({ event: "l0_conformance_passed_awaiting_user_acceptance", reportPath }, null, 2));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "packet") await packet(args);
  else if (args.command === "run") await run(args);
  else throw new Error("--command must be packet or run");
}

await main();
