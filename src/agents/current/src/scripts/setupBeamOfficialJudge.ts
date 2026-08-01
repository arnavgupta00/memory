import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const CURRENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PROJECT_ROOT = resolve(CURRENT_ROOT, "../../..");
const DEFAULT_ENVIRONMENT = resolve(PROJECT_ROOT, "runs/.beam-official-judge-venv");
const DEFAULT_SOURCE = resolve(PROJECT_ROOT, "runs/.beam-official-source");
const REQUIREMENTS = resolve(CURRENT_ROOT, "requirements-beam-official-evaluator.txt");
const SOURCE_REPOSITORY = "https://github.com/mohammadtavakoli78/BEAM.git";
const SOURCE_COMMIT = "3e12035532eb85768f1a7cd779832b650c4b2ef9";

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

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: PROJECT_ROOT, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${String(result.status)}`);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const environment = resolve(args.out ?? DEFAULT_ENVIRONMENT);
  const source = resolve(args.source ?? DEFAULT_SOURCE);
  const pythonVersion = args.python ?? "3.12";
  const python = resolve(environment, "bin/python");
  if (!existsSync(resolve(source, ".git"))) {
    run("git", ["clone", "--quiet", "--filter=blob:none", "--no-checkout", SOURCE_REPOSITORY, source]);
    run("git", ["-C", source, "sparse-checkout", "init", "--cone"]);
    run("git", ["-C", source, "sparse-checkout", "set", "src", "requirements.txt", "README.md"]);
    run("git", ["-C", source, "checkout", "--quiet", "--detach", SOURCE_COMMIT]);
  }
  if (!existsSync(python)) {
    run("uv", ["venv", "--python", pythonVersion, environment]);
  }
  run("uv", ["pip", "install", "--python", python, "--requirement", REQUIREMENTS]);
  console.log(JSON.stringify({
    environment,
    python,
    requirements: REQUIREMENTS,
    official_source: source,
    official_source_commit: SOURCE_COMMIT,
  }, null, 2));
}

main();
