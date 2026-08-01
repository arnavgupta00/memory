/**
 * Build deterministic, conversation-isolated canaries for the BEAM 1M tier.
 *
 * Selection is intentionally blind to question text, reference answers, and
 * rubrics. It uses conversation metadata plus aggregate provenance geometry
 * (evidence count/position) and difficulty labels only.
 */
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const DEFAULT_OUTPUT = resolve(
  PROJECT_ROOT,
  "src/agents/current/eval-slices/beam-1m",
);
const SOURCE_COMMIT = "3e12035532eb85768f1a7cd779832b650c4b2ef9";
const SEED = 20_260_731;
const RANDOM_SEARCH_ITERATIONS = 250_000;
const ABILITIES = [
  "abstention",
  "contradiction_resolution",
  "event_ordering",
  "information_extraction",
  "instruction_following",
  "knowledge_update",
  "multi_session_reasoning",
  "preference_following",
  "summarization",
  "temporal_reasoning",
] as const;

type Ability = (typeof ABILITIES)[number];
type Topic = {
  id: number;
  category: string;
};
type Message = {
  id?: number | string;
  role: "user" | "assistant";
  content: string;
  time_anchor?: string | null;
};
type ChatBatch = {
  turns: Message[][];
};
type Probe = {
  difficulty?: string;
  source_chat_ids?: unknown;
};
type ProbeFile = Record<Ability, Probe[]>;
type QuestionMetadata = {
  key: string;
  ability: Ability;
  ordinal: number;
  difficulty: string;
  source_pair_count: number;
  source_mean_position: number | null;
  source_span: number | null;
};
type Conversation = {
  id: number;
  category: string;
  chat_sha256: string;
  probes_sha256: string;
  question_metadata: QuestionMetadata[];
  features: Record<string, number>;
};
type Args = {
  beamRoot: string;
  output: string;
};

function parseArgs(argv: string[]): Args {
  let beamRoot = "";
  let output = DEFAULT_OUTPUT;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--beam-root" && value) {
      beamRoot = resolve(value);
      index += 1;
    } else if (argument === "--out" && value) {
      output = resolve(value);
      index += 1;
    }
  }
  if (!beamRoot) {
    throw new Error("--beam-root is required and must point to the official BEAM chats/1M directory");
  }
  return { beamRoot, output };
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function flattenNumericIds(value: unknown): number[] {
  if (Array.isArray(value)) return value.flatMap(flattenNumericIds);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(flattenNumericIds);
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? [parsed] : [];
}

function quantile(values: number[], proportion: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * proportion));
  return sorted[index] ?? 0;
}

function mean(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function countWhere<T>(values: T[], predicate: (value: T) => boolean): number {
  return values.filter(predicate).length;
}

function countBy(values: string[]): Record<string, number> {
  return Object.fromEntries(
    [...new Set(values)]
      .sort()
      .map((value) => [value, countWhere(values, (candidate) => candidate === value)]),
  );
}

function readConversation(beamRoot: string, topic: Topic): Conversation {
  const chatPath = resolve(beamRoot, String(topic.id), "chat.json");
  const probesPath = resolve(
    beamRoot,
    String(topic.id),
    "probing_questions/probing_questions.json",
  );
  const chatRaw = readFileSync(chatPath);
  const probesRaw = readFileSync(probesPath);
  const chat = JSON.parse(chatRaw.toString("utf8")) as ChatBatch[];
  const probes = JSON.parse(probesRaw.toString("utf8")) as ProbeFile;
  const messages = chat.flatMap((batch) => batch.turns.flat());
  const numericMessageIds = messages
    .map((message) => Number(message.id))
    .filter((id) => Number.isFinite(id));
  const maxMessageId = Math.max(...numericMessageIds);
  const maxPairId = Math.max(1, Math.floor(maxMessageId / 2));
  const questionMetadata: QuestionMetadata[] = [];

  for (const ability of ABILITIES) {
    const abilityProbes = probes[ability];
    if (!Array.isArray(abilityProbes) || abilityProbes.length !== 2) {
      throw new Error(
        `conversation ${String(topic.id)} ability ${ability} must contain exactly two probes`,
      );
    }
    for (let ordinal = 0; ordinal < abilityProbes.length; ordinal += 1) {
      const probe = abilityProbes[ordinal];
      if (!probe) throw new Error("missing probe after length validation");
      const sourcePairIds = [
        ...new Set(flattenNumericIds(probe.source_chat_ids).map((id) => Math.floor(id / 2))),
      ].sort((left, right) => left - right);
      const positions = sourcePairIds.map((id) => id / maxPairId);
      questionMetadata.push({
        key: `beam-1m/chat-${String(topic.id).padStart(2, "0")}/${ability}/${String(ordinal + 1)}`,
        ability,
        ordinal: ordinal + 1,
        difficulty: probe.difficulty?.trim().toLowerCase() || "unspecified",
        source_pair_count: sourcePairIds.length,
        source_mean_position: positions.length > 0 ? mean(positions) : null,
        source_span:
          positions.length > 0 ? Math.max(...positions) - Math.min(...positions) : null,
      });
    }
  }

  if (questionMetadata.length !== 20) {
    throw new Error(`conversation ${String(topic.id)} must contain exactly 20 probes`);
  }

  const answerable = questionMetadata.filter((question) => question.source_pair_count > 0);
  const sourcePositions = answerable
    .map((question) => question.source_mean_position)
    .filter((value): value is number => value !== null);
  const sourceSpans = answerable
    .map((question) => question.source_span)
    .filter((value): value is number => value !== null);
  const sourceCounts = questionMetadata.map((question) => question.source_pair_count);
  const eventOrdering = questionMetadata.filter(
    (question) => question.ability === "event_ordering",
  );
  const summarization = questionMetadata.filter(
    (question) => question.ability === "summarization",
  );
  const multiSession = questionMetadata.filter(
    (question) => question.ability === "multi_session_reasoning",
  );
  const userMessages = messages.filter((message) => message.role === "user");
  const totalCharacters = messages.reduce((total, message) => total + message.content.length, 0);
  const userCharacters = userMessages.reduce(
    (total, message) => total + message.content.length,
    0,
  );
  const positionQuartiles = [0, 1, 2, 3].map((quartile) =>
    countWhere(sourcePositions, (position) =>
      Math.min(3, Math.floor(position * 4)) === quartile,
    ) / Math.max(sourcePositions.length, 1),
  );

  const features: Record<string, number> = {
    message_count: messages.length,
    pair_count: userMessages.length,
    turn_array_count: chat.reduce((total, batch) => total + batch.turns.length, 0),
    total_characters: totalCharacters,
    user_character_share: userCharacters / Math.max(totalCharacters, 1),
    time_anchor_count: countWhere(messages, (message) => Boolean(message.time_anchor)),
    evidence_mean: mean(sourceCounts),
    evidence_p90: quantile(sourceCounts, 0.9),
    evidence_max: Math.max(...sourceCounts),
    evidence_over_12_rate: countWhere(sourceCounts, (count) => count > 12) / 20,
    evidence_over_20_rate: countWhere(sourceCounts, (count) => count > 20) / 20,
    evidence_over_24_rate: countWhere(sourceCounts, (count) => count > 24) / 20,
    source_mean_position: mean(sourcePositions),
    source_mean_span: mean(sourceSpans),
    source_position_q1_rate: positionQuartiles[0] ?? 0,
    source_position_q2_rate: positionQuartiles[1] ?? 0,
    source_position_q3_rate: positionQuartiles[2] ?? 0,
    source_position_q4_rate: positionQuartiles[3] ?? 0,
    difficulty_easy_rate:
      countWhere(questionMetadata, (question) => question.difficulty === "easy") / 20,
    difficulty_medium_rate:
      countWhere(questionMetadata, (question) => question.difficulty === "medium") / 20,
    difficulty_hard_rate:
      countWhere(questionMetadata, (question) => question.difficulty === "hard") / 20,
    event_ordering_evidence_mean: mean(
      eventOrdering.map((question) => question.source_pair_count),
    ),
    event_ordering_over_12_rate:
      countWhere(eventOrdering, (question) => question.source_pair_count > 12) / 2,
    summarization_evidence_mean: mean(
      summarization.map((question) => question.source_pair_count),
    ),
    summarization_over_12_rate:
      countWhere(summarization, (question) => question.source_pair_count > 12) / 2,
    multi_session_evidence_mean: mean(
      multiSession.map((question) => question.source_pair_count),
    ),
  };

  return {
    id: topic.id,
    category: topic.category,
    chat_sha256: sha256(chatRaw),
    probes_sha256: sha256(probesRaw),
    question_metadata: questionMetadata,
    features,
  };
}

function featureWeight(name: string): number {
  if (name.startsWith("category:")) return 1.5;
  if (name.includes("over_12") || name.includes("over_24")) return 2;
  if (name.startsWith("event_ordering") || name.startsWith("summarization")) return 1.5;
  if (name.startsWith("difficulty_")) return 1.25;
  if (name.startsWith("source_position_")) return 1.25;
  if (name === "message_count" || name === "total_characters") return 0.75;
  return 1;
}

function buildStandardizedFeatures(
  conversations: Conversation[],
): Map<number, Record<string, number>> {
  const categories = [...new Set(conversations.map((conversation) => conversation.category))]
    .sort();
  const featureNames = Object.keys(conversations[0]?.features ?? {}).sort();
  const raw = new Map<number, Record<string, number>>();
  for (const conversation of conversations) {
    const values = { ...conversation.features };
    for (const category of categories) {
      values[`category:${category}`] = conversation.category === category ? 1 : 0;
    }
    raw.set(conversation.id, values);
  }
  const standardized = new Map<number, Record<string, number>>();
  const allFeatureNames = [...featureNames, ...categories.map((category) => `category:${category}`)];
  const means = Object.fromEntries(
    allFeatureNames.map((name) => [
      name,
      mean(conversations.map((conversation) => raw.get(conversation.id)?.[name] ?? 0)),
    ]),
  );
  const standardDeviations = Object.fromEntries(
    allFeatureNames.map((name) => {
      const center = means[name] ?? 0;
      const variance = mean(
        conversations.map((conversation) => {
          const value = raw.get(conversation.id)?.[name] ?? 0;
          return (value - center) ** 2;
        }),
      );
      return [name, Math.sqrt(variance)];
    }),
  );
  for (const conversation of conversations) {
    const values: Record<string, number> = {};
    for (const name of allFeatureNames) {
      const spread = standardDeviations[name] ?? 0;
      values[name] = spread === 0
        ? 0
        : ((raw.get(conversation.id)?.[name] ?? 0) - (means[name] ?? 0)) / spread;
    }
    standardized.set(conversation.id, values);
  }
  return standardized;
}

function objective(
  ids: number[],
  standardized: Map<number, Record<string, number>>,
): number {
  const first = standardized.get(ids[0] ?? -1);
  if (!first) return Number.POSITIVE_INFINITY;
  let total = 0;
  let weightTotal = 0;
  for (const name of Object.keys(first)) {
    const subsetMean = mean(ids.map((id) => standardized.get(id)?.[name] ?? 0));
    const weight = featureWeight(name);
    total += weight * subsetMean ** 2;
    weightTotal += weight;
  }
  return total / weightTotal;
}

function createPrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

function randomSubset(ids: number[], count: number, random: () => number): number[] {
  const shuffled = [...ids];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const value = shuffled[index];
    const swapValue = shuffled[swapIndex];
    if (value === undefined || swapValue === undefined) continue;
    shuffled[index] = swapValue;
    shuffled[swapIndex] = value;
  }
  return shuffled.slice(0, count).sort((left, right) => left - right);
}

function localImprove(
  initial: number[],
  universe: number[],
  standardized: Map<number, Record<string, number>>,
): number[] {
  let selected = [...initial].sort((left, right) => left - right);
  let current = objective(selected, standardized);
  for (let pass = 0; pass < universe.length; pass += 1) {
    let best = selected;
    let bestScore = current;
    const selectedSet = new Set(selected);
    const unselected = universe.filter((id) => !selectedSet.has(id));
    for (const outgoing of selected) {
      for (const incoming of unselected) {
        const candidate = selected
          .filter((id) => id !== outgoing)
          .concat(incoming)
          .sort((left, right) => left - right);
        const score = objective(candidate, standardized);
        const candidateKey = candidate.join(",");
        const bestKey = best.join(",");
        if (score < bestScore - 1e-12 || (Math.abs(score - bestScore) <= 1e-12 && candidateKey < bestKey)) {
          best = candidate;
          bestScore = score;
        }
      }
    }
    if (bestScore >= current - 1e-12) return selected;
    selected = best;
    current = bestScore;
  }
  return selected;
}

function selectCertification(
  universe: number[],
  standardized: Map<number, Record<string, number>>,
): { ids: number[]; objective: number; randomPercentile: number } {
  const random = createPrng(SEED);
  let best: number[] = [];
  let bestScore = Number.POSITIVE_INFINITY;
  const sampledScores: number[] = [];
  for (let iteration = 0; iteration < RANDOM_SEARCH_ITERATIONS; iteration += 1) {
    const candidate = randomSubset(universe, 13, random);
    const score = objective(candidate, standardized);
    if (iteration < 20_000) sampledScores.push(score);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  const improved = localImprove(best, universe, standardized);
  const improvedScore = objective(improved, standardized);
  const percentile = sampledScores.length === 0
    ? 0
    : countWhere(sampledScores, (score) => score <= improvedScore) / sampledScores.length;
  return { ids: improved, objective: improvedScore, randomPercentile: percentile };
}

function combinationsOfTwo(ids: number[]): Array<[number, number]> {
  const output: Array<[number, number]> = [];
  for (let left = 0; left < ids.length; left += 1) {
    for (let right = left + 1; right < ids.length; right += 1) {
      const leftId = ids[left];
      const rightId = ids[right];
      if (leftId !== undefined && rightId !== undefined) output.push([leftId, rightId]);
    }
  }
  return output;
}

function selectExpansionPair(
  selected: number[],
  universe: number[],
  standardized: Map<number, Record<string, number>>,
): number[] {
  const selectedSet = new Set(selected);
  const remaining = universe.filter((id) => !selectedSet.has(id));
  return combinationsOfTwo(remaining)
    .map((pair) => ({
      pair,
      score: objective([...selected, ...pair], standardized),
    }))
    .sort((left, right) => left.score - right.score || left.pair.join(",").localeCompare(right.pair.join(",")))[0]
    ?.pair ?? [];
}

function diagnosticCoverageScore(ids: number[], byId: Map<number, Conversation>): number {
  const conversations = ids
    .map((id) => byId.get(id))
    .filter((value): value is Conversation => Boolean(value));
  const categories = new Set(conversations.map((conversation) => conversation.category)).size;
  const featureNames = [
    "message_count",
    "total_characters",
    "evidence_mean",
    "evidence_p90",
    "evidence_over_12_rate",
    "source_mean_position",
    "source_mean_span",
    "event_ordering_evidence_mean",
    "summarization_evidence_mean",
  ];
  const ranges = featureNames.reduce((total, name) => {
    const values = conversations.map((conversation) => conversation.features[name] ?? 0);
    return total + Math.max(...values) - Math.min(...values);
  }, 0);
  const stress = Math.max(
    ...conversations.map((conversation) => conversation.features.evidence_over_12_rate ?? 0),
  );
  return categories * 1_000_000 + ranges + stress * 10_000;
}

function selectDevelopment(ids: number[], byId: Map<number, Conversation>): number[] {
  let best: number[] = [];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let a = 0; a < ids.length - 4; a += 1) {
    for (let b = a + 1; b < ids.length - 3; b += 1) {
      for (let c = b + 1; c < ids.length - 2; c += 1) {
        for (let d = c + 1; d < ids.length - 1; d += 1) {
          for (let e = d + 1; e < ids.length; e += 1) {
            const candidate = [ids[a], ids[b], ids[c], ids[d], ids[e]].filter(
              (value): value is number => value !== undefined,
            );
            const score = diagnosticCoverageScore(candidate, byId);
            if (score > bestScore || (score === bestScore && candidate.join(",") < best.join(","))) {
              best = candidate;
              bestScore = score;
            }
          }
        }
      }
    }
  }
  return best;
}

function subsetProfile(ids: number[], byId: Map<number, Conversation>): Record<string, unknown> {
  const conversations = ids.map((id) => {
    const conversation = byId.get(id);
    if (!conversation) throw new Error(`unknown conversation ${String(id)}`);
    return conversation;
  });
  const questions = conversations.flatMap((conversation) => conversation.question_metadata);
  const sourceCounts = questions.map((question) => question.source_pair_count);
  return {
    conversations: conversations.length,
    questions: questions.length,
    by_category: countBy(conversations.map((conversation) => conversation.category)),
    by_ability: countBy(questions.map((question) => question.ability)),
    by_difficulty: countBy(questions.map((question) => question.difficulty)),
    evidence_pairs: {
      mean: Number(mean(sourceCounts).toFixed(4)),
      median: quantile(sourceCounts, 0.5),
      p90: quantile(sourceCounts, 0.9),
      max: Math.max(...sourceCounts),
      over_12: countWhere(sourceCounts, (count) => count > 12),
      over_20: countWhere(sourceCounts, (count) => count > 20),
      over_24: countWhere(sourceCounts, (count) => count > 24),
    },
  };
}

function balanceDiagnostics(
  ids: number[],
  standardized: Map<number, Record<string, number>>,
): Record<string, unknown> {
  const first = standardized.get(ids[0] ?? -1);
  if (!first) throw new Error("cannot calculate diagnostics for empty subset");
  const differences = Object.keys(first).map((name) => ({
    feature: name,
    standardized_mean_difference: mean(
      ids.map((id) => standardized.get(id)?.[name] ?? 0),
    ),
  }));
  const absolute = differences.map((item) => Math.abs(item.standardized_mean_difference));
  return {
    objective: Number(objective(ids, standardized).toFixed(8)),
    rms_standardized_mean_difference: Number(
      Math.sqrt(mean(absolute.map((value) => value ** 2))).toFixed(6),
    ),
    max_absolute_standardized_mean_difference: Number(Math.max(...absolute).toFixed(6)),
    largest_differences: differences
      .sort(
        (left, right) =>
          Math.abs(right.standardized_mean_difference)
          - Math.abs(left.standardized_mean_difference),
      )
      .slice(0, 10)
      .map((item) => ({
        feature: item.feature,
        standardized_mean_difference: Number(item.standardized_mean_difference.toFixed(6)),
      })),
  };
}

function sourceRecords(ids: number[], byId: Map<number, Conversation>): Array<Record<string, unknown>> {
  return ids.map((id) => {
    const conversation = byId.get(id);
    if (!conversation) throw new Error(`unknown conversation ${String(id)}`);
    return {
      conversation_id: id,
      category: conversation.category,
      chat_sha256: conversation.chat_sha256,
      probing_questions_sha256: conversation.probes_sha256,
    };
  });
}

function manifest(
  name: string,
  role: string,
  ids: number[],
  byId: Map<number, Conversation>,
  topicsSha256: string,
  standardized: Map<number, Record<string, number>>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const questions = ids.flatMap((id) => byId.get(id)?.question_metadata ?? []);
  return {
    schema_version: 1,
    benchmark: "BEAM",
    tier: "1M",
    name,
    role,
    status: "frozen_unrun",
    selection_seed: SEED,
    source: {
      repository: "https://github.com/mohammadtavakoli78/BEAM",
      commit: SOURCE_COMMIT,
      topics_sha256: topicsSha256,
    },
    isolation_unit: "complete_conversation",
    conversation_ids: ids,
    question_keys: questions.map((question) => question.key),
    counts: subsetProfile(ids, byId),
    source_records: sourceRecords(ids, byId),
    balance: balanceDiagnostics(ids, standardized),
    ...extra,
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const topicsPath = resolve(args.beamRoot, "topics.json");
  const topicsRaw = readFileSync(topicsPath);
  const topics = JSON.parse(topicsRaw.toString("utf8")) as Topic[];
  if (topics.length !== 35) throw new Error(`expected 35 BEAM-1M topics, got ${String(topics.length)}`);
  const topicIds = topics.map((topic) => topic.id).sort((left, right) => left - right);
  if (new Set(topicIds).size !== 35 || topicIds[0] !== 1 || topicIds[34] !== 35) {
    throw new Error("BEAM-1M topic IDs must be the unique integers 1..35");
  }
  for (const topic of topics) {
    const directoryEntries = readdirSync(resolve(args.beamRoot, String(topic.id)));
    if (!directoryEntries.includes("chat.json") || !directoryEntries.includes("probing_questions")) {
      throw new Error(`conversation ${String(topic.id)} is incomplete`);
    }
  }

  const conversations = topics.map((topic) => readConversation(args.beamRoot, topic));
  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  const standardized = buildStandardizedFeatures(conversations);
  const certification = selectCertification(topicIds, standardized);
  const expansion15 = selectExpansionPair(certification.ids, topicIds, standardized);
  const certification15 = [...certification.ids, ...expansion15].sort((left, right) => left - right);
  const expansion17 = selectExpansionPair(certification15, topicIds, standardized);
  const certification17 = [...certification15, ...expansion17].sort((left, right) => left - right);
  const certification17Set = new Set(certification17);
  const developmentPool = topicIds.filter((id) => !certification17Set.has(id));
  const development = selectDevelopment(developmentPool, byId);
  const developmentSet = new Set(development);
  const baseCertificationSet = new Set(certification.ids);
  const reserve = topicIds.filter(
    (id) => !developmentSet.has(id) && !baseCertificationSet.has(id),
  );
  const finalBlind = reserve.filter(
    (id) => !expansion15.includes(id) && !expansion17.includes(id),
  );

  if (development.length !== 5 || certification.ids.length !== 13 || reserve.length !== 17) {
    throw new Error("partition size invariant failed");
  }
  if (new Set([...development, ...certification.ids, ...reserve]).size !== 35) {
    throw new Error("partition disjointness invariant failed");
  }

  const topicsSha256 = sha256(topicsRaw);
  const reliabilityContract = {
    primary_metric: "official BEAM macro score across ten abilities",
    target_half_width: 0.05,
    confidence_level: 0.95,
    unit_for_uncertainty: "conversation-level score",
    base_conversations: 13,
    expansion_rule:
      "Add the next precommitted two-conversation block only when the finite-population "
      + "95% confidence interval half-width exceeds 0.05. Never expand based on the point score.",
    benchmark_thresholds: {
      published_rag: 0.302,
      published_light: 0.336,
    },
    reliability_status: "provisional_structural",
    certification_requirement:
      "Requires a paired frozen-system full-700 run; published per-conversation baseline "
      + "outputs were not available in the upstream repository for retrospective score backtesting.",
  };

  const developmentManifest = manifest(
    "beam-1m-canary-a-development-v1",
    "development_only_not_predictive",
    development,
    byId,
    topicsSha256,
    standardized,
    {
      inspection_policy: "Individual cases may be inspected and used for debugging or tuning.",
    },
  );
  const certificationManifest = manifest(
    "beam-1m-canary-b-certification-v1",
    "sealed_score_prediction",
    certification.ids,
    byId,
    topicsSha256,
    standardized,
    {
      random_search_iterations: RANDOM_SEARCH_ITERATIONS,
      selected_objective_random_percentile: certification.randomPercentile,
      expansion_to_15_conversation_ids: expansion15,
      expansion_to_17_conversation_ids: expansion17,
      reliability_contract: reliabilityContract,
      inspection_policy:
        "Do not inspect individual questions, references, rubrics, predictions, or failures before "
        + "the architecture is frozen. Any tuning after unsealing retires this certification canary.",
    },
  );
  const reserveManifest = manifest(
    "beam-1m-blind-reserve-v1",
    "precommitted_expansion_and_full_run_confirmation",
    reserve,
    byId,
    topicsSha256,
    standardized,
    {
      expansion_order: [
        { target_conversations: 15, conversation_ids: expansion15 },
        { target_conversations: 17, conversation_ids: expansion17 },
      ],
      final_blind_confirmation_conversation_ids: finalBlind,
      inspection_policy:
        "Keep sealed. Expansion is variance-triggered only; final-blind cases are not development data.",
    },
  );
  const design = {
    schema_version: 1,
    benchmark: "BEAM",
    tier: "1M",
    name: "beam-1m-canary-design-v1",
    status: "frozen_unrun",
    generated_by: "src/agents/current/src/scripts/buildBeam1mCanaries.ts",
    selection_seed: SEED,
    source_commit: SOURCE_COMMIT,
    source_topics_sha256: topicsSha256,
    selection_inputs:
      "Conversation category and structural metadata, difficulty labels, and aggregate source-ID "
      + "count/position geometry. Question text, reference answers, and rubrics are excluded.",
    population: subsetProfile(topicIds, byId),
    partition: {
      development_conversation_ids: development,
      certification_conversation_ids: certification.ids,
      reserve_conversation_ids: reserve,
      expansion_to_15_conversation_ids: expansion15,
      expansion_to_17_conversation_ids: expansion17,
      final_blind_confirmation_conversation_ids: finalBlind,
    },
    certification_balance: balanceDiagnostics(certification.ids, standardized),
    certification_15_balance: balanceDiagnostics(certification15, standardized),
    certification_17_balance: balanceDiagnostics(certification17, standardized),
    reliability_contract: reliabilityContract,
  };

  mkdirSync(args.output, { recursive: true });
  const files: Array<[string, Record<string, unknown>]> = [
    ["beam-1m-canary-a-development-v1.json", developmentManifest],
    ["beam-1m-canary-b-certification-v1.json", certificationManifest],
    ["beam-1m-blind-reserve-v1.json", reserveManifest],
    ["beam-1m-canary-design-v1.json", design],
  ];
  for (const [filename, payload] of files) {
    writeFileSync(resolve(args.output, filename), `${JSON.stringify(payload, null, 2)}\n`);
  }
  const checksums = files
    .map(([filename]) => {
      const content = readFileSync(resolve(args.output, filename));
      return `${sha256(content)}  ${filename}`;
    })
    .join("\n");
  writeFileSync(resolve(args.output, "CHECKSUMS.sha256"), `${checksums}\n`);

  console.log(JSON.stringify({
    output: args.output,
    source_commit: SOURCE_COMMIT,
    source_bytes: conversations.reduce(
      (total, conversation) =>
        total
        + statSync(resolve(args.beamRoot, String(conversation.id), "chat.json")).size,
      0,
    ),
    development,
    certification: certification.ids,
    expansion_to_15: expansion15,
    expansion_to_17: expansion17,
    final_blind: finalBlind,
    certification_profile: subsetProfile(certification.ids, byId),
    population_profile: subsetProfile(topicIds, byId),
    certification_balance: balanceDiagnostics(certification.ids, standardized),
  }, null, 2));
}

main();
