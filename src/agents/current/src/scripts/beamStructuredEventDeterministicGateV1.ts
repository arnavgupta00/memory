import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  ApprovalExecutionBindingSchema,
  SignedApprovalReceiptSchema,
  appendApprovalTransition,
  verifyCanonicalAcceptedPrerequisite,
  verifyAndConsumeApproval,
  writeApprovalRequest,
  type ApprovalExecutionBinding,
} from "../ingestion/structuredEventApprovalV1.js";
import { canonicalJson, type JsonValue } from "../ingestion/structuredEventSchemaV1.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const PACKAGE_ROOT = resolve(PROJECT_ROOT, "src/agents/current");
const SPEC_PATH = resolve(PACKAGE_ROOT, "architecture/BEAM-1M-STRUCTURED-EVENT-INGESTION-V1-SPEC.md");
const SCHEMA_PATH = resolve(PACKAGE_ROOT, "src/ingestion/structuredEventSchemaV1.ts");
const PROMPT_PATHS = [
  "prompts/beam-structured-event-map-v1.yaml",
  "prompts/beam-structured-event-repair-v1.yaml",
  "prompts/beam-structured-event-link-v1.yaml",
  "prompts/beam-structured-event-link-audit-v1.yaml",
  "prompts/beam-structured-event-entailment-judge-v1.yaml",
  "prompts/beam-structured-event-support-judge-v1.yaml",
].map((path) => resolve(PACKAGE_ROOT, path));
const TEST_PATHS = [
  "tests/structuredEventMaterializerV1.test.ts",
  "tests/structuredEventRoleRoutingV1.test.ts",
  "tests/structuredEventIdentityV1.test.ts",
  "tests/structuredEventLinkV1.test.ts",
  "tests/structuredEventLifecycleV1.test.ts",
  "tests/structuredEventEvaluationV1.test.ts",
  "tests/structuredEventApprovalV1.test.ts",
  "tests/structuredEventOrchestrationV1.test.ts",
].map((path) => resolve(PACKAGE_ROOT, path));
const CODE_PATHS = [
  ...TEST_PATHS,
  SCHEMA_PATH,
  resolve(PACKAGE_ROOT, "src/ingestion/structuredEventMaterializerV1.ts"),
  resolve(PACKAGE_ROOT, "src/ingestion/structuredEventWorkflowV1.ts"),
  resolve(PACKAGE_ROOT, "src/ingestion/structuredEventEvaluationV1.ts"),
  resolve(PACKAGE_ROOT, "src/ingestion/structuredEventApprovalV1.ts"),
  resolve(PACKAGE_ROOT, "src/ingestion/structuredEventCustodyV1.ts"),
  resolve(PACKAGE_ROOT, "src/compression/structuredCall.ts"),
  resolve(PACKAGE_ROOT, "src/services/promptLoader.ts"),
  resolve(PACKAGE_ROOT, "src/scripts/beamStructuredEventIngestionV1.ts"),
  resolve(PACKAGE_ROOT, "src/scripts/beamStructuredEventEvaluationV1.ts"),
  ...PROMPT_PATHS,
  fileURLToPath(import.meta.url),
];

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

function bundleHash(paths: readonly string[]): string {
  return sha256(paths.map((path) => `${path}\0${fileSha(path)}`).sort().join("\n"));
}

function acceptedL0(args: Record<string, string>): {
  resultSha256: string;
  ledgerSha256: string;
  receiptSha256: string;
} {
  const expectedResultSha = args["l0-result-hash"];
  if (!expectedResultSha || !/^[a-f0-9]{64}$/.test(expectedResultSha)) {
    throw new Error("--l0-result-hash is required");
  }
  const resultPath = pathValue(args["l0-result"]);
  const ledgerPath = pathValue(args["l0-ledger"]);
  const receiptPath = pathValue(args["l0-receipt"]);
  const encodedKey = process.env.BEAM_TEST_APPROVAL_HMAC_KEY;
  if (!encodedKey) throw new Error("BEAM_TEST_APPROVAL_HMAC_KEY is required to authenticate the L0 prerequisite");
  verifyCanonicalAcceptedPrerequisite({
    signedReceipt: JSON.parse(readFileSync(receiptPath, "utf8")),
    verificationKey: Buffer.from(encodedKey, "base64"),
    expectedKeyId: args["approval-key-id"] ?? "beam-test-control-v1",
    expectedRung: "L0",
    expectedResultSha256: expectedResultSha,
    ledgerPath,
    resultPath,
    canonicalResultFilename: "l0-conformance-report.json",
  });
  return {
    resultSha256: expectedResultSha,
    ledgerSha256: fileSha(ledgerPath),
    receiptSha256: fileSha(receiptPath),
  };
}

function binding(args: Record<string, string>): ApprovalExecutionBinding {
  const prerequisite = acceptedL0(args);
  const config = {
    rung: "L1",
    runner: "vitest",
    tests: TEST_PATHS,
    acceptedL0LedgerSha256: prerequisite.ledgerSha256,
    acceptedL0ReceiptSha256: prerequisite.receiptSha256,
  } satisfies JsonValue;
  return ApprovalExecutionBindingSchema.parse({
    rung: "L1",
    cohortHash: bundleHash(TEST_PATHS),
    prerequisiteResultHashes: [prerequisite.resultSha256],
    specificationSha256: fileSha(SPEC_PATH),
    codeSha256: bundleHash(CODE_PATHS),
    promptSha256s: PROMPT_PATHS.map(fileSha).sort(),
    schemaSha256: fileSha(SCHEMA_PATH),
    configurationSha256: sha256(canonicalJson(config)),
    models: [],
    forecastCostUsd: 0,
    hardSpendCeilingUsd: 0,
    priceTableSha256: sha256("no-paid-model-calls"),
    outputDirectory: pathValue(args.out),
  });
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function packet(args: Record<string, string>): void {
  const execution = binding(args);
  const requestOut = pathValue(args["request-out"]);
  writeApprovalRequest(requestOut, execution, {
    objective: "Run only the predeclared deterministic adversarial fixtures; no model or benchmark calls.",
    inputs: { fixtureBundleSha256: execution.cohortHash, l0ResultSha256: execution.prerequisiteResultHashes[0] ?? null },
    expectedSpendUsd: { forecast: 0, hardCeiling: 0 },
    expectedWallTime: "under two minutes",
    passFailGates: ["Every fixture passes", "No evidence is silently discarded"],
    stopConditions: ["Any failed fixture fails L1 and blocks L2"],
    retainedOutputDirectory: execution.outputDirectory,
  });
  console.log(JSON.stringify({ event: "l1_approval_request_written", requestOut, execution }, null, 2));
}

function run(args: Record<string, string>): void {
  const execution = binding(args);
  const receipt = SignedApprovalReceiptSchema.parse(JSON.parse(readFileSync(pathValue(args.receipt), "utf8")));
  const ledgerPath = pathValue(args.ledger);
  if (ledgerPath !== resolve(execution.outputDirectory, "approval-ledger.jsonl")) {
    throw new Error("approval ledger must be the canonical ledger inside the bound output directory");
  }
  const encodedKey = process.env.BEAM_TEST_APPROVAL_HMAC_KEY;
  if (!encodedKey) throw new Error("BEAM_TEST_APPROVAL_HMAC_KEY is required");
  verifyAndConsumeApproval({
    signedReceipt: receipt,
    verificationKey: Buffer.from(encodedKey, "base64"),
    expectedKeyId: args["approval-key-id"] ?? "beam-test-control-v1",
    expectedExecution: execution,
    ledgerPath,
  });
  const result = spawnSync("pnpm", ["exec", "vitest", "run", ...TEST_PATHS], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  const resultPath = resolve(execution.outputDirectory, "l1-deterministic-fixtures-result.json");
  const passed = result.status === 0;
  writeJson(resultPath, {
    schemaVersion: 1,
    rung: "L1",
    status: passed ? "passed" : "failed",
    command: ["pnpm", "exec", "vitest", "run", ...TEST_PATHS],
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  appendApprovalTransition({
    ledgerPath,
    nonce: receipt.payload.nonce,
    signatureHex: receipt.signatureHex,
    nextState: passed ? "passed" : "failed",
    resultSha256: fileSha(resultPath),
  });
  if (!passed) throw new Error("L1 deterministic fixtures failed; escalation is blocked");
  console.log(JSON.stringify({ event: "l1_passed_awaiting_user_acceptance", resultPath }, null, 2));
}

const args = parseArgs(process.argv.slice(2));
if (args.command === "packet") packet(args);
else if (args.command === "run") run(args);
else throw new Error("--command must be packet or run");
