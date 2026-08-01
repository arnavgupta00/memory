import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BEAM_ABILITIES,
  beamQuestionKey,
  loadBeamCanaryManifest,
} from "../benchmarks/beam1m.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const POPULATION_CONVERSATIONS = 35;

type EvaluationItem = {
  llm_judge_score?: number;
  tau_norm?: number;
  [key: string]: unknown;
};
type EvaluationFile = Record<string, EvaluationItem[]>;

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

function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / Math.max(values.length, 1);
}

function scoreItem(ability: string, item: EvaluationItem): number {
  const score = ability === "event_ordering" ? item.tau_norm : item.llm_judge_score;
  if (typeof score !== "number" || !Number.isFinite(score)) {
    throw new Error(`${ability} evaluation item is missing its official score field`);
  }
  return score;
}

function confidenceInterval(values: number[]): Record<string, number> {
  const center = mean(values);
  if (values.length < 2) {
    return { mean: center, lower: center, upper: center, half_width: 0 };
  }
  const variance = values.reduce((sum, value) => sum + (value - center) ** 2, 0)
    / (values.length - 1);
  const finitePopulationCorrection = values.length >= POPULATION_CONVERSATIONS
    ? 0
    : Math.sqrt(
      (POPULATION_CONVERSATIONS - values.length) / (POPULATION_CONVERSATIONS - 1),
    );
  const halfWidth = 1.96 * Math.sqrt(variance / values.length) * finitePopulationCorrection;
  return {
    mean: center,
    lower: Math.max(0, center - halfWidth),
    upper: Math.min(1, center + halfWidth),
    half_width: halfWidth,
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.manifest || !args.results || !args.out) {
    throw new Error("--manifest, --results, and --out are required");
  }
  const manifest = loadBeamCanaryManifest(resolve(PROJECT_ROOT, args.manifest));
  const results = resolve(PROJECT_ROOT, args.results);
  const outputPath = resolve(PROJECT_ROOT, args.out);
  const filename = args.filename ?? "architecture-0008.json";
  const abilityScores = new Map<string, number[]>();
  const conversations: Array<Record<string, unknown>> = [];
  const questionScores: Array<Record<string, unknown>> = [];

  for (const conversationId of manifest.conversation_ids) {
    const path = resolve(results, String(conversationId), `evaluation-${filename}`);
    const evaluation = JSON.parse(readFileSync(path, "utf8")) as EvaluationFile;
    const perAbility: Record<string, number> = {};
    for (const ability of BEAM_ABILITIES) {
      const items = evaluation[ability];
      if (!Array.isArray(items) || items.length !== 2) {
        throw new Error(`${path}: ${ability} must contain exactly two official evaluations`);
      }
      const scores = items.map((item, index) => {
        const score = scoreItem(ability, item);
        questionScores.push({
          question_id: beamQuestionKey(conversationId, ability, index + 1),
          conversation_id: conversationId,
          ability,
          score,
          official_metric: ability === "event_ordering" ? "tau_norm" : "llm_judge_score",
        });
        return score;
      });
      const abilityMean = mean(scores);
      perAbility[ability] = abilityMean;
      const accumulated = abilityScores.get(ability) ?? [];
      accumulated.push(abilityMean);
      abilityScores.set(ability, accumulated);
    }
    conversations.push({
      conversation_id: conversationId,
      macro_score: mean(Object.values(perAbility)),
      abilities: perAbility,
    });
  }

  const aggregateAbilities = Object.fromEntries(
    BEAM_ABILITIES.map((ability) => [ability, mean(abilityScores.get(ability) ?? [])]),
  );
  const conversationMacroScores = conversations.map((item) => Number(item.macro_score));
  const payload = {
    schema_version: 1,
    benchmark: "BEAM",
    tier: "1M",
    canary: manifest.name,
    official_scoring_convention: {
      event_ordering: "tau_norm",
      all_other_abilities: "llm_judge_score",
      aggregation: "mean within ability per conversation, then mean conversations and abilities",
    },
    aggregate: {
      macro_score: mean(Object.values(aggregateAbilities)),
      abilities: aggregateAbilities,
      conversation_level_95_percent_ci: confidenceInterval(conversationMacroScores),
      conversations: conversations.length,
      questions: questionScores.length,
    },
    conversations,
    questions: questionScores,
  };
  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify(payload.aggregate, null, 2));
}

main();
