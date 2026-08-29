import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const EVAL_ROOT = resolve(PROJECT_ROOT, "src/agents/current/eval-slices/beam-1m");
const DEFAULT_RESERVE = resolve(EVAL_ROOT, "beam-1m-blind-reserve-v1.json");
const DEFAULT_HOLDOUT = resolve(EVAL_ROOT, "beam-1m-compression-holdout40-v1.json");
const DEFAULT_DIAGNOSTIC = resolve(
  PROJECT_ROOT,
  "runs/beam-1m-k81-downstream-20260806/layer-diagnostic.json",
);
const DEFAULT_SMOKE = resolve(EVAL_ROOT, "beam-1m-compression-smoke12-v1.json");
const SEED = "beam-compression-holdout-v1\u00002026-08-08";
const FOCUSED_ABILITIES = [
  "contradiction_resolution",
  "information_extraction",
  "instruction_following",
  "knowledge_update",
  "multi_session_reasoning",
  "preference_following",
  "summarization",
  "temporal_reasoning",
] as const;

type Manifest = {
  schema_version: number;
  benchmark: string;
  tier: string;
  name: string;
  role: string;
  source: {
    repository: string;
    commit: string;
    topics_sha256: string;
  };
  conversation_ids: number[];
  question_keys: string[];
  source_records: Array<{
    conversation_id: number;
    chat_sha256: string;
    probing_questions_sha256: string;
  }>;
};

type DiagnosticRow = {
  question_id: string;
  ability: string;
  gold: number;
  discovery_gold: number;
  k81_gold: number;
  k81_full: boolean;
};

function parseArgs(argv: string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith("--")) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) output[argument.slice(2)] = "true";
    else {
      output[argument.slice(2)] = value;
      index += 1;
    }
  }
  return output;
}

function hash(value: string): string {
  return createHash("sha256").update(SEED).update("\0").update(value).digest("hex");
}

function abilityFromQuestionId(questionId: string): string {
  const match = questionId.match(/^beam-1m\/chat-[0-9]+\/([^/]+)\/[12]$/);
  if (!match?.[1]) throw new Error(`invalid BEAM question key: ${questionId}`);
  return match[1];
}

function conversationFromQuestionId(questionId: string): number {
  const match = questionId.match(/^beam-1m\/chat-([0-9]+)\//);
  if (!match?.[1]) throw new Error(`invalid BEAM question key: ${questionId}`);
  return Number(match[1]);
}

function countByAbility(questionIds: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const questionId of questionIds) {
    const ability = abilityFromQuestionId(questionId);
    counts[ability] = (counts[ability] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function selectHoldout(reserve: Manifest): Manifest & Record<string, unknown> {
  const selected: string[] = [];
  for (const ability of FOCUSED_ABILITIES) {
    const candidates = reserve.question_keys
      .filter((questionId) => abilityFromQuestionId(questionId) === ability)
      .sort((left, right) => hash(left).localeCompare(hash(right)) || left.localeCompare(right));
    const abilitySelection: string[] = [];
    const conversations = new Set<number>();
    for (const questionId of candidates) {
      const conversationId = conversationFromQuestionId(questionId);
      if (conversations.has(conversationId)) continue;
      abilitySelection.push(questionId);
      conversations.add(conversationId);
      if (abilitySelection.length === 5) break;
    }
    if (abilitySelection.length !== 5) {
      throw new Error(`could not select five conversation-distinct ${ability} questions`);
    }
    selected.push(...abilitySelection);
  }
  const conversationIds = [...new Set(selected.map(conversationFromQuestionId))].sort((a, b) => a - b);
  const records = new Map(reserve.source_records.map((record) => [record.conversation_id, record]));
  return {
    schema_version: 1,
    benchmark: reserve.benchmark,
    tier: reserve.tier,
    name: "beam-1m-compression-holdout40-v1",
    role: "sealed_compression_generalization_gate_do_not_open_during_prompt_development",
    source: reserve.source,
    conversation_ids: conversationIds,
    question_keys: selected,
    source_records: conversationIds.map((conversationId) => {
      const record = records.get(conversationId);
      if (!record) throw new Error(`reserve is missing source record ${String(conversationId)}`);
      return record;
    }),
    sealed: true,
    selection: {
      source_manifest: DEFAULT_RESERVE,
      seed_sha256: createHash("sha256").update(SEED).digest("hex"),
      policy: "five hash-selected, conversation-distinct questions per focused answerable ability; no question text, answers, rubrics, or scores inspected",
      ability_counts: countByAbility(selected),
    },
  };
}

function selectSmoke(rows: DiagnosticRow[]): Record<string, unknown> {
  const byAbility = (ability: string): DiagnosticRow[] => rows
    .filter((row) => row.ability === ability)
    .sort((left, right) =>
      (right.gold - right.k81_gold) - (left.gold - left.k81_gold)
      || (right.gold - right.discovery_gold) - (left.gold - left.discovery_gold)
      || right.gold - left.gold
      || left.question_id.localeCompare(right.question_id),
    );
  const selected = [
    ...byAbility("summarization").slice(0, 4),
    ...byAbility("multi_session_reasoning").slice(0, 4),
    ...byAbility("information_extraction").slice(0, 1),
    ...byAbility("temporal_reasoning").slice(0, 1),
    ...byAbility("contradiction_resolution").slice(0, 1),
    ...byAbility("instruction_following").slice(0, 1),
  ];
  if (selected.length !== 12 || new Set(selected.map((row) => row.question_id)).size !== 12) {
    throw new Error("smoke selection must contain 12 unique questions");
  }
  return {
    schema_version: 1,
    benchmark: "BEAM",
    tier: "1M",
    name: "beam-1m-compression-smoke12-v1",
    role: "development_smoke_not_predictive",
    question_ids: selected.map((row) => row.question_id),
    ability_counts: countByAbility(selected.map((row) => row.question_id)),
    selection: {
      policy: "four summarization, four multi-session, and four point-task controls; broad cases ordered by measured K81 loss",
      source_diagnostic: DEFAULT_DIAGNOSTIC,
      warning: "selection used the unreconciled oracle only to stress known failure shapes; scoring must use the recertified oracle",
    },
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const reservePath = resolve(args.reserve ?? DEFAULT_RESERVE);
  const holdoutPath = resolve(args.holdout ?? DEFAULT_HOLDOUT);
  const diagnosticPath = resolve(args.diagnostic ?? DEFAULT_DIAGNOSTIC);
  const smokePath = resolve(args.smoke ?? DEFAULT_SMOKE);
  const reserve = JSON.parse(readFileSync(reservePath, "utf8")) as Manifest;
  const diagnostic = JSON.parse(readFileSync(diagnosticPath, "utf8")) as { rows: DiagnosticRow[] };
  const holdout = selectHoldout(reserve);
  const smoke = selectSmoke(diagnostic.rows);
  writeFileSync(holdoutPath, `${JSON.stringify(holdout, null, 2)}\n`);
  writeFileSync(smokePath, `${JSON.stringify(smoke, null, 2)}\n`);
  console.log(JSON.stringify({ holdout: holdoutPath, smoke: smokePath, holdout_summary: {
    questions: holdout.question_keys.length,
    conversations: holdout.conversation_ids.length,
    ability_counts: (holdout.selection as { ability_counts: unknown }).ability_counts,
  }, smoke_summary: {
    questions: (smoke.question_ids as string[]).length,
    ability_counts: smoke.ability_counts,
  } }, null, 2));
}

main();
