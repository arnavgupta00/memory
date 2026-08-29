import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash, createHmac as hmac } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  appendApprovalTransition,
  ApprovalLedgerRowSchema,
  verifyAcceptedPrerequisite,
  verifyAcceptedResultChain,
  verifyCanonicalAcceptedPrerequisite,
  verifyAndConsumeApproval,
  verifyRunningApproval,
  type ApprovalExecutionBinding,
  type SignedApprovalReceipt,
} from "../src/ingestion/structuredEventApprovalV1.js";
import { canonicalJson, type JsonValue } from "../src/ingestion/structuredEventSchemaV1.js";

const directories: string[] = [];
const key = Buffer.alloc(32, 9);

function binding(outputDirectory = "/tmp/fixture-output"): ApprovalExecutionBinding {
  return {
    rung: "L1",
    cohortHash: "a".repeat(64),
    prerequisiteResultHashes: ["b".repeat(64)],
    specificationSha256: "c".repeat(64),
    codeSha256: "d".repeat(64),
    promptSha256s: [],
    schemaSha256: "e".repeat(64),
    configurationSha256: "f".repeat(64),
    models: [],
    forecastCostUsd: 0,
    hardSpendCeilingUsd: 0,
    priceTableSha256: "1".repeat(64),
    outputDirectory,
  };
}

function receipt(execution = binding()): SignedApprovalReceipt {
  const payload = {
    receiptVersion: 1 as const,
    state: "approved" as const,
    ...execution,
    nonce: "2".repeat(64),
    issuedAt: "2026-08-10T00:00:00.000Z",
    expiresAt: "2026-08-10T01:00:00.000Z",
    userIdentity: "fixture-user",
    approvalMessageSha256: "3".repeat(64),
    approvalBriefSha256: "4".repeat(64),
  };
  return {
    algorithm: "HMAC-SHA256",
    keyId: "beam-test-control-v1",
    payload,
    signatureHex: hmac("sha256", key).update(canonicalJson(payload as unknown as JsonValue)).digest("hex"),
  };
}

function ledger(): { path: string; execution: ApprovalExecutionBinding } {
  const directory = mkdtempSync(resolve(tmpdir(), "beam-approval-"));
  directories.push(directory);
  return { path: resolve(directory, "approval-ledger.jsonl"), execution: binding(directory) };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("authenticated one-run test receipts", () => {
  it("consumes a valid nonce once and permits only the same running receipt", () => {
    const { path, execution } = ledger();
    const signed = receipt(execution);
    verifyAndConsumeApproval({
      signedReceipt: signed, verificationKey: key, expectedKeyId: signed.keyId,
      expectedExecution: execution, ledgerPath: path, now: new Date("2026-08-10T00:30:00.000Z"),
    });
    expect(() => verifyAndConsumeApproval({
      signedReceipt: signed, verificationKey: key, expectedKeyId: signed.keyId,
      expectedExecution: execution, ledgerPath: path, now: new Date("2026-08-10T00:31:00.000Z"),
    })).toThrow(/consumed/);
    expect(verifyRunningApproval({
      signedReceipt: signed, verificationKey: key, expectedKeyId: signed.keyId,
      expectedExecution: execution, ledgerPath: path, now: new Date("2026-08-10T00:32:00.000Z"),
    }).payload.nonce).toBe(signed.payload.nonce);
  });

  it("rejects local mutation and prerequisite mismatch", () => {
    const { path, execution } = ledger();
    const signed = receipt(execution);
    expect(() => verifyAndConsumeApproval({
      signedReceipt: { ...signed, payload: { ...signed.payload, hardSpendCeilingUsd: 1 } },
      verificationKey: key, expectedKeyId: signed.keyId, expectedExecution: execution, ledgerPath: path,
      now: new Date("2026-08-10T00:30:00.000Z"),
    })).toThrow(/signature/);
    expect(() => verifyAndConsumeApproval({
      signedReceipt: signed, verificationKey: key, expectedKeyId: signed.keyId,
      expectedExecution: { ...execution, prerequisiteResultHashes: [] }, ledgerPath: path,
      now: new Date("2026-08-10T00:30:00.000Z"),
    })).toThrow(/bind/);
    expect(() => verifyAndConsumeApproval({
      signedReceipt: signed, verificationKey: key, expectedKeyId: signed.keyId,
      expectedExecution: execution, ledgerPath: resolve(execution.outputDirectory, "alternate-ledger.jsonl"),
      now: new Date("2026-08-10T00:30:00.000Z"),
    })).toThrow(/canonical bound ledger/);
  });

  it("makes failure terminal for advancement but allows acknowledgment", () => {
    const { path, execution } = ledger();
    const signed = receipt(execution);
    verifyAndConsumeApproval({
      signedReceipt: signed, verificationKey: key, expectedKeyId: signed.keyId,
      expectedExecution: execution, ledgerPath: path, now: new Date("2026-08-10T00:30:00.000Z"),
    });
    appendApprovalTransition({
      ledgerPath: path, nonce: signed.payload.nonce, signatureHex: signed.signatureHex,
      nextState: "failed", resultSha256: "4".repeat(64),
    });
    expect(() => appendApprovalTransition({
      ledgerPath: path, nonce: signed.payload.nonce, signatureHex: signed.signatureHex,
      nextState: "passed", resultSha256: "4".repeat(64),
    })).toThrow(/invalid approval transition/);
    expect(appendApprovalTransition({
      ledgerPath: path, nonce: signed.payload.nonce, signatureHex: signed.signatureHex,
      nextState: "user_acknowledged", resultSha256: "4".repeat(64),
    }).state).toBe("user_acknowledged");
  });

  it("cannot accept a different result hash than the result that passed", () => {
    const { path, execution } = ledger();
    const signed = receipt(execution);
    verifyAndConsumeApproval({
      signedReceipt: signed, verificationKey: key, expectedKeyId: signed.keyId,
      expectedExecution: execution, ledgerPath: path, now: new Date("2026-08-10T00:30:00.000Z"),
    });
    appendApprovalTransition({
      ledgerPath: path, nonce: signed.payload.nonce, signatureHex: signed.signatureHex,
      nextState: "passed", resultSha256: "5".repeat(64),
    });
    expect(() => appendApprovalTransition({
      ledgerPath: path, nonce: signed.payload.nonce, signatureHex: signed.signatureHex,
      nextState: "user_accepted", resultSha256: "6".repeat(64),
    })).toThrow(/preserve the exact result hash/);
  });

  it("authenticates the receipt and canonical ledger before accepting an L0 prerequisite", () => {
    const { path, execution: base } = ledger();
    const execution = { ...base, rung: "L0" as const, prerequisiteResultHashes: [] };
    const signed = receipt(execution);
    const resultPath = resolve(execution.outputDirectory, "l0-conformance-report.json");
    const resultBytes = "fixture L0 result\n";
    writeFileSync(resultPath, resultBytes);
    const resultSha256 = createHash("sha256").update(resultBytes).digest("hex");
    verifyAndConsumeApproval({
      signedReceipt: signed, verificationKey: key, expectedKeyId: signed.keyId,
      expectedExecution: execution, ledgerPath: path, now: new Date("2026-08-10T00:30:00.000Z"),
    });
    appendApprovalTransition({
      ledgerPath: path, nonce: signed.payload.nonce, signatureHex: signed.signatureHex,
      nextState: "passed", resultSha256,
    });
    appendApprovalTransition({
      ledgerPath: path, nonce: signed.payload.nonce, signatureHex: signed.signatureHex,
      nextState: "user_accepted", resultSha256,
    });
    const rows = readFileSync(path, "utf8").split("\n").filter(Boolean)
      .map((line) => ApprovalLedgerRowSchema.parse(JSON.parse(line)));
    expect(verifyAcceptedResultChain({
      rows, rung: "L0", resultSha256, nonce: signed.payload.nonce, receiptSignatureHex: signed.signatureHex,
    }).state).toBe("user_accepted");
    expect(verifyAcceptedPrerequisite({
      signedReceipt: signed,
      verificationKey: key,
      expectedKeyId: signed.keyId,
      expectedRung: "L0",
      expectedResultSha256: resultSha256,
      ledgerPath: path,
    }).payload.nonce).toBe(signed.payload.nonce);
    expect(verifyCanonicalAcceptedPrerequisite({
      signedReceipt: signed,
      verificationKey: key,
      expectedKeyId: signed.keyId,
      expectedRung: "L0",
      expectedResultSha256: resultSha256,
      ledgerPath: path,
      resultPath,
      canonicalResultFilename: "l0-conformance-report.json",
    }).payload.nonce).toBe(signed.payload.nonce);
    expect(() => verifyAcceptedPrerequisite({
      signedReceipt: { ...signed, signatureHex: "8".repeat(64) },
      verificationKey: key,
      expectedKeyId: signed.keyId,
      expectedRung: "L0",
      expectedResultSha256: resultSha256,
      ledgerPath: path,
    })).toThrow(/signature/);
  });
});
