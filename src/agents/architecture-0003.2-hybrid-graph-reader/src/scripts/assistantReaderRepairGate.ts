import { resolve } from "node:path";

import { runAssistantReaderRepairGate } from "../services/assistantReaderRepairGate.js";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`missing required argument: ${name}`);
  return value;
}

function optionalArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function sourceRunPath(value: string): string {
  const direct = resolve(value);
  if (value.includes("/") || value.startsWith(".")) return direct;
  return resolve("runs", value);
}

const abstentionCaseIds = optionalArgument("--abstention-case-ids")?.split(",");
const result = await runAssistantReaderRepairGate({
  sourceRun: sourceRunPath(argument("--source-run")),
  dataset: resolve(
    process.argv.includes("--dataset")
      ? argument("--dataset")
      : "data/raw/longmemeval_s_cleaned.json",
  ),
  output: resolve(argument("--output")),
  caseIds: argument("--case-ids").split(","),
  ...(abstentionCaseIds === undefined ? {} : { abstentionCaseIds }),
});

process.stdout.write(
  `${JSON.stringify({
    verdict: result.verdict,
    metrics: result.report.metrics,
    checks: result.report.checks,
  }, null, 2)}\n`,
);
if (result.verdict !== "passed") process.exitCode = 1;
