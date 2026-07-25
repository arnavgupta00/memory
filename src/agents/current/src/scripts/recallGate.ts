import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

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
  sessionHit: boolean;
  sessionComplete: boolean;
  matchedReferenceSessionIds: string[];
  answerTurnHit: boolean;
  answerTurnComplete: boolean;
  matchedAnswerTurns: number;
  firstReferenceWindowRank: number | null;
  selectedSessionIds: string[];
  selectedSpanCount: number;
  characterCount: number;
  estimatedTokens: number;
  windowCount: number;
  rankedCount: number;
};

type Aggregate = {
  count: number;
  sessionHit: number;
  sessionComplete: number;
  answerTurnHit: number;
  answerTurnComplete: number;
  meanCharacterCount: number;
  meanEstimatedTokens: number;
  meanFirstReferenceRank: number | null;
};

type SweepCell = {
  options: RetrievalOptions;
  overall: Aggregate;
  byQuestionType: Record<string, Aggregate>;
};

type GateReport = {
  schemaVersion: 1;
  architectureId: "0004-session-retrieval-backbone";
  generatedAt: string;
  datasetPath: string;
  datasetSha256: string;
  mode: "single" | "sweep";
  options: RetrievalOptions;
  overall: Aggregate;
  byQuestionType: Record<string, Aggregate>;
  byAbstention: Record<"answerable" | "abstention", Aggregate>;
  cases: CaseReport[];
  sweep?: SweepCell[];
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

function emptyAggregate(): Aggregate {
  return {
    count: 0,
    sessionHit: 0,
    sessionComplete: 0,
    answerTurnHit: 0,
    answerTurnComplete: 0,
    meanCharacterCount: 0,
    meanEstimatedTokens: 0,
    meanFirstReferenceRank: null,
  };
}

function finalizeAggregate(
  reports: CaseReport[],
  ranks: number[],
  characterTotal: number,
  tokenTotal: number,
): Aggregate {
  return {
    count: reports.length,
    sessionHit: reports.filter((item) => item.sessionHit).length,
    sessionComplete: reports.filter((item) => item.sessionComplete).length,
    answerTurnHit: reports.filter((item) => item.answerTurnHit).length,
    answerTurnComplete: reports.filter((item) => item.answerTurnComplete).length,
    meanCharacterCount: reports.length === 0 ? 0 : characterTotal / reports.length,
    meanEstimatedTokens: reports.length === 0 ? 0 : tokenTotal / reports.length,
    meanFirstReferenceRank:
      ranks.length === 0 ? null : ranks.reduce((total, value) => total + value, 0) / ranks.length,
  };
}

function aggregateCases(cases: CaseReport[]): {
  overall: Aggregate;
  byQuestionType: Record<string, Aggregate>;
  byAbstention: Record<"answerable" | "abstention", Aggregate>;
} {
  const groups = new Map<string, CaseReport[]>();
  const answerable: CaseReport[] = [];
  const abstention: CaseReport[] = [];
  for (const item of cases) {
    const list = groups.get(item.questionType) ?? [];
    list.push(item);
    groups.set(item.questionType, list);
    if (item.abstention) abstention.push(item);
    else answerable.push(item);
  }

  const summarize = (items: CaseReport[]): Aggregate => {
    const ranks = items
      .map((item) => item.firstReferenceWindowRank)
      .filter((value): value is number => value !== null);
    return finalizeAggregate(
      items,
      ranks,
      items.reduce((total, item) => total + item.characterCount, 0),
      items.reduce((total, item) => total + item.estimatedTokens, 0),
    );
  };

  const byQuestionType: Record<string, Aggregate> = {};
  for (const [questionType, items] of [...groups.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    byQuestionType[questionType] = summarize(items);
  }

  return {
    overall: summarize(cases),
    byQuestionType,
    byAbstention: {
      answerable: summarize(answerable),
      abstention: summarize(abstention),
    },
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
  const matchedReferenceSessionIds = [...reference]
    .filter((sessionId) => selectedSessions.has(sessionId))
    .sort((left, right) => left.localeCompare(right));
  const answerTurns = answerTurnKeys(raw);
  const selectedTurns = selectedTurnKeys(result.spans);
  let matchedAnswerTurns = 0;
  for (const key of answerTurns) {
    if (selectedTurns.has(key)) matchedAnswerTurns += 1;
  }
  const firstReferenceWindowRank =
    result.ranked.find((item) => {
      const window = result.windows.find((candidate) => candidate.document.id === item.documentId);
      return window !== undefined && reference.has(window.document.sessionId);
    })?.rank ?? null;

  return {
    questionId: raw.question_id,
    questionType: raw.question_type,
    abstention: isAbstention(raw.question_id),
    referenceSessionIds: [...raw.answer_session_ids],
    answerTurnCount: answerTurns.size,
    sessionHit: matchedReferenceSessionIds.length > 0,
    sessionComplete: matchedReferenceSessionIds.length === reference.size && reference.size > 0,
    matchedReferenceSessionIds,
    answerTurnHit: matchedAnswerTurns > 0,
    answerTurnComplete: answerTurns.size > 0 && matchedAnswerTurns === answerTurns.size,
    matchedAnswerTurns,
    firstReferenceWindowRank,
    selectedSessionIds: [...selectedSessions].sort((left, right) => left.localeCompare(right)),
    selectedSpanCount: result.spans.length,
    characterCount: result.characterCount,
    estimatedTokens: result.estimatedTokens,
    windowCount: result.windows.length,
    rankedCount: result.ranked.length,
  };
}

function parseArgs(argv: string[]): {
  mode: "single" | "sweep";
  options: Partial<RetrievalOptions>;
  limit: number | null;
  outName: string | null;
} {
  let mode: "single" | "sweep" = "single";
  let limit: number | null = null;
  let outName: string | null = null;
  const options: Partial<RetrievalOptions> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--sweep") {
      mode = "sweep";
      continue;
    }
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
    if (arg === "--max-turn-chars" && next) {
      options.maxTurnChars = Number(next);
      index += 1;
      continue;
    }
  }
  return { mode, options, limit, outName };
}

function sweepGrid(): RetrievalOptions[] {
  const windowPairs: Array<[number, number]> = [
    [2, 1],
    [4, 2],
    [6, 3],
    [8, 4],
  ];
  const topKs = [12, 24, 48];
  const budgets = [20_000, 40_000, 80_000];
  const cells: RetrievalOptions[] = [];
  for (const [windowTurns, windowStride] of windowPairs) {
    for (const topK of topKs) {
      for (const charBudget of budgets) {
        cells.push({
          ...DEFAULT_RETRIEVAL_OPTIONS,
          windowTurns,
          windowStride,
          topK,
          charBudget,
        });
      }
    }
  }
  return cells;
}

function stamp(): string {
  return new Date().toISOString().replaceAll(":", "").replaceAll(".", "").replaceAll("-", "");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const datasetSha256 = sha256File(DATASET_PATH);
  const cases = JSON.parse(readFileSync(DATASET_PATH, "utf8")) as RawCase[];
  const selected = args.limit === null ? cases : cases.slice(0, args.limit);
  const generatedAt = new Date().toISOString();

  if (args.mode === "single") {
    const options = { ...DEFAULT_RETRIEVAL_OPTIONS, ...args.options };
    const caseReports = selected.map((raw) => evaluateCase(raw, options));
    const aggregates = aggregateCases(caseReports);
    const report: GateReport = {
      schemaVersion: 1,
      architectureId: "0004-session-retrieval-backbone",
      generatedAt,
      datasetPath: DATASET_PATH,
      datasetSha256,
      mode: "single",
      options,
      ...aggregates,
      cases: caseReports,
    };
    const outPath = resolve(
      REPORT_ROOT,
      args.outName ?? `recall-gate-${stamp()}.json`,
    );
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(
      JSON.stringify(
        {
          outPath,
          mode: "single",
          overall: report.overall,
          byQuestionType: report.byQuestionType,
        },
        null,
        2,
      ),
    );
    return;
  }

  const cells = sweepGrid();
  const sweep: SweepCell[] = [];
  let best = emptyAggregate();
  let bestOptions = DEFAULT_RETRIEVAL_OPTIONS;
  for (const options of cells) {
    const caseReports = selected.map((raw) => evaluateCase(raw, options));
    const aggregates = aggregateCases(caseReports);
    sweep.push({
      options,
      overall: aggregates.overall,
      byQuestionType: aggregates.byQuestionType,
    });
    const score =
      aggregates.overall.answerTurnComplete +
      aggregates.overall.answerTurnHit * 0.01 -
      aggregates.overall.meanEstimatedTokens * 1e-9;
    const bestScore =
      best.answerTurnComplete + best.answerTurnHit * 0.01 - best.meanEstimatedTokens * 1e-9;
    if (score > bestScore) {
      best = aggregates.overall;
      bestOptions = options;
    }
  }

  const bestCaseReports = selected.map((raw) => evaluateCase(raw, bestOptions));
  const bestAggregates = aggregateCases(bestCaseReports);
  const report: GateReport = {
    schemaVersion: 1,
    architectureId: "0004-session-retrieval-backbone",
    generatedAt,
    datasetPath: DATASET_PATH,
    datasetSha256,
    mode: "sweep",
    options: bestOptions,
    ...bestAggregates,
    cases: bestCaseReports,
    sweep,
  };
  const outPath = resolve(
    REPORT_ROOT,
    args.outName ?? `recall-sweep-${stamp()}.json`,
  );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        outPath,
        mode: "sweep",
        bestOptions,
        overall: report.overall,
        byQuestionType: report.byQuestionType,
        cells: sweep.length,
      },
      null,
      2,
    ),
  );
}

main();
