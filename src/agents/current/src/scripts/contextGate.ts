import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_RETRIEVAL_OPTIONS,
  retrieveMemory,
  type RetrievalOptions,
  type SelectedSpan,
} from "../retrieval/index.js";
import type { TimestampedSession, Turn } from "../types.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const DATASET_PATH = resolve(PROJECT_ROOT, "data/raw/longmemeval_s_cleaned.json");
const REPORT_ROOT = resolve(PROJECT_ROOT, "runs/local-archive/backbone");

/** Mean estimated tokens from canary-2 0004.2 evidence+medium run (broad BM25 bundle). */
const BASELINE_BUNDLE_TOKENS = 16_600;

type RawTurn = {
  role: "user" | "assistant";
  content: string;
  has_answer?: boolean;
};

type RawCase = {
  question_id: string;
  question_type: string;
  question: string;
  question_date: string;
  answer_session_ids: string[];
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: RawTurn[][];
};

type CaseReport = {
  questionId: string;
  questionType: string;
  abstention: boolean;
  referenceSessionIds: string[];
  answerTurnCount: number;
  sufficiency: boolean;
  sessionComplete: boolean;
  matchedAnswerTurns: number;
  selectedSpanCount: number;
  characterCount: number;
  estimatedTokens: number;
  compactness: number;
};

type Aggregate = {
  count: number;
  sufficiency: number;
  sessionComplete: number;
  meanSpanCount: number;
  meanCharacterCount: number;
  meanEstimatedTokens: number;
  meanCompactness: number;
};

type GateReport = {
  schemaVersion: 1;
  architectureId: "0005-context-service";
  generatedAt: string;
  datasetPath: string;
  datasetSha256: string;
  mode: "bundle-baseline";
  baselineBundleTokens: number;
  options: RetrievalOptions;
  overall: Aggregate;
  byQuestionType: Record<string, Aggregate>;
  byAbstention: Record<"answerable" | "abstention", Aggregate>;
  cases: CaseReport[];
};

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isAbstention(questionId: string): boolean {
  return questionId.endsWith("_abs");
}

function toSessions(raw: RawCase): TimestampedSession[] {
  return raw.haystack_session_ids.map((sessionId, index) => {
    const date = raw.haystack_dates[index];
    const turns = raw.haystack_sessions[index];
    if (!date || !turns) {
      throw new Error(`incomplete haystack for ${raw.question_id} at index ${String(index)}`);
    }
    return {
      session_id: sessionId,
      date,
      turns: turns.map(
        (turn): Turn => ({
          role: turn.role,
          content: turn.content,
        }),
      ),
    };
  });
}

function answerTurnKeys(raw: RawCase): Set<string> {
  const keys = new Set<string>();
  for (let sessionIndex = 0; sessionIndex < raw.haystack_sessions.length; sessionIndex += 1) {
    const sessionId = raw.haystack_session_ids[sessionIndex];
    const turns = raw.haystack_sessions[sessionIndex];
    if (!sessionId || !turns) continue;
    for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
      if (turns[turnIndex]?.has_answer === true) {
        keys.add(`${sessionId}:${String(turnIndex)}`);
      }
    }
  }
  return keys;
}

function selectedTurnKeys(spans: SelectedSpan[]): Set<string> {
  const keys = new Set<string>();
  for (const span of spans) {
    for (const turn of span.turns) {
      keys.add(`${span.sessionId}:${String(turn.turnIndex)}`);
    }
  }
  return keys;
}

function summarize(items: CaseReport[]): Aggregate {
  if (items.length === 0) {
    return {
      count: 0,
      sufficiency: 0,
      sessionComplete: 0,
      meanSpanCount: 0,
      meanCharacterCount: 0,
      meanEstimatedTokens: 0,
      meanCompactness: 0,
    };
  }
  return {
    count: items.length,
    sufficiency: items.filter((item) => item.sufficiency).length,
    sessionComplete: items.filter((item) => item.sessionComplete).length,
    meanSpanCount: items.reduce((total, item) => total + item.selectedSpanCount, 0) / items.length,
    meanCharacterCount:
      items.reduce((total, item) => total + item.characterCount, 0) / items.length,
    meanEstimatedTokens:
      items.reduce((total, item) => total + item.estimatedTokens, 0) / items.length,
    meanCompactness: items.reduce((total, item) => total + item.compactness, 0) / items.length,
  };
}

function evaluateCase(raw: RawCase, options: Partial<RetrievalOptions>): CaseReport {
  const sessions = toSessions(raw);
  const result = retrieveMemory({
    question: raw.question,
    questionDate: raw.question_date,
    sessions,
    options,
  });
  const reference = new Set(raw.answer_session_ids);
  const selectedSessions = new Set(result.spans.map((span) => span.sessionId));
  const matchedReference = [...reference].filter((sessionId) => selectedSessions.has(sessionId));
  const answerTurns = answerTurnKeys(raw);
  const selectedTurns = selectedTurnKeys(result.spans);
  let matchedAnswerTurns = 0;
  for (const key of answerTurns) {
    if (selectedTurns.has(key)) matchedAnswerTurns += 1;
  }
  const sufficiency =
    answerTurns.size === 0
      ? matchedReference.length === reference.size
      : matchedAnswerTurns === answerTurns.size;
  const estimatedTokens = result.estimatedTokens;
  return {
    questionId: raw.question_id,
    questionType: raw.question_type,
    abstention: isAbstention(raw.question_id),
    referenceSessionIds: [...raw.answer_session_ids],
    answerTurnCount: answerTurns.size,
    sufficiency,
    sessionComplete: matchedReference.length === reference.size && reference.size > 0,
    matchedAnswerTurns,
    selectedSpanCount: result.spans.length,
    characterCount: result.characterCount,
    estimatedTokens,
    compactness: estimatedTokens === 0 ? 0 : BASELINE_BUNDLE_TOKENS / estimatedTokens,
  };
}

function parseArgs(argv: string[]): {
  options: Partial<RetrievalOptions>;
  limit: number | null;
  outName: string | null;
} {
  let limit: number | null = null;
  let outName: string | null = null;
  const options: Partial<RetrievalOptions> = {
    windowTurns: 2,
    windowStride: 1,
    topK: 48,
    charBudget: 80_000,
    maxTurnChars: 4_000,
    temporalBoost: 0.15,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--limit" && next) {
      limit = Number(next);
      index += 1;
      continue;
    }
    if (arg === "--out" && next) {
      outName = next;
      index += 1;
      continue;
    }
    if (arg === "--window-turns" && next) {
      options.windowTurns = Number(next);
      index += 1;
      continue;
    }
    if (arg === "--window-stride" && next) {
      options.windowStride = Number(next);
      index += 1;
      continue;
    }
    if (arg === "--top-k" && next) {
      options.topK = Number(next);
      index += 1;
      continue;
    }
    if (arg === "--char-budget" && next) {
      options.charBudget = Number(next);
      index += 1;
      continue;
    }
  }
  return { options, limit, outName };
}

function stamp(): string {
  return new Date().toISOString().replaceAll(":", "").replaceAll(".", "").replaceAll("-", "");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const datasetSha256 = sha256File(DATASET_PATH);
  const cases = JSON.parse(readFileSync(DATASET_PATH, "utf8")) as RawCase[];
  const selected = args.limit === null ? cases : cases.slice(0, args.limit);
  const options = { ...DEFAULT_RETRIEVAL_OPTIONS, ...args.options };
  const caseReports = selected.map((raw) => evaluateCase(raw, options));
  const groups = new Map<string, CaseReport[]>();
  const answerable: CaseReport[] = [];
  const abstention: CaseReport[] = [];
  for (const item of caseReports) {
    const list = groups.get(item.questionType) ?? [];
    list.push(item);
    groups.set(item.questionType, list);
    if (item.abstention) abstention.push(item);
    else answerable.push(item);
  }
  const byQuestionType: Record<string, Aggregate> = {};
  for (const [questionType, items] of [...groups.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    byQuestionType[questionType] = summarize(items);
  }
  const report: GateReport = {
    schemaVersion: 1,
    architectureId: "0005-context-service",
    generatedAt: new Date().toISOString(),
    datasetPath: DATASET_PATH,
    datasetSha256,
    mode: "bundle-baseline",
    baselineBundleTokens: BASELINE_BUNDLE_TOKENS,
    options,
    overall: summarize(caseReports),
    byQuestionType,
    byAbstention: {
      answerable: summarize(answerable),
      abstention: summarize(abstention),
    },
    cases: caseReports,
  };
  const outPath = resolve(REPORT_ROOT, args.outName ?? `context-gate-bundle-${stamp()}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        outPath,
        mode: "bundle-baseline",
        overall: {
          count: report.overall.count,
          sufficiency:
            report.overall.count === 0
              ? null
              : report.overall.sufficiency / report.overall.count,
          meanEstimatedTokens: report.overall.meanEstimatedTokens,
          meanCompactness: report.overall.meanCompactness,
        },
        byQuestionType: Object.fromEntries(
          Object.entries(report.byQuestionType).map(([name, aggregate]) => [
            name,
            {
              sufficiency:
                aggregate.count === 0 ? null : aggregate.sufficiency / aggregate.count,
              meanEstimatedTokens: aggregate.meanEstimatedTokens,
            },
          ]),
        ),
      },
      null,
      2,
    ),
  );
}

main();
