import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type CaseResult = {
  question_id: string;
  stratum: string;
  question_type: string;
  bag: string[];
  candidate_pool: string[];
  full_gold_in_bag: boolean;
  candidate_pool_full_gold: boolean;
  gold_recall: number;
  candidate_pool_gold_recall: number;
  error?: string;
};

type Run = {
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    api_calls: number;
    estimated_cost_usd: number;
    elapsed_ms: number;
  };
  cases: CaseResult[];
  [key: string]: unknown;
};

function parseArgs(argv: string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith("--")) continue;
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      output[key] = "true";
    } else {
      output[key] = value;
      index += 1;
    }
  }
  return output;
}

function summarize(cases: CaseResult[]): Record<string, unknown> {
  const groups: Record<string, CaseResult[]> = { all: cases };
  const byType: Record<string, CaseResult[]> = {};
  for (const item of cases) {
    (groups[item.stratum] ??= []).push(item);
    (byType[item.question_type] ??= []).push(item);
  }
  const one = (items: CaseResult[]): Record<string, number> => ({
    n: items.length,
    full_gold_in_bag: items.filter((item) => item.full_gold_in_bag).length,
    candidate_pool_full_gold:
      items.filter((item) => item.candidate_pool_full_gold).length,
    mean_gold_recall:
      items.reduce((sum, item) => sum + item.gold_recall, 0) / items.length,
    mean_candidate_pool_gold_recall:
      items.reduce((sum, item) => sum + item.candidate_pool_gold_recall, 0)
      / items.length,
    mean_bag_size:
      items.reduce((sum, item) => sum + item.bag.length, 0) / items.length,
    mean_pool_size:
      items.reduce((sum, item) => sum + item.candidate_pool.length, 0)
      / items.length,
    errors: items.filter((item) => item.error).length,
  });
  return {
    ...Object.fromEntries(
      Object.entries(groups).map(([name, items]) => [name, one(items)]),
    ),
    by_question_type: Object.fromEntries(
      Object.entries(byType)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, items]) => [name, one(items)]),
    ),
  };
}

function replaceUnpairedSurrogates(value: string): {
  value: string;
  replacements: number;
} {
  let output = "";
  let replacements = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += value.charAt(index) + value.charAt(index + 1);
        index += 1;
      } else {
        output += "\ufffd";
        replacements += 1;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      output += "\ufffd";
      replacements += 1;
    } else {
      output += value.charAt(index);
    }
  }
  return { value: output, replacements };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.base || !args.repairs || !args.out) {
    throw new Error("--base, --repairs, and --out are required");
  }
  const basePath = resolve(args.base);
  const repairPaths = args.repairs.split(",").map((path) => resolve(path.trim()));
  const outPath = resolve(args.out);
  const base = JSON.parse(readFileSync(basePath, "utf8")) as Run;
  const repairs = repairPaths.map(
    (path) => JSON.parse(readFileSync(path, "utf8")) as Run,
  );
  const byId = new Map(base.cases.map((item) => [item.question_id, item]));
  for (const repair of repairs) {
    for (const item of repair.cases) {
      if (!byId.has(item.question_id)) {
        throw new Error(`repair contains unknown question ID ${item.question_id}`);
      }
      byId.set(item.question_id, item);
    }
  }
  const cases = base.cases.map((item) => {
    const merged = byId.get(item.question_id);
    if (!merged) throw new Error(`merge lost ${item.question_id}`);
    return merged;
  });
  if (cases.length !== 500 || new Set(cases.map((item) => item.question_id)).size !== 500) {
    throw new Error("merged retrieval must contain exactly 500 unique cases");
  }
  if (cases.some((item) => item.error)) {
    throw new Error("merged retrieval still contains errors");
  }
  const inputTokens =
    base.usage.input_tokens
    + repairs.reduce((sum, run) => sum + run.usage.input_tokens, 0);
  const outputTokens =
    base.usage.output_tokens
    + repairs.reduce((sum, run) => sum + run.usage.output_tokens, 0);
  const payload = {
    ...base,
    created_at: new Date().toISOString(),
    repair_sources: repairPaths,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      api_calls:
        base.usage.api_calls
        + repairs.reduce((sum, run) => sum + run.usage.api_calls, 0),
      estimated_cost_usd: (inputTokens + outputTokens * 6) / 1_000_000,
      elapsed_ms:
        base.usage.elapsed_ms
        + repairs.reduce((sum, run) => sum + run.usage.elapsed_ms, 0),
    },
    aggregate: summarize(cases),
    cases,
  };
  let unicodeReplacements = 0;
  const serialized = JSON.stringify(payload, (_key, value: unknown) => {
    if (typeof value !== "string") return value;
    const sanitized = replaceUnpairedSurrogates(value);
    unicodeReplacements += sanitized.replacements;
    return sanitized.value;
  }, 2);
  writeFileSync(outPath, `${serialized}\n`);
  console.log(`wrote ${outPath}`);
  console.log(JSON.stringify({
    usage: payload.usage,
    aggregate: payload.aggregate,
    unicode_replacements: unicodeReplacements,
  }, null, 2));
}

main();
