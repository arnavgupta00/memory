import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  answer_session_ids: string[];
  haystack_session_ids: string[];
  haystack_sessions: RawTurn[][];
};

type PackageItem = {
  session_id: string;
  turn_index: number;
  tier?: "selected" | "supporting";
  why?: string;
};

type Prediction = {
  question_id: string;
  trace?: {
    context_package?: {
      item_count?: number;
      selected_count?: number;
      supporting_count?: number;
      character_count?: number;
      estimated_tokens?: number;
      candidate_status?: string;
      completeness_note?: string;
      items?: PackageItem[];
    } | null;
  };
};

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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

function itemKeys(items: PackageItem[], tier?: "selected" | "supporting"): Set<string> {
  const keys = new Set<string>();
  for (const item of items) {
    if (tier && item.tier && item.tier !== tier) continue;
    // Legacy packages without tier: treat all items as selected for selected-only metric.
    if (tier === "selected" && item.tier === "supporting") continue;
    if (tier === "supporting" && item.tier !== "supporting") continue;
    keys.add(`${item.session_id}:${String(item.turn_index)}`);
  }
  return keys;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function parseArgs(argv: string[]): { runDir: string; outName: string | null } {
  let runDir = "";
  let outName: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if ((arg === "--run" || arg === "--run-dir") && next) {
      runDir = next;
      index += 1;
      continue;
    }
    if (arg === "--out" && next) {
      outName = next;
      index += 1;
    }
  }
  if (!runDir) {
    throw new Error("usage: packageReport.ts --run <run-dir> [--out name.json]");
  }
  const resolved = runDir.startsWith("/") ? runDir : resolve(PROJECT_ROOT, runDir);
  return { runDir: resolved, outName };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dataset = JSON.parse(readFileSync(DATASET_PATH, "utf8")) as RawCase[];
  const byId = new Map(dataset.map((item) => [item.question_id, item]));
  const predictions = readFileSync(resolve(args.runDir, "predictions.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Prediction);

  let packageSufficiency = 0;
  let selectedSufficiency = 0;
  let selectedCount = 0;
  let supportingCount = 0;
  let noneFound = 0;
  const tokens: number[] = [];
  const chars: number[] = [];
  const itemCounts: number[] = [];
  const cases: Array<Record<string, unknown>> = [];

  for (const pred of predictions) {
    const raw = byId.get(pred.question_id);
    if (!raw) continue;
    const pkg = pred.trace?.context_package ?? null;
    const items = pkg?.items ?? [];
    const gold = answerTurnKeys(raw);
    const allKeys = itemKeys(items);
    const selectedKeys = itemKeys(items, "selected");
    // Legacy: no tier field → all items count as selected for selected-tier metric.
    const selectedOnlyKeys =
      items.length > 0 && items.every((item) => item.tier === undefined)
        ? allKeys
        : selectedKeys;

    const packageOk =
      gold.size === 0
        ? raw.answer_session_ids.every((sessionId) =>
            [...allKeys].some((key) => key.startsWith(`${sessionId}:`))
            || items.some((item) => item.session_id === sessionId),
          )
        : [...gold].every((key) => allKeys.has(key));
    const selectedOk =
      gold.size === 0
        ? raw.answer_session_ids.every((sessionId) =>
            [...selectedOnlyKeys].some((key) => key.startsWith(`${sessionId}:`))
            || items.some(
              (item) =>
                item.session_id === sessionId
                && (item.tier === undefined || item.tier === "selected"),
            ),
          )
        : [...gold].every((key) => selectedOnlyKeys.has(key));

    if (packageOk) packageSufficiency += 1;
    if (selectedOk) selectedSufficiency += 1;

    const selectedN =
      pkg?.selected_count
      ?? items.filter((item) => item.tier === "selected" || item.tier === undefined).length;
    const supportingN =
      pkg?.supporting_count ?? items.filter((item) => item.tier === "supporting").length;
    selectedCount += selectedN;
    supportingCount += supportingN;
    if (pkg?.candidate_status === "none_found" || items.length === 0) noneFound += 1;

    const tok = pkg?.estimated_tokens ?? 0;
    const ch = pkg?.character_count ?? 0;
    tokens.push(tok);
    chars.push(ch);
    itemCounts.push(items.length);
    cases.push({
      questionId: pred.question_id,
      questionType: raw.question_type,
      packageSufficiency: packageOk,
      selectedSufficiency: selectedOk,
      itemCount: items.length,
      selectedCount: selectedN,
      supportingCount: supportingN,
      estimatedTokens: tok,
      characterCount: ch,
      candidateStatus: pkg?.candidate_status ?? null,
    });
  }

  const n = predictions.length;
  const sortedTokens = [...tokens].sort((a, b) => a - b);
  const report = {
    schemaVersion: 1,
    architectureId: "0005-context-service",
    generatedAt: new Date().toISOString(),
    runDir: args.runDir,
    datasetPath: DATASET_PATH,
    datasetSha256: sha256File(DATASET_PATH),
    count: n,
    packageSufficiency,
    packageSufficiencyRate: n === 0 ? 0 : packageSufficiency / n,
    selectedTierSufficiency: selectedSufficiency,
    selectedTierSufficiencyRate: n === 0 ? 0 : selectedSufficiency / n,
    noneFoundCount: noneFound,
    meanSelectedItems: n === 0 ? 0 : selectedCount / n,
    meanSupportingItems: n === 0 ? 0 : supportingCount / n,
    meanItems: n === 0 ? 0 : itemCounts.reduce((a, b) => a + b, 0) / n,
    meanEstimatedTokens: n === 0 ? 0 : tokens.reduce((a, b) => a + b, 0) / n,
    meanCharacterCount: n === 0 ? 0 : chars.reduce((a, b) => a + b, 0) / n,
    tokenPercentiles: {
      p50: percentile(sortedTokens, 50),
      p90: percentile(sortedTokens, 90),
      p100: percentile(sortedTokens, 100),
    },
    cases,
  };

  const outPath = resolve(
    REPORT_ROOT,
    args.outName ?? `package-report-${args.runDir.split("/").pop() ?? "run"}.json`,
  );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        outPath,
        count: report.count,
        packageSufficiencyRate: report.packageSufficiencyRate,
        selectedTierSufficiencyRate: report.selectedTierSufficiencyRate,
        meanEstimatedTokens: report.meanEstimatedTokens,
        meanSelectedItems: report.meanSelectedItems,
        meanSupportingItems: report.meanSupportingItems,
        noneFoundCount: report.noneFoundCount,
        tokenPercentiles: report.tokenPercentiles,
      },
      null,
      2,
    ),
  );
}

main();
