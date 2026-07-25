import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";
import { z } from "zod";

import { RetrievalCandidatesSchema } from "../src/retrieval/types.js";
import { focusReaderTurns } from "../src/services/readerFocus.js";
import { enforceReaderGrounding } from "../src/services/readerGrounding.js";
import { sanitizeReaderPlan } from "../src/services/readerPlan.js";
import { recoverQuantitativeReaderPlan } from "../src/services/readerQuantitativeFallback.js";
import {
  MasterContextGraphSchema,
  ReaderPlanSchema,
  TimestampedSessionSchema,
} from "../src/types.js";

const projectRoot = resolve(import.meta.dirname, "../../../..");
const sourceCasesRoot = resolve(
  projectRoot,
  "runs/gate-07-blind-18-0003-2-b3c9-002/agent-artifacts/cases",
);
const paidGateRoot = resolve(
  projectRoot,
  "runs/local-archive/fix-gates/0003.2/gate-07-reader-regression-18-003",
);
const selectionPath = resolve(
  projectRoot,
  "runs/local-archive/fix-gates/0003.2/gate-07-blind-002/blind-selection.json",
);
const hasArtifacts =
  existsSync(resolve(paidGateRoot, "gate-report.json"))
  && existsSync(selectionPath);

const CallArtifactSchema = z.looseObject({
  validatedResponse: ReaderPlanSchema,
});
const SelectionSchema = z.looseObject({
  selected: z.array(z.looseObject({
    questionId: z.string().min(1),
    abstention: z.boolean(),
  })).length(18),
});
const PaidReportSchema = z.looseObject({
  cases: z.array(z.looseObject({
    question_id: z.string().min(1),
    reference_session_ids: z.array(z.string().min(1)).min(1),
  })).length(18),
});

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function readSessions(path: string) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => TimestampedSessionSchema.parse(JSON.parse(line) as unknown));
}

describe.skipIf(!hasArtifacts)("18-case paid Reader response replay", () => {
  test("current deterministic boundaries retain all answerable support and all abstentions", () => {
    const selection = SelectionSchema.parse(readJson(selectionPath));
    const report = PaidReportSchema.parse(
      readJson(resolve(paidGateRoot, "gate-report.json")),
    );
    const references = new Map(
      report.cases.map((item) => [item.question_id, item.reference_session_ids]),
    );
    let answerableHits = 0;
    let abstentionHits = 0;

    for (const selected of selection.selected) {
      const sourceRoot = resolve(sourceCasesRoot, selected.questionId);
      const paidCaseRoot = resolve(paidGateRoot, "cases", selected.questionId);
      const sessions = readSessions(resolve(sourceRoot, "sessions.jsonl"));
      const graph = MasterContextGraphSchema.parse(
        readJson(resolve(sourceRoot, "final-graph.json")),
      );
      const candidates = RetrievalCandidatesSchema.parse(
        readJson(resolve(sourceRoot, "retrieval/candidates.json")),
      );
      const raw = CallArtifactSchema.parse(
        readJson(resolve(paidCaseRoot, "model-calls/reader-final.json")),
      ).validatedResponse;
      const sanitized = sanitizeReaderPlan({
        raw,
        candidates,
        sessions,
        graph,
      });
      const fallback = recoverQuantitativeReaderPlan({
        question: candidates.question,
        plan: sanitized.plan,
        focusTurns: focusReaderTurns(candidates.question, candidates),
      });
      const grounded = enforceReaderGrounding({
        question: candidates.question,
        plan: fallback.plan,
        sessions,
        graph,
      });

      if (selected.abstention) {
        expect(grounded.plan.supportStatus, selected.questionId).toBe("insufficient");
        expect(grounded.plan.answerMode, selected.questionId).toBe("abstain");
        expect(grounded.plan.selectedSessions, selected.questionId).toEqual([]);
        abstentionHits += 1;
        continue;
      }

      expect(grounded.plan.supportStatus, selected.questionId).not.toBe("insufficient");
      const sourceIds = new Set([
        ...grounded.plan.selectedSessions.map((item) => item.sessionId),
        ...grounded.plan.evidenceFacts.flatMap((item) => item.sessionIds),
        ...grounded.plan.selectedGraphPointers.flatMap((pointer) =>
          (graph.provenanceByPointer[pointer] ?? []).map((source) => source.sessionId),
        ),
      ]);
      const expected = references.get(selected.questionId) ?? [];
      expect(
        expected.some((sessionId) => sourceIds.has(sessionId)),
        selected.questionId,
      ).toBe(true);
      answerableHits += 1;
    }

    expect(answerableHits).toBe(14);
    expect(abstentionHits).toBe(4);
  });
});
