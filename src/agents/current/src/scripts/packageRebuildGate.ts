/**
 * Offline rebuild of context packages from a prior select run's artifacts,
 * applying the current buildContextPackage logic (sibling-session expansion).
 *
 * usage: packageRebuildGate.ts --run <run-dir> [--focus qid,qid]
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildContextPackage } from "../nodes/selectContext.js";
import type { SelectedSpan } from "../retrieval/types.js";
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
  question: string;
  question_type: string;
  answer_session_ids: string[];
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: RawTurn[][];
};

type ArtifactSpan = {
  session_id: string;
  date: string;
  start_turn: number;
  end_turn: number;
  best_rank: number;
  best_score: number;
  matched_terms: string[];
  character_count: number;
};

type SelectValidated = {
  queryShape: "lookup" | "aggregate" | "order" | "update-conflict";
  setBoundary: string;
  candidateStatus: "found" | "none_found";
  missingRisk: string;
  items: Array<{ sessionId: string; turnIndex: number; why: string }>;
};

function parseArgs(argv: string[]): { runDir: string; focus: Set<string> | null } {
  let runDir = "";
  let focus: Set<string> | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if ((arg === "--run" || arg === "--run-dir") && next) {
      runDir = next;
      index += 1;
      continue;
    }
    if (arg === "--focus" && next) {
      focus = new Set(next.split(",").map((item) => item.trim()).filter(Boolean));
      index += 1;
    }
  }
  if (!runDir) {
    throw new Error("usage: packageRebuildGate.ts --run <run-dir> [--focus qid,qid]");
  }
  const resolved = runDir.startsWith("/") ? runDir : resolve(PROJECT_ROOT, runDir);
  return { runDir: resolved, focus };
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

function toSessions(raw: RawCase): TimestampedSession[] {
  return raw.haystack_session_ids.map((sessionId, index) => {
    const date = raw.haystack_dates[index];
    const turns = raw.haystack_sessions[index];
    if (!date || !turns) {
      throw new Error(`incomplete haystack for ${raw.question_id}`);
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

function loadSpans(
  retrievalPath: string,
  sessions: TimestampedSession[],
): SelectedSpan[] {
  const retrieval = JSON.parse(readFileSync(retrievalPath, "utf8")) as {
    spans: ArtifactSpan[];
  };
  const byId = new Map(sessions.map((session) => [session.session_id, session]));
  return retrieval.spans.map((span) => {
    const session = byId.get(span.session_id);
    if (!session) {
      throw new Error(`missing session ${span.session_id} for span rebuild`);
    }
    const turns = [];
    for (let turnIndex = span.start_turn; turnIndex <= span.end_turn; turnIndex += 1) {
      const turn = session.turns[turnIndex];
      if (!turn) continue;
      turns.push({
        turnIndex,
        role: turn.role,
        content: turn.content,
        truncated: false,
      });
    }
    return {
      sessionId: span.session_id,
      date: span.date,
      startTurn: span.start_turn,
      endTurn: span.end_turn,
      turns,
      bestRank: span.best_rank,
      bestScore: span.best_score,
      matchedTerms: span.matched_terms ?? [],
      characterCount: span.character_count,
    };
  });
}

function setContains(haystack: Set<string>, needles: Set<string>): boolean {
  if (needles.size === 0) {
    return true;
  }
  for (const key of needles) {
    if (!haystack.has(key)) return false;
  }
  return true;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dataset = JSON.parse(readFileSync(DATASET_PATH, "utf8")) as RawCase[];
  const byId = new Map(dataset.map((item) => [item.question_id, item]));
  const casesRoot = resolve(args.runDir, "agent-artifacts/cases");
  const caseIds = readdirSync(casesRoot).filter((name) =>
    existsSync(resolve(casesRoot, name, "model-calls/select-context.json")),
  );

  let oldPackageOk = 0;
  let newPackageOk = 0;
  let oldSelectedOk = 0;
  let newSelectedOk = 0;
  let counted = 0;
  const focusRows: Array<Record<string, unknown>> = [];
  const predictions = readFileSync(resolve(args.runDir, "predictions.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as {
      question_id: string;
      trace?: {
        context_package?: {
          items?: Array<{
            session_id: string;
            turn_index: number;
            tier?: string;
          }>;
        } | null;
      };
    });
  const predById = new Map(predictions.map((row) => [row.question_id, row]));

  for (const questionId of caseIds) {
    if (args.focus && !args.focus.has(questionId)) continue;
    const raw = byId.get(questionId);
    if (!raw) continue;
    const selectPath = resolve(casesRoot, questionId, "model-calls/select-context.json");
    const retrievalPath = resolve(casesRoot, questionId, "retrieval.json");
    const selectDoc = JSON.parse(readFileSync(selectPath, "utf8")) as {
      validatedResponse: SelectValidated;
    };
    const sessions = toSessions(raw);
    const spans = loadSpans(retrievalPath, sessions);
    const rebuilt = buildContextPackage({
      selectOutput: selectDoc.validatedResponse,
      sessions,
      spans,
      packageMaxTurns: 40,
      packageCharBudget: 40_000,
      packageSupportingEnabled: true,
      question: raw.question,
      siblingSessionsEnabled: true,
      siblingSessionMax: 12,
    });

    const gold = answerTurnKeys(raw);
    const sessionGold = gold.size === 0;
    const answerSessions = new Set(raw.answer_session_ids);
    const pred = predById.get(questionId);
    const oldItems = pred?.trace?.context_package?.items ?? [];
    const oldAll = new Set(
      oldItems.map((item) => `${item.session_id}:${String(item.turn_index)}`),
    );
    const oldSel = new Set(
      oldItems
        .filter((item) => item.tier !== "supporting")
        .map((item) => `${item.session_id}:${String(item.turn_index)}`),
    );
    const newAll = new Set(
      rebuilt.package.items.map(
        (item) => `${item.sessionId}:${String(item.turnIndex)}`,
      ),
    );
    const newSel = new Set(
      rebuilt.package.items
        .filter((item) => item.tier === "selected")
        .map((item) => `${item.sessionId}:${String(item.turnIndex)}`),
    );

    let oldPkg: boolean;
    let newPkg: boolean;
    let oldSelOk: boolean;
    let newSelOk: boolean;
    if (sessionGold) {
      const oldSess = new Set(oldItems.map((item) => item.session_id));
      const newSess = new Set(rebuilt.package.items.map((item) => item.sessionId));
      oldPkg = setContains(oldSess, answerSessions);
      newPkg = setContains(newSess, answerSessions);
      oldSelOk = setContains(
        new Set(
          oldItems
            .filter((item) => item.tier !== "supporting")
            .map((item) => item.session_id),
        ),
        answerSessions,
      );
      newSelOk = setContains(
        new Set(
          rebuilt.package.items
            .filter((item) => item.tier === "selected")
            .map((item) => item.sessionId),
        ),
        answerSessions,
      );
    } else {
      oldPkg = setContains(oldAll, gold);
      newPkg = setContains(newAll, gold);
      oldSelOk = setContains(oldSel, gold);
      newSelOk = setContains(newSel, gold);
    }

    counted += 1;
    if (oldPkg) oldPackageOk += 1;
    if (newPkg) newPackageOk += 1;
    if (oldSelOk) oldSelectedOk += 1;
    if (newSelOk) newSelectedOk += 1;

    if (args.focus || (!oldPkg && newPkg) || (oldPkg && !newPkg)) {
      focusRows.push({
        question_id: questionId,
        question_type: raw.question_type,
        query_shape: selectDoc.validatedResponse.queryShape,
        candidate_status: selectDoc.validatedResponse.candidateStatus,
        old_package_ok: oldPkg,
        new_package_ok: newPkg,
        old_selected_ok: oldSelOk,
        new_selected_ok: newSelOk,
        old_items: oldItems.length,
        new_items: rebuilt.package.items.length,
        new_selected: rebuilt.package.items.filter((item) => item.tier === "selected").length,
        new_supporting: rebuilt.package.items.filter((item) => item.tier === "supporting").length,
        new_tokens: rebuilt.package.estimatedTokens,
        gold_missing_before: [...gold].filter((key) => !oldAll.has(key)),
        gold_missing_after: [...gold].filter((key) => !newAll.has(key)),
      });
    }
  }

  const report = {
    runDir: args.runDir,
    counted,
    oldPackageSufficiency: counted ? oldPackageOk / counted : 0,
    newPackageSufficiency: counted ? newPackageOk / counted : 0,
    oldSelectedTierSufficiency: counted ? oldSelectedOk / counted : 0,
    newSelectedTierSufficiency: counted ? newSelectedOk / counted : 0,
    gainedPackage: focusRows.filter((row) => !row.old_package_ok && row.new_package_ok).length,
    lostPackage: focusRows.filter((row) => row.old_package_ok && !row.new_package_ok).length,
    rows: focusRows,
  };

  mkdirSync(REPORT_ROOT, { recursive: true });
  const outPath = resolve(
    REPORT_ROOT,
    `package-rebuild-gate-${args.runDir.split("/").pop() ?? "run"}.json`,
  );
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ outPath, ...report, rows: undefined, focusRowCount: focusRows.length }, null, 2));
  if (args.focus) {
    console.log(JSON.stringify(focusRows, null, 2));
  }
}

main();
