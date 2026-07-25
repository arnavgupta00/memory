import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import {
  RetrievalCandidatesSchema,
  type RetrievalCandidates,
} from "../retrieval/types.js";
import { ArtifactStore } from "../services/artifacts.js";
import { focusReaderTurns } from "../services/readerFocus.js";
import { enforceReaderGrounding } from "../services/readerGrounding.js";
import { recoverQuantitativeReaderPlan } from "../services/readerQuantitativeFallback.js";
import {
  ReaderPlanSchema,
  TurnSchema,
  type JsonObject,
  type TimestampedSession,
} from "../types.js";

const DatasetCaseSchema = z.looseObject({
  question_id: z.string().min(1),
  question_type: z.string().min(1),
  question: z.string(),
  question_date: z.string(),
  answer_session_ids: z.array(z.string()),
  haystack_dates: z.array(z.string()),
  haystack_session_ids: z.array(z.string()),
  haystack_sessions: z.array(z.array(TurnSchema)),
});

const SourceReportSchema = z.looseObject({
  answerable_evaluation: z.array(z.looseObject({
    questionId: z.string(),
  })),
  abstention_evaluation: z.array(z.looseObject({
    questionId: z.string(),
  })),
  metrics: z.looseObject({
    modelCallCount: z.number().int(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    retryCount: z.number().int(),
    estimated_cost_usd: z.number(),
  }),
});

const ReaderCallArtifactSchema = z.looseObject({
  validatedResponse: ReaderPlanSchema,
});

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`missing required argument: ${name}`);
  return value;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sessionsFor(
  item: z.infer<typeof DatasetCaseSchema>,
): TimestampedSession[] {
  if (
    item.haystack_sessions.length !== item.haystack_session_ids.length
    || item.haystack_sessions.length !== item.haystack_dates.length
  ) {
    throw new Error(`misaligned session arrays for ${item.question_id}`);
  }
  return item.haystack_sessions.map((turns, index) => {
    const sessionId = item.haystack_session_ids[index];
    const date = item.haystack_dates[index];
    if (!sessionId || !date) {
      throw new Error(`missing session metadata at ${item.question_id}/${String(index)}`);
    }
    return { session_id: sessionId, date, turns };
  });
}

async function sourceHash(relativePath: string): Promise<string> {
  return sha256(
    await readFile(resolve(import.meta.dirname, "..", relativePath)),
  );
}

async function main(): Promise<void> {
  const datasetPath = resolve(argument("--dataset"));
  const sourcePath = resolve(argument("--source"));
  const outputPath = resolve(argument("--output"));
  const datasetBody = await readFile(datasetPath);
  const dataset = z.array(DatasetCaseSchema).parse(
    JSON.parse(datasetBody.toString("utf8")),
  );
  const sourceReport = SourceReportSchema.parse(
    JSON.parse(await readFile(resolve(sourcePath, "gate-report.json"), "utf8")),
  );
  const cohorts = [
    ...sourceReport.answerable_evaluation.map((item) => ({
      questionId: item.questionId,
      cohort: "answerable" as const,
    })),
    ...sourceReport.abstention_evaluation.map((item) => ({
      questionId: item.questionId,
      cohort: "abstention" as const,
    })),
  ];
  const output = new ArtifactStore(outputPath);
  await output.initialize();
  const answerableEvaluation: JsonObject[] = [];
  const abstentionEvaluation: JsonObject[] = [];
  let sourceCallCount = 0;

  for (const cohort of cohorts) {
    const item = dataset.find((candidate) =>
      candidate.question_id === cohort.questionId,
    );
    if (!item) throw new Error(`source gate case missing from dataset: ${cohort.questionId}`);
    const caseSource = resolve(sourcePath, "cases", item.question_id);
    const candidates: RetrievalCandidates = RetrievalCandidatesSchema.parse(
      JSON.parse(
        await readFile(resolve(caseSource, "retrieval/candidates.json"), "utf8"),
      ),
    );
    const raw = ReaderCallArtifactSchema.parse(
      JSON.parse(
        await readFile(resolve(caseSource, "model-calls/reader-final.json"), "utf8"),
      ),
    ).validatedResponse;
    const calls = (await readFile(
      resolve(caseSource, "model-calls/calls.jsonl"),
      "utf8",
    )).trim().split("\n").filter(Boolean);
    if (calls.length !== 1) {
      throw new Error(`source reader call count is not one: ${item.question_id}`);
    }
    sourceCallCount += calls.length;
    const focusTurns = focusReaderTurns(item.question, candidates);
    const fallback = recoverQuantitativeReaderPlan({
      question: item.question,
      plan: raw,
      focusTurns,
    });
    const grounding = enforceReaderGrounding({
      question: item.question,
      plan: fallback.plan,
      sessions: sessionsFor(item),
      graph: {
        schemaVersion: 1,
        revision: 0,
        context: {},
        provenanceByPointer: {},
      },
    });
    const caseOutput = new ArtifactStore(
      resolve(outputPath, "cases", item.question_id),
    );
    await caseOutput.initialize();
    await caseOutput.writeAtomic("reader-plan.json", {
      ...grounding.plan,
      quantitativeFallback: fallback,
      grounding,
      sourceGate: sourcePath.split("/").at(-1) ?? sourcePath,
    } as unknown as JsonObject);

    if (cohort.cohort === "answerable") {
      const selected = new Set(
        grounding.plan.selectedSessions.map((session) => session.sessionId),
      );
      const selectedReferences = item.answer_session_ids.filter((sessionId) =>
        selected.has(sessionId),
      );
      answerableEvaluation.push({
        questionId: item.question_id,
        questionType: item.question_type,
        referenceSessionIds: item.answer_session_ids,
        selectedSessionIds: [...selected],
        supportSessionHit: selectedReferences.length > 0,
        evidenceRecall: selectedReferences.length / item.answer_session_ids.length,
        completeEvidence:
          selectedReferences.length === item.answer_session_ids.length,
        supportStatus: grounding.plan.supportStatus,
        quantitativeFallbackApplied: fallback.applied,
      });
    } else {
      abstentionEvaluation.push({
        questionId: item.question_id,
        questionType: item.question_type,
        supportStatus: grounding.plan.supportStatus,
        answerMode: grounding.plan.answerMode,
        correct:
          grounding.plan.supportStatus === "insufficient"
          && grounding.plan.answerMode === "abstain",
        quantitativeFallbackApplied: fallback.applied,
      });
    }
  }

  const supportSessionHits = answerableEvaluation.filter(
    (item) => item.supportSessionHit === true,
  ).length;
  const macroEvidenceRecall = answerableEvaluation.reduce(
    (total, item) =>
      total + (typeof item.evidenceRecall === "number" ? item.evidenceRecall : 0),
    0,
  ) / answerableEvaluation.length;
  const completeEvidenceCount = answerableEvaluation.filter(
    (item) => item.completeEvidence === true,
  ).length;
  const abstentionsInsufficient = abstentionEvaluation.filter(
    (item) => item.correct === true,
  ).length;
  const metrics = {
    supportSessionHits,
    answerableCount: answerableEvaluation.length,
    macroEvidenceRecall,
    completeEvidenceCount,
    abstentionsInsufficient,
    abstentionCount: abstentionEvaluation.length,
    unknownReferenceCount: 0,
    sourceModelCallCount: sourceCallCount,
    newModelCallCount: 0,
    sourceInputTokens: sourceReport.metrics.inputTokens,
    sourceOutputTokens: sourceReport.metrics.outputTokens,
    sourceRetryCount: sourceReport.metrics.retryCount,
    sourceEstimatedCostUsd: sourceReport.metrics.estimated_cost_usd,
    incrementalCostUsd: 0,
  };
  const checks = {
    supportSessionHit: supportSessionHits === 12,
    macroEvidenceRecall: macroEvidenceRecall >= 0.9,
    completeEvidence: completeEvidenceCount >= 10,
    abstentions: abstentionsInsufficient === 4,
    unknownReferences: metrics.unknownReferenceCount === 0,
    exactlyOnceSourceCalls:
      sourceCallCount === 16
      && sourceReport.metrics.modelCallCount === 16,
    noDuplicateProviderCalls: metrics.newModelCallCount === 0,
  };
  const verdict = Object.values(checks).every(Boolean) ? "passed" : "failed";
  const report: JsonObject = {
    schema_version: 1,
    gate_id: outputPath.split("/").at(-1) ?? "gate-04-reader-replay",
    architecture_id: "0003.2-hybrid-graph-reader",
    generated_at: new Date().toISOString(),
    dataset_sha256: sha256(datasetBody),
    source_paid_gate: sourcePath.split("/").at(-1) ?? sourcePath,
    paid_api_calls_in_source: true,
    new_paid_api_calls: false,
    metrics,
    checks,
    verdict,
    answerable_evaluation: answerableEvaluation,
    abstention_evaluation: abstentionEvaluation,
  };
  const manifest: JsonObject = {
    schema_version: 1,
    gate_id: report.gate_id ?? "gate-04-reader-replay",
    architecture_id: "0003.2-hybrid-graph-reader",
    dataset_sha256: sha256(datasetBody),
    source_paid_gate: report.source_paid_gate ?? "",
    source_model_calls: sourceCallCount,
    new_model_calls: 0,
    source_hashes: {
      readerFocus: await sourceHash("services/readerFocus.ts"),
      readerGrounding: await sourceHash("services/readerGrounding.ts"),
      readerQuantitativeFallback: await sourceHash(
        "services/readerQuantitativeFallback.ts",
      ),
      readerNode: await sourceHash("nodes/readMemory.ts"),
      readerPrompt: sha256(
        await readFile(resolve(import.meta.dirname, "../../prompts/reader.yaml")),
      ),
    },
  };
  await Promise.all([
    output.writeAtomic("gate-report.json", report),
    output.writeAtomic("gate-manifest.json", manifest),
  ]);
  process.stdout.write(`${JSON.stringify({ verdict, metrics, checks }, null, 2)}\n`);
  if (verdict !== "passed") process.exitCode = 1;
}

await main();
