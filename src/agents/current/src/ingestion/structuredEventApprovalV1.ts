import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import { JsonValueSchema, Sha256Schema, canonicalJson, type JsonValue } from "./structuredEventSchemaV1.js";

export const TestRungSchema = z.enum(["L0", "L1", "L2", "L3", "L4", "L5", "L6", "L7"]);
export type TestRung = z.infer<typeof TestRungSchema>;

export const ApprovalReceiptPayloadSchema = z.strictObject({
  receiptVersion: z.literal(1),
  state: z.literal("approved"),
  rung: TestRungSchema,
  nonce: z.string().regex(/^[a-f0-9]{32,128}$/),
  cohortHash: Sha256Schema,
  prerequisiteResultHashes: z.array(Sha256Schema),
  specificationSha256: Sha256Schema,
  codeSha256: Sha256Schema,
  promptSha256s: z.array(Sha256Schema),
  schemaSha256: Sha256Schema,
  configurationSha256: Sha256Schema,
  models: z.array(z.strictObject({
    role: z.string().min(1),
    model: z.string().min(1),
    reasoning: z.enum(["none", "low", "medium", "high"]),
    concurrency: z.number().int().positive(),
  })),
  forecastCostUsd: z.number().nonnegative(),
  hardSpendCeilingUsd: z.number().nonnegative(),
  priceTableSha256: Sha256Schema,
  outputDirectory: z.string().min(1),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  userIdentity: z.string().min(1),
  approvalMessageSha256: Sha256Schema,
  approvalBriefSha256: Sha256Schema,
});
export type ApprovalReceiptPayload = z.infer<typeof ApprovalReceiptPayloadSchema>;

export const SignedApprovalReceiptSchema = z.strictObject({
  algorithm: z.literal("HMAC-SHA256"),
  keyId: z.string().min(1),
  payload: ApprovalReceiptPayloadSchema,
  signatureHex: z.string().regex(/^[a-f0-9]{64}$/),
});
export type SignedApprovalReceipt = z.infer<typeof SignedApprovalReceiptSchema>;

export const ApprovalExecutionBindingSchema = ApprovalReceiptPayloadSchema.pick({
  rung: true,
  cohortHash: true,
  prerequisiteResultHashes: true,
  specificationSha256: true,
  codeSha256: true,
  promptSha256s: true,
  schemaSha256: true,
  configurationSha256: true,
  models: true,
  forecastCostUsd: true,
  hardSpendCeilingUsd: true,
  priceTableSha256: true,
  outputDirectory: true,
});
export type ApprovalExecutionBinding = z.infer<typeof ApprovalExecutionBindingSchema>;

export const ApprovalLedgerRowSchema = z.strictObject({
  schemaVersion: z.literal(1),
  nonce: z.string().min(1),
  rung: TestRungSchema,
  state: z.enum(["running", "passed", "failed", "user_accepted", "user_acknowledged"]),
  receiptSignatureHex: z.string().regex(/^[a-f0-9]{64}$/),
  resultSha256: Sha256Schema.nullable(),
  at: z.string().datetime(),
});
export type ApprovalLedgerRow = z.infer<typeof ApprovalLedgerRowSchema>;

function payloadJson(payload: ApprovalReceiptPayload): string {
  return canonicalJson(payload as unknown as JsonValue);
}

function expectedSignature(payload: ApprovalReceiptPayload, key: Buffer): Buffer {
  return createHmac("sha256", key).update(payloadJson(payload)).digest();
}

function verifyMac(receipt: SignedApprovalReceipt, key: Buffer): void {
  if (key.length < 32) throw new Error("approval verification key must contain at least 32 bytes");
  const expected = expectedSignature(receipt.payload, key);
  const actual = Buffer.from(receipt.signatureHex, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("approval receipt signature is invalid");
  }
}

function compareBinding(receipt: ApprovalReceiptPayload, expectedValue: ApprovalExecutionBinding): void {
  const expected = ApprovalExecutionBindingSchema.parse(expectedValue);
  const actual = ApprovalExecutionBindingSchema.parse({
    rung: receipt.rung,
    cohortHash: receipt.cohortHash,
    prerequisiteResultHashes: receipt.prerequisiteResultHashes,
    specificationSha256: receipt.specificationSha256,
    codeSha256: receipt.codeSha256,
    promptSha256s: receipt.promptSha256s,
    schemaSha256: receipt.schemaSha256,
    configurationSha256: receipt.configurationSha256,
    models: receipt.models,
    forecastCostUsd: receipt.forecastCostUsd,
    hardSpendCeilingUsd: receipt.hardSpendCeilingUsd,
    priceTableSha256: receipt.priceTableSha256,
    outputDirectory: receipt.outputDirectory,
  });
  if (canonicalJson(actual as unknown as JsonValue) !== canonicalJson(expected as unknown as JsonValue)) {
    throw new Error("approval receipt does not bind the requested execution exactly");
  }
}

function ledgerRows(path: string): ApprovalLedgerRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => ApprovalLedgerRowSchema.parse(JSON.parse(line)));
}

function appendLedgerRow(path: string, row: ApprovalLedgerRow): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: 0o600 });
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Verifies a control-plane receipt and atomically consumes its nonce before any
 * rung-scoped input is opened or any model call is dispatched.
 */
export function verifyAndConsumeApproval(args: {
  signedReceipt: unknown;
  verificationKey: Buffer;
  expectedKeyId: string;
  expectedExecution: ApprovalExecutionBinding;
  ledgerPath: string;
  now?: Date;
}): SignedApprovalReceipt {
  if (args.ledgerPath !== resolve(args.expectedExecution.outputDirectory, "approval-ledger.jsonl")) {
    throw new Error("approval nonce must be consumed in the canonical bound ledger");
  }
  const receipt = SignedApprovalReceiptSchema.parse(args.signedReceipt);
  if (receipt.keyId !== args.expectedKeyId) throw new Error("approval receipt key ID mismatch");
  verifyMac(receipt, args.verificationKey);
  compareBinding(receipt.payload, args.expectedExecution);
  const now = args.now ?? new Date();
  if (now < new Date(receipt.payload.issuedAt) || now >= new Date(receipt.payload.expiresAt)) {
    throw new Error("approval receipt is not currently valid");
  }
  const lockPath = `${args.ledgerPath}.${receipt.payload.nonce}.lock`;
  mkdirSync(dirname(args.ledgerPath), { recursive: true, mode: 0o700 });
  const lockDescriptor = openSync(lockPath, "wx", 0o600);
  try {
    const prior = ledgerRows(args.ledgerPath);
    if (prior.some((row) => row.nonce === receipt.payload.nonce)) {
      throw new Error("approval receipt nonce has already been consumed");
    }
    appendLedgerRow(args.ledgerPath, ApprovalLedgerRowSchema.parse({
      schemaVersion: 1,
      nonce: receipt.payload.nonce,
      rung: receipt.payload.rung,
      state: "running",
      receiptSignatureHex: receipt.signatureHex,
      resultSha256: null,
      at: now.toISOString(),
    }));
  } finally {
    closeSync(lockDescriptor);
    unlinkSync(lockPath);
  }
  return receipt;
}

/** Re-verifies a receipt for a second phase of the same already-running rung. */
export function verifyRunningApproval(args: {
  signedReceipt: unknown;
  verificationKey: Buffer;
  expectedKeyId: string;
  expectedExecution: ApprovalExecutionBinding;
  ledgerPath: string;
  now?: Date;
}): SignedApprovalReceipt {
  if (args.ledgerPath !== resolve(args.expectedExecution.outputDirectory, "approval-ledger.jsonl")) {
    throw new Error("running approval must be verified against the canonical bound ledger");
  }
  const receipt = SignedApprovalReceiptSchema.parse(args.signedReceipt);
  if (receipt.keyId !== args.expectedKeyId) throw new Error("approval receipt key ID mismatch");
  verifyMac(receipt, args.verificationKey);
  compareBinding(receipt.payload, args.expectedExecution);
  const now = args.now ?? new Date();
  if (now < new Date(receipt.payload.issuedAt) || now >= new Date(receipt.payload.expiresAt)) {
    throw new Error("approval receipt is not currently valid");
  }
  const prior = [...ledgerRows(args.ledgerPath)]
    .reverse()
    .find((row) => row.nonce === receipt.payload.nonce);
  if (!prior || prior.state !== "running" || prior.receiptSignatureHex !== receipt.signatureHex) {
    throw new Error("approval receipt does not own an active running rung");
  }
  return receipt;
}

const transitions: Record<ApprovalLedgerRow["state"], ApprovalLedgerRow["state"][]> = {
  running: ["passed", "failed"],
  passed: ["user_accepted"],
  failed: ["user_acknowledged"],
  user_accepted: [],
  user_acknowledged: [],
};

export function appendApprovalTransition(args: {
  ledgerPath: string;
  nonce: string;
  signatureHex: string;
  nextState: Exclude<ApprovalLedgerRow["state"], "running">;
  resultSha256: string | null;
  now?: Date;
}): ApprovalLedgerRow {
  const rows = ledgerRows(args.ledgerPath);
  const prior = [...rows].reverse().find((row) => row.nonce === args.nonce);
  if (!prior) throw new Error("approval nonce has no running ledger row");
  if (prior.receiptSignatureHex !== args.signatureHex) throw new Error("receipt signature changed");
  if (!transitions[prior.state].includes(args.nextState)) {
    throw new Error(`invalid approval transition ${prior.state} -> ${args.nextState}`);
  }
  if (
    (args.nextState === "user_accepted" || args.nextState === "user_acknowledged")
    && args.resultSha256 !== prior.resultSha256
  ) {
    throw new Error(`${args.nextState} must preserve the exact result hash from ${prior.state}`);
  }
  const row = ApprovalLedgerRowSchema.parse({
    schemaVersion: 1,
    nonce: prior.nonce,
    rung: prior.rung,
    state: args.nextState,
    receiptSignatureHex: prior.receiptSignatureHex,
    resultSha256: args.resultSha256,
    at: (args.now ?? new Date()).toISOString(),
  });
  appendLedgerRow(args.ledgerPath, row);
  return row;
}

/** Proves that an accepted prerequisite is the same immutable result that passed its rung. */
export function verifyAcceptedResultChain(args: {
  rows: readonly ApprovalLedgerRow[];
  rung: TestRung;
  resultSha256: string;
  nonce: string;
  receiptSignatureHex: string;
}): ApprovalLedgerRow {
  const rows = args.rows.map((row) => ApprovalLedgerRowSchema.parse(row));
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const accepted = rows[index];
    if (
      !accepted
      || accepted.rung !== args.rung
      || accepted.state !== "user_accepted"
      || accepted.resultSha256 !== args.resultSha256
      || accepted.nonce !== args.nonce
      || accepted.receiptSignatureHex !== args.receiptSignatureHex
    ) continue;
    const prior = rows.slice(0, index).reverse().find((row) => row.nonce === accepted.nonce);
    const running = rows.slice(0, index).find((row) =>
      row.nonce === accepted.nonce
      && row.state === "running"
      && row.receiptSignatureHex === accepted.receiptSignatureHex);
    if (
      prior?.state === "passed"
      && prior.resultSha256 === args.resultSha256
      && prior.receiptSignatureHex === accepted.receiptSignatureHex
      && running
    ) return accepted;
  }
  throw new Error(`${args.rung} result does not have a hash-continuous passed -> user_accepted ledger chain`);
}

/** Authenticates the receipt and canonical ledger before accepting a prior rung as a prerequisite. */
export function verifyAcceptedPrerequisite(args: {
  signedReceipt: unknown;
  verificationKey: Buffer;
  expectedKeyId: string;
  expectedRung: TestRung;
  expectedResultSha256: string;
  ledgerPath: string;
}): SignedApprovalReceipt {
  const receipt = SignedApprovalReceiptSchema.parse(args.signedReceipt);
  if (receipt.keyId !== args.expectedKeyId) throw new Error("prerequisite receipt key ID mismatch");
  verifyMac(receipt, args.verificationKey);
  if (receipt.payload.rung !== args.expectedRung) throw new Error("prerequisite receipt rung mismatch");
  if (args.ledgerPath !== resolve(receipt.payload.outputDirectory, "approval-ledger.jsonl")) {
    throw new Error("prerequisite approval must use its receipt-bound canonical ledger");
  }
  verifyAcceptedResultChain({
    rows: ledgerRows(args.ledgerPath),
    rung: args.expectedRung,
    resultSha256: args.expectedResultSha256,
    nonce: receipt.payload.nonce,
    receiptSignatureHex: receipt.signatureHex,
  });
  return receipt;
}

/** Adds immutable result bytes and the rung-canonical result location to prerequisite authentication. */
export function verifyCanonicalAcceptedPrerequisite(args: {
  signedReceipt: unknown;
  verificationKey: Buffer;
  expectedKeyId: string;
  expectedRung: TestRung;
  expectedResultSha256: string;
  ledgerPath: string;
  resultPath: string;
  canonicalResultFilename: string;
}): SignedApprovalReceipt {
  const actualResultSha256 = createHash("sha256").update(readFileSync(args.resultPath)).digest("hex");
  if (actualResultSha256 !== args.expectedResultSha256) {
    throw new Error("prerequisite result bytes do not match the accepted result hash");
  }
  const receipt = verifyAcceptedPrerequisite(args);
  if (args.resultPath !== resolve(receipt.payload.outputDirectory, args.canonicalResultFilename)) {
    throw new Error("prerequisite result is not the canonical receipt-bound rung result");
  }
  return receipt;
}

/** Writes a request packet only; it cannot mint or sign an approval receipt. */
export function writeApprovalRequest(
  path: string,
  bindingValue: ApprovalExecutionBinding,
  approvalBrief: JsonValue,
): void {
  const binding = ApprovalExecutionBindingSchema.parse(bindingValue);
  const brief = JsonValueSchema.parse(approvalBrief);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 1,
    requestedExecution: binding,
    requestedExecutionSha256: createHash("sha256").update(
      canonicalJson(binding as unknown as JsonValue),
    ).digest("hex"),
    approvalBrief: brief,
    approvalBriefSha256: createHash("sha256").update(canonicalJson(brief)).digest("hex"),
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
