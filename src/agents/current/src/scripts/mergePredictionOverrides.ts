/** Merge one or more JSONL prediction override files onto a complete baseline. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

type Prediction = { question_id: string } & Record<string, unknown>;

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!argument?.startsWith("--") || !value || value.startsWith("--")) continue;
    result[argument.slice(2)] = value;
    index += 1;
  }
  return result;
}

function load(path: string): Prediction[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      const value = JSON.parse(line) as Partial<Prediction>;
      if (typeof value.question_id !== "string") {
        throw new Error(`${path}:${String(index + 1)} is missing question_id`);
      }
      return value as Prediction;
    });
}

const args = parseArgs(process.argv.slice(2));
if (!args.base || !args.overrides || !args.out) {
  throw new Error("--base, --overrides (comma-separated), and --out are required");
}
const baseline = load(resolve(args.base));
const baselineIds = new Set(baseline.map((item) => item.question_id));
if (baselineIds.size !== baseline.length) throw new Error("baseline contains duplicate IDs");
const replacements = new Map<string, Prediction>();
for (const path of args.overrides.split(",")) {
  for (const item of load(resolve(path))) {
    if (!baselineIds.has(item.question_id)) {
      throw new Error(`override is outside baseline: ${item.question_id}`);
    }
    replacements.set(item.question_id, item);
  }
}
const merged = baseline.map((item) => replacements.get(item.question_id) ?? item);
const outputPath = resolve(args.out);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${merged.map((item) => JSON.stringify(item)).join("\n")}\n`);
console.log(JSON.stringify({ baseline: baseline.length, overrides: replacements.size, out: outputPath }));
