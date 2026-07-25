import { createHash } from "node:crypto";

import { describe, expect, test, vi } from "vitest";

import {
  OFFICIAL_QUESTION_TYPES,
  REQUIRED_ABSTENTION_TYPES,
  selectBlindCases,
  type BlindDatasetCase,
} from "../src/services/blindSelection.js";
import {
  summarizeGate7,
  unlockGate7Inspection,
  withUnlockedGate7Inspection,
  type Gate7CaseFunnel,
  type Gate7RunReport,
  type Gate7SealInputs,
} from "../src/services/gate7Report.js";
import { funnelStage } from "../src/services/gate6Funnel.js";

const HASH = "a".repeat(64);
const FREEZE_HASH = "b".repeat(64);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function dataset(): BlindDatasetCase[] {
  return OFFICIAL_QUESTION_TYPES.flatMap((questionType) => [
    ...Array.from({ length: 4 }, (_, index) => ({
      question_id: `${questionType}-${String(index)}`,
      question_type: questionType,
    })),
    ...(REQUIRED_ABSTENTION_TYPES.includes(
      questionType as (typeof REQUIRED_ABSTENTION_TYPES)[number],
    )
      ? [{
          question_id: `${questionType}_abs`,
          question_type: questionType,
        }]
      : []),
  ]);
}

function sealedInputs(): Gate7SealInputs {
  const selection = selectBlindCases({
    dataset: dataset(),
    datasetSha256: HASH,
    architectureId: "0003.2-hybrid-graph-reader",
    freezeManifestSha256: FREEZE_HASH,
    exposedQuestionIds: new Set(),
  });
  const selectionBody = `${JSON.stringify(selection, null, 2)}\n`;
  const ids = selection.selected.map((item) => item.questionId);
  const predictionsBody = ids.map((questionId) => JSON.stringify({
    question_id: questionId,
    question_type: selection.selected.find(
      (item) => item.questionId === questionId,
    )?.questionType,
    hypothesis: "answer",
    evidence: [],
    trace: {},
    model_calls: [],
  })).join("\n") + "\n";
  const judgmentsBody = ids.map((questionId) => JSON.stringify({
    question_id: questionId,
    hypothesis: "answer",
    autoeval_label: {
      model: "gpt-4o-2024-08-06",
      label: true,
    },
  })).join("\n") + "\n";
  return {
    selectionBody,
    selectionHashBody:
      `${sha256(selectionBody)}  blind-selection.json\n`,
    freezeManifestSha256: FREEZE_HASH,
    datasetSha256: HASH,
    runManifestBody: JSON.stringify({
      run_id: "blind-run",
      status: "completed",
      selected_count: 18,
      completed_count: 18,
      failure_count: 0,
      selected_question_ids: ids,
      dataset_hashes: { "longmemeval_s_cleaned.json": HASH },
    }),
    predictionsBody,
    judgmentsBody,
    expectedRunId: "blind-run",
  };
}

function runReport(): Gate7RunReport {
  return {
    status: "completed",
    judge_model: "gpt-4o-2024-08-06",
    completed_count: 18,
    judged_count: 18,
    failure_count: 0,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      model_call_count: 20,
      total_model_latency_ms: 200,
      by_role: {},
    },
    cost: { currency: "USD", estimated_total: 0.864 },
  };
}

function funnels(): Gate7CaseFunnel[] {
  const stage = funnelStage(["source"], ["source"]);
  return OFFICIAL_QUESTION_TYPES.flatMap((questionType) =>
    Array.from({ length: 3 }, (_, index) => ({
      questionId: `${questionType}-${String(index)}`,
      questionType,
      abstention:
        index === 0
        && REQUIRED_ABSTENTION_TYPES.includes(
          questionType as (typeof REQUIRED_ABSTENTION_TYPES)[number],
        ),
      referenceSessionIds: ["source"],
      graphCoverage: stage,
      graphOrCoverageFallback: stage,
      retrievalCoverage: stage,
      readerSelection: stage,
      answerEvidence: stage,
      answer: {
        hypothesis: "answer",
        nonEmpty: true,
        supportStatus: "supported",
        invalidReferenceCount: 0,
      },
      canonicalJudgment: {
        model: "gpt-4o-2024-08-06" as const,
        correct: true,
      },
      replayHashMatches: true,
      leakageIssues: [],
      artifactIssues: [],
      modelFailureCount: 0,
    }))
  );
}

describe("Gate 7 sealed report", () => {
  test("does not invoke inspection before all 18 canonical judgments exist", async () => {
    const inputs = sealedInputs();
    inputs.judgmentsBody = inputs.judgmentsBody
      .split("\n")
      .filter(Boolean)
      .slice(1)
      .join("\n");
    const inspect = vi.fn(() => Promise.resolve("unlocked"));
    await expect(withUnlockedGate7Inspection(inputs, inspect)).rejects.toThrow(
      "remains sealed",
    );
    expect(inspect).not.toHaveBeenCalled();
  });

  test("rejects selection tampering and duplicate or missing IDs", () => {
    const tampered = sealedInputs();
    tampered.selectionBody = tampered.selectionBody.replace(
      /"questionId": "[^"]+"/u,
      "\"questionId\": \"tampered\"",
    );
    expect(() => unlockGate7Inspection(tampered)).toThrow(
      "file hash mismatch",
    );

    const duplicate = sealedInputs();
    const lines = duplicate.predictionsBody.split("\n").filter(Boolean);
    duplicate.predictionsBody = [...lines.slice(0, 17), lines[0]].join("\n");
    expect(() => unlockGate7Inspection(duplicate)).toThrow("remains sealed");
  });

  test("passes the exact 14/18, 2/3 per type, and 3/4 abstention floor", () => {
    const cases = funnels();
    const failures = [
      cases.find((item) => item.abstention),
      cases.find((item) =>
        item.questionType === "single-session-assistant"
      ),
      cases.find((item) =>
        item.questionType === "single-session-preference"
      ),
      cases.find((item) =>
        item.questionType === "temporal-reasoning" && !item.abstention
      ),
    ];
    for (const item of failures) {
      if (item !== undefined) item.canonicalJudgment.correct = false;
    }
    const summary = summarizeGate7({
      funnels: cases,
      runReport: runReport(),
      failureCount: 0,
      duplicateCount: 0,
    });
    expect(summary.overall.correct).toBe(14);
    expect(summary.abstentions.correct).toBe(3);
    expect(summary.verdict).toBe("passed");
  });

  test("fails question-type, abstention, cost, or integrity regressions", () => {
    const cases = funnels();
    cases
      .filter((item) => item.questionType === "multi-session")
      .slice(0, 2)
      .forEach((item) => {
        item.canonicalJudgment.correct = false;
      });
    const costly = runReport();
    costly.cost.estimated_total = 0.865;
    const summary = summarizeGate7({
      funnels: cases,
      runReport: costly,
      failureCount: 1,
      duplicateCount: 1,
      globalLeakageIssueCount: 1,
      globalArtifactIssueCount: 1,
    });
    expect(summary.checks.eachQuestionType).toBe(false);
    expect(summary.checks.agentCost).toBe(false);
    expect(summary.verdict).toBe("failed");
  });
});
