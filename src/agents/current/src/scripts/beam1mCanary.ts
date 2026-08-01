import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import {
  BROAD_HISTORY_RETRIEVAL_PROFILE,
  FOCUSED_RETRIEVAL_PROFILE,
} from "../retrieval/retrievalProfile.js";

const CURRENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PROJECT_ROOT = resolve(CURRENT_ROOT, "../../..");
const SCRIPT_ROOT = resolve(CURRENT_ROOT, "src/scripts");
const DEFAULT_MANIFEST = resolve(
  CURRENT_ROOT,
  "eval-slices/beam-1m/beam-1m-canary-a-development-v1.json",
);
const DEFAULT_JUDGE_PYTHON = resolve(PROJECT_ROOT, "runs/.beam-official-judge-venv/bin/python");
const DEFAULT_BEAM_REPO = resolve(PROJECT_ROOT, "runs/.beam-official-source");
const STAGES = [
  "preflight",
  "prepare",
  "ingest",
  "retrieve",
  "answer",
  "export",
  "judge",
  "summarize",
] as const;
type Stage = (typeof STAGES)[number];

function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals <= 0) continue;
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

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

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function commandForTypeScript(script: string, args: string[]): [string, string[]] {
  return [process.execPath, ["--import", "tsx", resolve(SCRIPT_ROOT, script), ...args]];
}

async function runCommand(args: {
  stage: Stage;
  command: string;
  commandArgs: string[];
  logDir: string;
}): Promise<void> {
  mkdirSync(args.logDir, { recursive: true });
  const log = createWriteStream(resolve(args.logDir, `${args.stage}.log`), { flags: "a" });
  const printable = [args.command, ...args.commandArgs].join(" ");
  log.write(`\n$ ${printable}\n`);
  console.log(JSON.stringify({ event: "stage_start", stage: args.stage }));
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(args.command, args.commandArgs, {
      cwd: CURRENT_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      log.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      log.write(chunk);
    });
    child.on("error", rejectRun);
    child.on("close", (code) => {
      log.end();
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${args.stage} exited with code ${String(code)}`));
    });
  });
  console.log(JSON.stringify({ event: "stage_complete", stage: args.stage }));
}

function required(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

async function main(): Promise<void> {
  loadDotEnv(resolve(PROJECT_ROOT, ".env"));
  const args = parseArgs(process.argv.slice(2));
  const stageArg = args.stage ?? "all";
  if (stageArg !== "all" && !STAGES.includes(stageArg as Stage)) {
    throw new Error(`--stage must be all or one of ${STAGES.join(", ")}`);
  }
  const stages: Stage[] = stageArg === "all" ? [...STAGES] : [stageArg as Stage];
  const beamRoot = resolve(PROJECT_ROOT, required(args["beam-root"], "--beam-root"));
  const beamRepo = args["beam-repo"]
    ? resolve(PROJECT_ROOT, args["beam-repo"])
    : existsSync(DEFAULT_BEAM_REPO)
      ? DEFAULT_BEAM_REPO
      : null;
  const manifest = resolve(args.manifest ?? DEFAULT_MANIFEST);
  const runRoot = resolve(
    PROJECT_ROOT,
    args.out ?? `runs/beam-1m-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`,
  );
  const inputDir = resolve(runRoot, "input");
  const annotationsDir = resolve(runRoot, "annotations");
  const logsDir = resolve(runRoot, "logs");
  const retrievalPath = resolve(runRoot, "retrieval/hybrid.json");
  const retrievalCases = resolve(runRoot, "traces/retrieval/cases");
  const downstreamDir = resolve(runRoot, "downstream");
  const downstreamRun = resolve(downstreamDir, "architecture-0008-3");
  const officialResults = resolve(runRoot, "official-results");
  const concurrency = args.concurrency ?? "128";
  const ingestConcurrency = args["ingest-concurrency"] ?? "256";
  const tokenBudget = args["token-budget"] ?? "1900000";
  const judgeWorkers = args["judge-workers"] ?? "10";
  const python = args.python ?? (existsSync(DEFAULT_JUDGE_PYTHON) ? DEFAULT_JUDGE_PYTHON : "python3");

  if (stageArg === "all" && existsSync(runRoot)) {
    throw new Error(`fresh full runs require a new --out path; already exists: ${runRoot}`);
  }
  if ((stages.includes("preflight") || stages.includes("judge")) && !beamRepo) {
    throw new Error("--beam-repo is required for preflight/judge/all");
  }
  mkdirSync(runRoot, { recursive: true });
  const runManifestPath = resolve(runRoot, "run-manifest.json");
  const freshRunManifest: Record<string, unknown> = {
    schema_version: 1,
    benchmark: "BEAM",
    tier: "1M",
    architecture: "0008",
    status: "running",
    created_at: new Date().toISOString(),
    requested_stages: stages,
    canary_manifest: manifest,
    canary_manifest_sha256: sha256(manifest),
    beam_root: beamRoot,
    strict_transfer: true,
    shared_architecture: {
      storer_model: "gpt-5.4-nano-2026-03-17",
      planner_and_admission_model: "gpt-5.6-luna",
      planner_and_admission_reasoning: "low",
      reader_model: "gpt-5.4-nano-2026-03-17",
      reader_reasoning: "low",
      answer_model: "gpt-5.6-luna",
      answer_reasoning: "high",
      retrieval_profiles: {
        focused: FOCUSED_RETRIEVAL_PROFILE,
        broad_history: BROAD_HISTORY_RETRIEVAL_PROFILE,
      },
      package_max_turns: 40,
      package_max_characters: 40000,
    },
    rate_limit: {
      token_budget_per_minute: Number(tokenBudget),
      question_concurrency: Number(concurrency),
      ingestion_concurrency: Number(ingestConcurrency),
    },
    judge: {
      implementation: "official pinned BEAM evaluator",
      source_commit: "3e12035532eb85768f1a7cd779832b650c4b2ef9",
      model: "gpt-4.1-mini",
      temperature: 0,
    },
  };
  const resuming = stageArg !== "all" && existsSync(runManifestPath);
  const runManifest: Record<string, unknown> = resuming
    ? JSON.parse(readFileSync(runManifestPath, "utf8")) as Record<string, unknown>
    : freshRunManifest;
  if (resuming) {
    const history: unknown[] = Array.isArray(runManifest.stage_history)
      ? runManifest.stage_history as unknown[]
      : [];
    runManifest.stage_history = [
      ...history,
      { stages, started_at: new Date().toISOString(), status: "running" },
    ];
    runManifest.status = "running";
    delete runManifest.error;
    delete runManifest.failed_at;
  }
  writeFileSync(runManifestPath, `${JSON.stringify(runManifest, null, 2)}\n`);

  const commands = new Map<Stage, [string, string[]]>([
    ["preflight", [python, [
      resolve(SCRIPT_ROOT, "runBeamOfficialEvaluation.py"),
      "--beam-repo", beamRepo ?? "",
      "--beam-root", beamRoot,
      "--python", python,
      "--preflight",
    ]]],
    ["prepare", commandForTypeScript("prepareBeam1m.ts", [
      "--beam-root", beamRoot,
      "--manifest", manifest,
      "--out", inputDir,
      "--allow-official-parquet-reencoding", "true",
    ])],
    ["ingest", commandForTypeScript("sessionAnnotate.ts", [
      "--ids", resolve(inputDir, "slice.json"),
      "--slice", "all",
      "--dataset", resolve(inputDir, "dataset.json"),
      "--oracle", resolve(inputDir, "oracle.json"),
      "--cache", annotationsDir,
      "--audit-dir", resolve(runRoot, "traces/ingestion"),
      "--model", "gpt-5.4-nano-2026-03-17",
      "--concurrency", ingestConcurrency,
      "--token-budget", tokenBudget,
    ])],
    ["retrieve", commandForTypeScript("hopArchitectureScreen.ts", [
      "--arm", "hybrid",
      "--ids", resolve(inputDir, "slice.json"),
      "--dataset", resolve(inputDir, "dataset.json"),
      "--oracle", resolve(inputDir, "oracle.json"),
      "--annotations", annotationsDir,
      "--model", "gpt-5.6-luna",
      "--reasoning", "low",
      "--concurrency", concurrency,
      "--token-budget", tokenBudget,
      "--case-artifacts", retrievalCases,
      "--out", retrievalPath,
    ])],
    ["answer", commandForTypeScript("hopBagDownstreamGate.ts", [
      "--hop-run", retrievalPath,
      "--out-prefix", "architecture-0008",
      "--arms", "3",
      "--dataset", resolve(inputDir, "dataset.json"),
      "--oracle", resolve(inputDir, "oracle.json"),
      "--annotations", annotationsDir,
      "--runs-dir", downstreamDir,
      "--benchmark", "BEAM-1M",
      "--reader-model", "gpt-5.4-nano-2026-03-17",
      "--reader-reasoning", "low",
      "--answer-model", "gpt-5.6-luna",
      "--answer-reasoning", "high",
      "--concurrency", concurrency,
      "--token-budget", tokenBudget,
      "--capture-model-io", "true",
    ])],
    ["export", commandForTypeScript("exportBeam1mAnswers.ts", [
      "--manifest", manifest,
      "--beam-root", beamRoot,
      "--predictions", resolve(downstreamRun, "predictions.jsonl"),
      "--out", officialResults,
      "--filename", "architecture-0008.json",
    ])],
    ["judge", [python, [
      resolve(SCRIPT_ROOT, "runBeamOfficialEvaluation.py"),
      "--beam-repo", beamRepo ?? "",
      "--beam-root", beamRoot,
      "--results", officialResults,
      "--filename", "architecture-0008.json",
      "--max-workers", judgeWorkers,
      "--python", python,
    ]]],
    ["summarize", commandForTypeScript("summarizeBeam1mEvaluation.ts", [
      "--manifest", manifest,
      "--results", officialResults,
      "--filename", "architecture-0008.json",
      "--out", resolve(runRoot, "beam-official-summary.json"),
    ])],
  ]);

  try {
    for (const stage of stages) {
      const command = commands.get(stage);
      if (!command) throw new Error(`missing command for ${stage}`);
      await runCommand({
        stage,
        command: command[0],
        commandArgs: command[1],
        logDir: logsDir,
      });
    }
    runManifest.status = stageArg === "summarize" || stageArg === "all"
      ? "completed"
      : "partial";
    runManifest.updated_at = new Date().toISOString();
    if (runManifest.status === "completed") {
      runManifest.completed_at = runManifest.updated_at;
    }
    const history = runManifest.stage_history;
    if (Array.isArray(history) && history.length > 0) {
      const last: unknown = (history as unknown[])[history.length - 1];
      if (last && typeof last === "object") {
        Object.assign(last, { status: "completed", completed_at: runManifest.updated_at });
      }
    }
  } catch (error) {
    runManifest.status = "failed";
    runManifest.failed_at = new Date().toISOString();
    runManifest.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    writeFileSync(runManifestPath, `${JSON.stringify(runManifest, null, 2)}\n`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
