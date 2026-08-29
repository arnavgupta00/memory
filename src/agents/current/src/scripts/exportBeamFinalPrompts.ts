/**
 * Export the exact final-answer prompts used by the official BEAM-1M 74.10% run.
 *
 * The 100-question result is a merge of 78 K=81 raw-session answers and 22
 * inherited control answers. Each exported prompt is located by its OpenAI
 * request ID, then verified against both the recorded prompt hash and the
 * merged model response before it is written.
 *
 * Usage:
 *   pnpm --dir src/agents/current exec node --import tsx \
 *     src/scripts/exportBeamFinalPrompts.ts
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const RUN_ROOT = resolve(PROJECT_ROOT, "runs/beam-1m-k81-downstream-20260806");
const MERGED_PREDICTIONS = resolve(
  RUN_ROOT,
  "merged/raw-k81-plus-best22/predictions.jsonl",
);
const OFFICIAL_SUMMARY = resolve(RUN_ROOT, "beam-official-summary-raw.json");
const OUTPUT_ROOT = resolve(RUN_ROOT, "final-prompts");

const SOURCE_ROOTS = [
  {
    label: "K=81 raw-session Luna-high run",
    cohort: "K81 regenerated",
    path: resolve(
      RUN_ROOT,
      "downstream/beam-k81-raw-focused78-r2-20260806-4/agent-artifacts/cases",
    ),
  },
  {
    label: "Architecture 0008 broad-history inherited control",
    cohort: "inherited control",
    path: resolve(
      PROJECT_ROOT,
      "runs/beam-1m-broad-history-fix-20260801-r2/downstream/architecture-0008-broad-history-fix-3/agent-artifacts/cases",
    ),
  },
  {
    label: "Architecture 0008 inherited control",
    cohort: "inherited control",
    path: resolve(
      PROJECT_ROOT,
      "runs/beam-1m-canary-a-architecture-0008-20260731-r2/downstream/architecture-0008-3/agent-artifacts/cases",
    ),
  },
] as const;

type PromptMessage = {
  role: string;
  content: string;
};

type Usage = {
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  reasoning_tokens: number | null;
};

type ModelIo = {
  sequence: number;
  role: string;
  model: string;
  reasoning: string;
  prompt_messages: PromptMessage[];
  output_text: string;
  parsed_output: unknown;
  usage: Usage;
  latency_ms: number;
  request_id: string | null;
  retry_count: number;
};

type ModelCall = {
  sequence: number;
  role: string;
  model: string;
  input_sha256: string;
  parameters: {
    temperature: number;
    reasoning_effort: string;
    max_output_tokens: number;
  };
  usage: Usage;
  latency_ms: number;
  request_id: string | null;
  retry_count: number;
};

type Prediction = {
  question_id: string;
  question_type: string;
  generation: {
    text: string;
    model: string;
    provider: string;
    usage: Usage;
    latency_ms: number;
    request_id: string | null;
    retry_count: number;
  };
  model_calls: ModelCall[];
  trace: {
    architecture_id?: string;
    downstream_arm?: string;
  };
};

type OfficialQuestion = {
  question_id: string;
  conversation_id: number;
  ability: string;
  score: number;
  official_metric: string;
};

type OfficialSummary = {
  benchmark: string;
  aggregate: {
    macro_score: number;
    questions: number;
    abilities: Record<string, number>;
  };
  official_scoring_convention: Record<string, string>;
  questions: OfficialQuestion[];
};

type LocatedPrompt = {
  io: ModelIo;
  sourceFile: string;
  sourceLabel: string;
  cohort: string;
};

function readJsonLines<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function promptText(messages: PromptMessage[]): string {
  return messages.map((message) => `<${message.role}>\n${message.content}`).join("\n\n");
}

function abilitySlug(ability: string): string {
  return ability.replaceAll("_", "-");
}

function questionFileName(questionId: string): string {
  const parts = questionId.split("/");
  const chat = parts.at(-3);
  const number = parts.at(-1);
  if (!chat || !number) throw new Error(`Unexpected BEAM question ID: ${questionId}`);
  return `${chat}-question-${number}.md`;
}

function codeFence(content: string): string {
  const runs = content.match(/`+/g) ?? [];
  const longest = runs.reduce((maximum, run) => Math.max(maximum, run.length), 0);
  return "`".repeat(Math.max(4, longest + 1));
}

function fenced(content: string, language = "text"): string {
  const fence = codeFence(content);
  return `${fence}${language}\n${content}\n${fence}`;
}

function locatePrompt(prediction: Prediction): LocatedPrompt {
  const requestId = prediction.generation.request_id;
  if (!requestId) throw new Error(`Missing final request ID: ${prediction.question_id}`);

  const matches: LocatedPrompt[] = [];
  for (const source of SOURCE_ROOTS) {
    const sourceFile = resolve(source.path, prediction.question_id, "model-io.json");
    let entries: ModelIo[];
    try {
      entries = JSON.parse(readFileSync(sourceFile, "utf8")) as ModelIo[];
    } catch {
      continue;
    }
    for (const io of entries) {
      if (io.role !== "answer" || io.request_id !== requestId) continue;
      matches.push({
        io,
        sourceFile,
        sourceLabel: source.label,
        cohort: source.cohort,
      });
    }
  }

  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one captured final prompt for ${prediction.question_id}; found ${String(matches.length)}`,
    );
  }
  const match = matches[0];
  if (!match) throw new Error(`Captured prompt disappeared: ${prediction.question_id}`);
  return match;
}

function renderCase(args: {
  prediction: Prediction;
  official: OfficialQuestion;
  located: LocatedPrompt;
  call: ModelCall;
}): string {
  const { prediction, official, located, call } = args;
  const promptHash = sha256(promptText(located.io.prompt_messages));
  const exactResponse = located.io.output_text === prediction.generation.text;
  const exactRequest = located.io.request_id === prediction.generation.request_id;
  const exactHash = promptHash === call.input_sha256;
  if (!exactResponse || !exactRequest || !exactHash) {
    throw new Error(`Exactness verification failed for ${prediction.question_id}`);
  }

  const lines = [
    `# ${prediction.question_id}`,
    "",
    "## Run record",
    "",
    `- Ability: \`${official.ability}\``,
    `- Official score: **${String(official.score)}**`,
    `- Official metric: \`${official.official_metric}\``,
    `- Prompt source: ${located.sourceLabel}`,
    `- Cohort: ${located.cohort}`,
    `- Architecture: \`${prediction.trace.architecture_id ?? "unknown"}\``,
    `- Model: \`${located.io.model}\``,
    `- Reasoning: \`${located.io.reasoning}\``,
    `- Temperature: \`${String(call.parameters.temperature)}\``,
    `- Maximum output tokens: \`${String(call.parameters.max_output_tokens)}\``,
    `- Captured input tokens: \`${String(located.io.usage.input_tokens)}\``,
    `- Captured output tokens: \`${String(located.io.usage.output_tokens)}\``,
    `- Request ID: \`${located.io.request_id}\``,
    `- Recorded input SHA-256: \`${call.input_sha256}\``,
    `- Source artifact: \`${relative(PROJECT_ROOT, located.sourceFile)}\``,
    "- Exactness checks: **PASS** (request ID, prompt SHA-256, and response all match the merged official run)",
    "",
    "## Exact final-answer prompt",
    "",
    "The message bodies below are copied verbatim from the captured model request. Markdown fences are archival wrappers and were not sent to the model.",
    "",
  ];

  for (let index = 0; index < located.io.prompt_messages.length; index += 1) {
    const message = located.io.prompt_messages[index];
    if (!message) throw new Error(`Missing prompt message ${String(index)}`);
    lines.push(
      `### Message ${String(index + 1)} — ${message.role}`,
      "",
      fenced(message.content),
      "",
    );
  }

  lines.push(
    "## Captured Luna response",
    "",
    "This response is included for diagnosis; it was not part of the prompt.",
    "",
    fenced(located.io.output_text, "json"),
    "",
  );
  return lines.join("\n");
}

function renderReadme(args: {
  summary: OfficialSummary;
  rows: Array<{
    ability: string;
    cohort: string;
    sourceLabel: string;
    inputTokens: number;
  }>;
}): string {
  const { summary, rows } = args;
  const abilities = [...new Set(summary.questions.map((question) => question.ability))].sort();
  const totals = abilities.map((ability) => {
    const abilityRows = rows.filter((row) => row.ability === ability);
    return {
      ability,
      cases: abilityRows.length,
      k81: abilityRows.filter((row) => row.cohort === "K81 regenerated").length,
      inherited: abilityRows.filter((row) => row.cohort === "inherited control").length,
      meanInputTokens:
        abilityRows.reduce((sum, row) => sum + row.inputTokens, 0) / abilityRows.length,
      score: summary.aggregate.abilities[ability],
    };
  });
  const sourceCounts = new Map<string, number>();
  for (const row of rows) {
    sourceCounts.set(row.sourceLabel, (sourceCounts.get(row.sourceLabel) ?? 0) + 1);
  }

  const lines = [
    "# BEAM-1M final Luna prompts — official 74.10% run",
    "",
    "This archive contains one Markdown file for every question in the 100-question official BEAM-1M canary. Each file preserves the exact final `system` and `user` message bodies sent to GPT-5.6 Luna, together with the captured response and official per-question score.",
    "",
    "No prompt was reconstructed from templates. Every file was located by the merged prediction's OpenAI request ID and then verified against the recorded prompt SHA-256 and response text.",
    "",
    "## Run composition",
    "",
    "The 74.10% result was a controlled merge:",
    "",
    "- 78 questions were regenerated by the K=81 raw-session → Luna-high pipeline.",
    "- 22 questions retained their prior best predictions: Architecture 0008 for abstention and two no-gold cases, and the broad-history rerun for event ordering plus one no-gold case.",
    "- All 100 final answer calls used GPT-5.6 Luna with high reasoning; inherited cases may include Nano extraction calls before Luna.",
    `- Official macro score: **${(summary.aggregate.macro_score * 100).toFixed(2)}%**.`,
    "",
    "## Coverage by ability",
    "",
    "| Ability | Files | K=81 regenerated | Inherited control | Mean Luna input tokens | Official ability score |",
    "|---|---:|---:|---:|---:|---:|",
    ...totals.map(
      (row) =>
        `| ${row.ability.replaceAll("_", " ")} | ${String(row.cases)} | ${String(row.k81)} | ${String(row.inherited)} | ${Math.round(row.meanInputTokens).toLocaleString("en-US")} | ${((row.score ?? 0) * 100).toFixed(2)}% |`,
    ),
    "",
    "## Exact source split",
    "",
    ...[...sourceCounts.entries()].map(([source, count]) => `- ${source}: ${String(count)} prompts`),
    "",
    "## Per-question file layout",
    "",
    "Each file records provenance and exactness checks, then contains:",
    "",
    "1. Every final-answer prompt message in request order.",
    "2. The exact captured Luna response (clearly marked as not part of the prompt).",
    "3. The official score and metric for that question.",
    "",
    "The Markdown code fences are only archival wrappers. Text inside each fence is byte-for-byte identical to the captured message content.",
    "",
  ];
  return lines.join("\n");
}

function main(): void {
  const predictions = readJsonLines<Prediction>(MERGED_PREDICTIONS);
  const summary = JSON.parse(readFileSync(OFFICIAL_SUMMARY, "utf8")) as OfficialSummary;
  const officialById = new Map(
    summary.questions.map((question) => [question.question_id, question]),
  );

  if (predictions.length !== 100 || summary.questions.length !== 100) {
    throw new Error(
      `Expected 100 predictions and 100 scores; found ${String(predictions.length)} and ${String(summary.questions.length)}`,
    );
  }

  const abilities = [...new Set(summary.questions.map((question) => question.ability))].sort();
  for (const ability of abilities) {
    mkdirSync(resolve(OUTPUT_ROOT, abilitySlug(ability)), { recursive: true });
  }

  const rows: Array<{
    ability: string;
    cohort: string;
    sourceLabel: string;
    inputTokens: number;
  }> = [];
  const written = new Set<string>();

  for (const prediction of predictions) {
    const official = officialById.get(prediction.question_id);
    if (!official) throw new Error(`Missing official score: ${prediction.question_id}`);
    if (official.ability !== prediction.question_type) {
      throw new Error(
        `Ability mismatch for ${prediction.question_id}: ${official.ability} vs ${prediction.question_type}`,
      );
    }
    const located = locatePrompt(prediction);
    const call = prediction.model_calls.find(
      (candidate) =>
        candidate.role === "answer" && candidate.request_id === prediction.generation.request_id,
    );
    if (!call) throw new Error(`Missing final model call record: ${prediction.question_id}`);
    if (located.io.model !== "gpt-5.6-luna" || located.io.reasoning !== "high") {
      throw new Error(`Unexpected final model configuration: ${prediction.question_id}`);
    }

    const outputPath = resolve(
      OUTPUT_ROOT,
      abilitySlug(official.ability),
      questionFileName(prediction.question_id),
    );
    if (written.has(outputPath)) throw new Error(`Duplicate output path: ${outputPath}`);
    writeFileSync(outputPath, renderCase({ prediction, official, located, call }), "utf8");
    written.add(outputPath);
    rows.push({
      ability: official.ability,
      cohort: located.cohort,
      sourceLabel: located.sourceLabel,
      inputTokens: located.io.usage.input_tokens ?? 0,
    });
  }

  if (written.size !== 100) throw new Error(`Expected 100 files; wrote ${String(written.size)}`);
  writeFileSync(resolve(OUTPUT_ROOT, "README.md"), renderReadme({ summary, rows }), "utf8");

  const manifest = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    benchmark: summary.benchmark,
    official_macro_score: summary.aggregate.macro_score,
    question_count: written.size,
    ability_count: abilities.length,
    exactness_checks: {
      request_id: "100/100 pass",
      prompt_sha256: "100/100 pass",
      response_text: "100/100 pass",
    },
    source_counts: Object.fromEntries(
      [...new Set(rows.map((row) => row.sourceLabel))]
        .sort()
        .map((source) => [source, rows.filter((row) => row.sourceLabel === source).length]),
    ),
  };
  writeFileSync(
    resolve(OUTPUT_ROOT, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        output: relative(PROJECT_ROOT, OUTPUT_ROOT),
        prompts: written.size,
        abilities: abilities.length,
        exactness_checks: "all pass",
      },
      null,
      2,
    )}\n`,
  );
}

main();
