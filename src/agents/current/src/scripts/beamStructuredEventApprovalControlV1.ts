import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  ApprovalExecutionBindingSchema,
  ApprovalReceiptPayloadSchema,
  SignedApprovalReceiptSchema,
  appendApprovalTransition,
} from "../ingestion/structuredEventApprovalV1.js";
import { JsonValueSchema, canonicalJson, type JsonValue } from "../ingestion/structuredEventSchemaV1.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const ApprovalRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  requestedExecution: ApprovalExecutionBindingSchema,
  requestedExecutionSha256: z.string().regex(/^[a-f0-9]{64}$/),
  approvalBrief: JsonValueSchema,
  approvalBriefSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

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

function key(): Buffer {
  const encoded = process.env.BEAM_TEST_APPROVAL_HMAC_KEY;
  if (!encoded) throw new Error("BEAM_TEST_APPROVAL_HMAC_KEY is required");
  const value = Buffer.from(encoded, "base64");
  if (value.length < 32) throw new Error("approval HMAC key must contain at least 32 bytes");
  return value;
}

function mac(payload: JsonValue, verificationKey: Buffer): string {
  return createHmac("sha256", verificationKey).update(canonicalJson(payload)).digest("hex");
}

function verifyReceiptSignature(receiptValue: unknown, verificationKey: Buffer): ReturnType<typeof SignedApprovalReceiptSchema.parse> {
  const receipt = SignedApprovalReceiptSchema.parse(receiptValue);
  const expected = Buffer.from(mac(receipt.payload as unknown as JsonValue, verificationKey), "hex");
  const actual = Buffer.from(receipt.signatureHex, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("receipt signature is invalid");
  return receipt;
}

function issue(args: Record<string, string>): void {
  const request = ApprovalRequestSchema.parse(JSON.parse(readFileSync(pathValue(args.request), "utf8")));
  if (sha256(canonicalJson(request.requestedExecution as unknown as JsonValue)) !== request.requestedExecutionSha256) {
    throw new Error("approval request binding hash is invalid");
  }
  if (sha256(canonicalJson(request.approvalBrief)) !== request.approvalBriefSha256) {
    throw new Error("approval request brief hash is invalid");
  }
  const approvalMessage = readFileSync(pathValue(args["approval-message-file"]), "utf8");
  if (approvalMessage.trim().length === 0) throw new Error("approval message must be non-empty");
  const issuedAt = new Date();
  const ttlMinutes = Number(args["ttl-minutes"] ?? 30);
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0 || ttlMinutes > 240) throw new Error("TTL must be in (0, 240] minutes");
  const payload = ApprovalReceiptPayloadSchema.parse({
    receiptVersion: 1,
    state: "approved",
    ...request.requestedExecution,
    nonce: randomBytes(32).toString("hex"),
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + ttlMinutes * 60_000).toISOString(),
    userIdentity: args["user-identity"],
    approvalMessageSha256: sha256(approvalMessage),
    approvalBriefSha256: request.approvalBriefSha256,
  });
  const receipt = SignedApprovalReceiptSchema.parse({
    algorithm: "HMAC-SHA256",
    keyId: args["key-id"] ?? "beam-test-control-v1",
    payload,
    signatureHex: mac(payload as unknown as JsonValue, key()),
  });
  const output = pathValue(args.out);
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ event: "one_run_approval_receipt_issued", output, rung: payload.rung, expiresAt: payload.expiresAt }, null, 2));
}

function decide(args: Record<string, string>, state: "user_accepted" | "user_acknowledged"): void {
  const receipt = verifyReceiptSignature(
    JSON.parse(readFileSync(pathValue(args.receipt), "utf8")),
    key(),
  );
  const confirmation = readFileSync(pathValue(args["confirmation-message-file"]), "utf8");
  if (confirmation.trim().length === 0) throw new Error("confirmation message must be non-empty");
  const resultSha256 = args["result-sha"];
  if (!resultSha256 || !/^[a-f0-9]{64}$/.test(resultSha256)) throw new Error("--result-sha must be SHA-256");
  const ledgerPath = pathValue(args.ledger);
  if (ledgerPath !== resolve(receipt.payload.outputDirectory, "approval-ledger.jsonl")) {
    throw new Error("approval decision must use the canonical ledger inside the bound output directory");
  }
  appendApprovalTransition({
    ledgerPath,
    nonce: receipt.payload.nonce,
    signatureHex: receipt.signatureHex,
    nextState: state,
    resultSha256,
  });
  const decisionPath = `${ledgerPath}.${receipt.payload.nonce}.${state}.json`;
  writeFileSync(decisionPath, `${JSON.stringify({
    schemaVersion: 1,
    nonce: receipt.payload.nonce,
    state,
    resultSha256,
    userIdentity: receipt.payload.userIdentity,
    confirmationMessageSha256: sha256(confirmation),
    at: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ event: state, decisionPath }, null, 2));
}

const args = parseArgs(process.argv.slice(2));
if (args.command === "issue") issue(args);
else if (args.command === "accept") decide(args, "user_accepted");
else if (args.command === "acknowledge") decide(args, "user_acknowledged");
else throw new Error("--command must be issue, accept, or acknowledge");
