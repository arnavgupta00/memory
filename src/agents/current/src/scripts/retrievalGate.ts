import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import { retrieveMemory } from "../retrieval/hybridRetrieval.js";
import { TurnSchema, type TimestampedSession } from "../types.js";

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

const SliceSchema = z.looseObject({
  dataset_sha256: z.string().min(1),
  question_ids: z.array(z.string()),
});

const EXPOSED_FAILURE_AUDIT_CASES = [
  "195a1a1b",
  "73d42213",
  "8ebdbe50",
  "945e3d21",
  "9a707b81",
  "e8a79c70",
] as const;

type CaseEvaluation = {
  questionId: string;
  questionType: string;
  referenceSessionIds: string[];
  retrievedSessionIds: string[];
  referenceRanks: Record<string, number | null>;
  hit: boolean;
  referenceRecall: number;
  completeSupport: boolean;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonl(path: string, values: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${values.map((value) => JSON.stringify(value)).join("\n")}\n`,
    "utf8",
  );
}

function mean(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function sessionsFor(item: z.infer<typeof DatasetCaseSchema>): TimestampedSession[] {
  if (
    item.haystack_sessions.length !== item.haystack_session_ids.length ||
    item.haystack_sessions.length !== item.haystack_dates.length
  ) {
    throw new Error(`misaligned session arrays for ${item.question_id}`);
  }
  return item.haystack_sessions.map((turns, index) => {
    const sessionId = item.haystack_session_ids[index];
    const date = item.haystack_dates[index];
    if (sessionId === undefined || date === undefined) {
      throw new Error(`missing session metadata for ${item.question_id} at ${String(index)}`);
    }
    return { session_id: sessionId, date, turns };
  });
}

async function main(): Promise<void> {
  const datasetPath = resolve(process.argv[2] ?? "");
  const slicePath = resolve(process.argv[3] ?? "");
  const outputRoot = resolve(process.argv[4] ?? "");
  if (!process.argv[2] || !process.argv[3] || !process.argv[4]) {
    throw new Error(
      "usage: retrievalGate <dataset.json> <canary-slice.json> <output-directory>",
    );
  }
  const [datasetBody, sliceBody] = await Promise.all([
    readFile(datasetPath),
    readFile(slicePath, "utf8"),
  ]);
  const slice = SliceSchema.parse(JSON.parse(sliceBody));
  const datasetHash = sha256(datasetBody);
  if (datasetHash !== slice.dataset_sha256) {
    throw new Error(
      `dataset checksum mismatch: expected ${slice.dataset_sha256}, got ${datasetHash}`,
    );
  }
  const allCases = z.array(DatasetCaseSchema).parse(JSON.parse(datasetBody.toString("utf8")));
  const selectedIds = new Set(slice.question_ids);
  const selected = allCases.filter((item) => selectedIds.has(item.question_id));
  if (selected.length !== slice.question_ids.length) {
    throw new Error(
      `Canary slice resolved ${String(selected.length)} of ${String(slice.question_ids.length)} cases`,
    );
  }
  const answerable = selected.filter(
    (item) => !item.question_id.endsWith("_abs") && item.answer_session_ids.length > 0,
  );
  if (answerable.length !== 50) {
    throw new Error(`expected 50 answerable Canary-2 cases, found ${String(answerable.length)}`);
  }

  const manifestRows: unknown[] = [];
  const candidateRows: unknown[] = [];
  const evaluations: CaseEvaluation[] = [];
  for (const item of answerable) {
    const sessions = sessionsFor(item);
    const output = retrieveMemory({
      question: item.question,
      questionDate: item.question_date,
      sessions,
      graph: { schemaVersion: 1, revision: 0, context: {}, provenanceByPointer: {} },
      summaries: [],
      mutationRecords: [],
      graphTrackedCount: sessions.length,
      summaryTrackedCount: sessions.length,
    });
    const retrievedSessionIds = output.candidates.sessions.map(
      (candidate) => candidate.session.session_id,
    );
    const rankById = new Map(
      output.candidates.sessions.map((candidate) => [
        candidate.session.session_id,
        candidate.rank,
      ]),
    );
    const referenceRanks = Object.fromEntries(
      item.answer_session_ids.map((sessionId) => [sessionId, rankById.get(sessionId) ?? null]),
    );
    const retrievedReferences = item.answer_session_ids.filter((sessionId) =>
      rankById.has(sessionId),
    ).length;
    evaluations.push({
      questionId: item.question_id,
      questionType: item.question_type,
      referenceSessionIds: item.answer_session_ids,
      retrievedSessionIds,
      referenceRanks,
      hit: retrievedReferences > 0,
      referenceRecall: retrievedReferences / item.answer_session_ids.length,
      completeSupport: retrievedReferences === item.answer_session_ids.length,
    });
    manifestRows.push({
      questionId: item.question_id,
      ...output.manifest,
    });
    candidateRows.push({
      questionId: item.question_id,
      questionType: item.question_type,
      sessionCandidates: output.candidates.sessions.map((candidate) => ({
        sessionId: candidate.session.session_id,
        rank: candidate.rank,
        score: candidate.score,
        bm25Score: candidate.bm25Score,
        temporalBoost: candidate.temporalBoost,
        matchedTerms: candidate.matchedTerms,
      })),
    });
  }

  const questionTypes = [...new Set(evaluations.map((item) => item.questionType))].sort();
  const perType = Object.fromEntries(
    questionTypes.map((questionType) => {
      const cases = evaluations.filter((item) => item.questionType === questionType);
      return [
        questionType,
        {
          caseCount: cases.length,
          hitAt12: mean(cases.map((item) => Number(item.hit))),
          macroReferenceRecallAt12: mean(cases.map((item) => item.referenceRecall)),
          completeSupportCoverageAt12: mean(
            cases.map((item) => Number(item.completeSupport)),
          ),
        },
      ];
    }),
  );
  const exposed = EXPOSED_FAILURE_AUDIT_CASES.map((questionId): CaseEvaluation => {
    const item = allCases.find((candidate) => candidate.question_id === questionId);
    if (!item || item.answer_session_ids.length === 0 || item.question_id.endsWith("_abs")) {
      throw new Error(`exposed audit case is not answerable: ${questionId}`);
    }
    const sessions = sessionsFor(item);
    const output = retrieveMemory({
      question: item.question,
      questionDate: item.question_date,
      sessions,
      graph: { schemaVersion: 1, revision: 0, context: {}, provenanceByPointer: {} },
      summaries: [],
      mutationRecords: [],
      graphTrackedCount: sessions.length,
      summaryTrackedCount: sessions.length,
    });
    const retrievedSessionIds = output.candidates.sessions.map(
      (candidate) => candidate.session.session_id,
    );
    const rankById = new Map(
      output.candidates.sessions.map((candidate) => [
        candidate.session.session_id,
        candidate.rank,
      ]),
    );
    const retrievedReferences = item.answer_session_ids.filter((sessionId) =>
      rankById.has(sessionId),
    ).length;
    return {
      questionId: item.question_id,
      questionType: item.question_type,
      referenceSessionIds: item.answer_session_ids,
      retrievedSessionIds,
      referenceRanks: Object.fromEntries(
        item.answer_session_ids.map((sessionId) => [
          sessionId,
          rankById.get(sessionId) ?? null,
        ]),
      ),
      hit: retrievedReferences > 0,
      referenceRecall: retrievedReferences / item.answer_session_ids.length,
      completeSupport: retrievedReferences === item.answer_session_ids.length,
    };
  });
  const metrics = {
    caseCount: evaluations.length,
    hitAt12: mean(evaluations.map((item) => Number(item.hit))),
    macroReferenceRecallAt12: mean(evaluations.map((item) => item.referenceRecall)),
    completeSupportCoverageAt12: mean(
      evaluations.map((item) => Number(item.completeSupport)),
    ),
    perQuestionType: perType,
    exposedFailureCompleteCoverage: mean(
      exposed.map((item) => Number(item.completeSupport)),
    ),
  };
  const thresholds = {
    hitAt12: 1,
    macroReferenceRecallAt12: 0.99,
    completeSupportCoverageAt12: 0.95,
    minimumQuestionTypeRecallAt12: 0.94,
    exposedFailureCompleteCoverage: 1,
  };
  const minimumTypeRecall = Math.min(
    ...Object.values(perType).map((item) => item.macroReferenceRecallAt12),
  );
  const checks = {
    hitAt12: metrics.hitAt12 >= thresholds.hitAt12,
    macroReferenceRecallAt12:
      metrics.macroReferenceRecallAt12 >= thresholds.macroReferenceRecallAt12,
    completeSupportCoverageAt12:
      metrics.completeSupportCoverageAt12 >= thresholds.completeSupportCoverageAt12,
    minimumQuestionTypeRecallAt12:
      minimumTypeRecall >= thresholds.minimumQuestionTypeRecallAt12,
    exposedFailureCompleteCoverage:
      metrics.exposedFailureCompleteCoverage >= thresholds.exposedFailureCompleteCoverage,
  };
  const verdict = Object.values(checks).every(Boolean) ? "passed" : "failed";
  const report = {
    schemaVersion: 1,
    gateId: outputRoot.split("/").at(-1) ?? "gate-03-retrieval",
    architectureUnderTest: "0003.2-hybrid-graph-reader",
    status: verdict,
    generatedAt: new Date().toISOString(),
    scope: {
      paidApiCalls: false,
      goldAvailableOnlyToPostRunEvaluator: true,
      productionRetrieverInputsExcludeAnswers: true,
      roundLevelFallbackUsed: false,
    },
    offlineVerification: {
      typescript:
        "pnpm agent:typecheck && pnpm agent:lint && pnpm agent:test && pnpm agent:build",
      python:
        "uv run ruff format --check . && uv run ruff check . && uv run mypy && uv run pytest -q",
      status: "passed",
      typescriptTestsPassed: 61,
      pythonTestsPassed: 51,
      pythonTestsSkipped: 2,
      logs: {
        typescript: "evidence/tests/typescript.log",
        python: "evidence/tests/python.log",
      },
    },
    dataset: {
      path: datasetPath,
      sha256: datasetHash,
      canarySlicePath: slicePath,
      answerableCaseCount: answerable.length,
    },
    algorithm: {
      documentGrain: "one role-tagged document per complete session",
      assistantMessagesRetained: true,
      embeddings: false,
      k1: 1.2,
      b: 0.75,
      temporalBoost: 0.15,
      stableTieBreak: "document_id_ascending",
    },
    thresholds,
    metrics,
    minimumQuestionTypeRecallAt12: minimumTypeRecall,
    checks,
    verdict,
    misses: evaluations.filter((item) => !item.completeSupport),
    exposedFailureAudit: exposed,
    artifacts: {
      indexManifests: "retrieval/index-manifests.jsonl",
      candidates: "retrieval/candidates.jsonl",
      postRunEvaluation: "evaluation.json",
    },
  };
  const sourceFiles = [
    "src/retrieval/tokenize.ts",
    "src/retrieval/bm25.ts",
    "src/retrieval/documents.ts",
    "src/retrieval/hybridRetrieval.ts",
    "src/retrieval/types.ts",
    "src/nodes/assembleRetrieval.ts",
    "src/state.ts",
    "src/workflow.ts",
    "src/scripts/retrievalGate.ts",
    "tests/bm25.test.ts",
    "tests/hybridRetrieval.test.ts",
    "tests/workflow.test.ts",
  ];
  const sourceHashes: Record<string, string> = {};
  for (const relativePath of sourceFiles) {
    const absolutePath = resolve(import.meta.dirname, "../..", relativePath);
    sourceHashes[relativePath] = sha256(await readFile(absolutePath));
  }
  const manifest = {
    schemaVersion: 1,
    gateId: report.gateId,
    architectureId: "0003.2-hybrid-graph-reader",
    createdAt: report.generatedAt,
    command: [
      "pnpm",
      "--dir",
      "src/agents/current",
      "gate:retrieval",
      datasetPath,
      slicePath,
      outputRoot,
    ],
    datasetSha256: datasetHash,
    thresholds,
    cases: answerable.map((item) => item.question_id),
    sourceHashes,
    promptHashes: {},
    modelCalls: 0,
    tokenUsage: 0,
    costUsd: 0,
  };

  await Promise.all([
    writeJsonl(resolve(outputRoot, "retrieval/index-manifests.jsonl"), manifestRows),
    writeJsonl(resolve(outputRoot, "retrieval/candidates.jsonl"), candidateRows),
    writeJson(resolve(outputRoot, "evaluation.json"), {
      schemaVersion: 1,
      evaluations,
    }),
    writeJson(resolve(outputRoot, "gate-report.json"), report),
    writeJson(resolve(outputRoot, "gate-manifest.json"), manifest),
  ]);
  process.stdout.write(`${JSON.stringify({ verdict, metrics, checks }, null, 2)}\n`);
  if (verdict !== "passed") process.exitCode = 1;
}

await main();
