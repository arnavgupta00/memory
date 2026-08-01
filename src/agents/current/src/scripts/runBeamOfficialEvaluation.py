from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


SOURCE_COMMIT = "3e12035532eb85768f1a7cd779832b650c4b2ef9"
JUDGE_MODEL = "gpt-4.1-mini"
OFFICIAL_SOURCE_PATHS = (
    "src/evaluation/run_evaluation.py",
    "src/evaluation/compute_metrics.py",
    "src/evaluation/report_results.py",
    "src/prompts.py",
    "src/llm.py",
    "requirements.txt",
)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git_output(repo: Path, *args: str) -> str:
    return subprocess.check_output(
        ["git", "-C", str(repo), *args], text=True
    ).strip()


def validate_official_repo(repo: Path) -> dict[str, str]:
    if not (repo / ".git").exists():
        raise ValueError("--beam-repo must be an official BEAM git checkout")
    commit = git_output(repo, "rev-parse", "HEAD")
    if commit != SOURCE_COMMIT:
        raise ValueError(
            f"BEAM checkout is at {commit}; exact evaluation requires {SOURCE_COMMIT}"
        )
    dirty = git_output(repo, "status", "--porcelain", "--", *OFFICIAL_SOURCE_PATHS)
    if dirty:
        raise ValueError("official BEAM evaluator sources or requirements are modified")
    missing = [path for path in OFFICIAL_SOURCE_PATHS if not (repo / path).is_file()]
    if missing:
        raise ValueError(f"official BEAM checkout is missing: {', '.join(missing)}")
    llm_source = (repo / "src/llm.py").read_text(encoding="utf-8")
    if f'model_name="{JUDGE_MODEL}"' not in llm_source or "temperature=0" not in llm_source:
        raise ValueError("official judge model/temperature contract is not present at the pin")
    return {path: sha256(repo / path) for path in OFFICIAL_SOURCE_PATHS}


def configure_runtime_copy(
    repo: Path,
    scratch: Path,
    beam_root: Path,
    request_timeout_seconds: float | None = None,
) -> None:
    shutil.copytree(repo / "src", scratch / "src")
    config_path = scratch / "src/llms_config.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("OPENAI_API_KEY is required for the official BEAM judge")
    config["gpt"]["api_key"] = api_key

    # src.llm constructs all three clients at import time although evaluation
    # invokes only gpt_llm. Give the two unused clients valid inert settings so
    # current LangChain versions do not reject empty model fields.
    for unused in ("llama", "qwen"):
        config[unused] = {
            "model_url": "https://api.openai.com/v1",
            "model_name": JUDGE_MODEL,
            "api_key": api_key,
        }
    config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")
    if request_timeout_seconds is not None:
        llm_path = scratch / "src/llm.py"
        llm_source = llm_path.read_text(encoding="utf-8")
        needle = "            temperature=self.temperature,\n            extra_body=self.extra_body\n"
        if needle not in llm_source:
            raise ValueError("unable to install transport timeout in the pinned judge copy")
        llm_source = llm_source.replace(
            needle,
            (
                "            temperature=self.temperature,\n"
                "            extra_body=self.extra_body,\n"
                f"            request_timeout={request_timeout_seconds},\n"
                "            max_retries=6\n"
            ),
            1,
        )
        llm_path.write_text(llm_source, encoding="utf-8")
    chats = scratch / "chats"
    chats.mkdir()
    (chats / "1M").symlink_to(beam_root, target_is_directory=True)


def numeric_result_directories(results: Path) -> list[Path]:
    directories = [path for path in results.iterdir() if path.is_dir() and path.name.isdigit()]
    return sorted(directories, key=lambda path: int(path.name))


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run the exact pinned BEAM evaluator over exported Architecture 0008 answers."
    )
    parser.add_argument("--beam-repo", type=Path, required=True)
    parser.add_argument("--beam-root", type=Path, required=True)
    parser.add_argument("--results", type=Path)
    parser.add_argument("--filename", default="architecture-0008.json")
    parser.add_argument("--max-workers", type=int, default=10)
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument(
        "--event-ordering-only",
        action="store_true",
        help=(
            "Evaluate only the event_ordering entries with the pinned official "
            "implementation. Intended for targeted architecture comparisons."
        ),
    )
    parser.add_argument(
        "--request-timeout-seconds",
        type=float,
        help=(
            "Optional transport-only timeout installed in the temporary judge copy. "
            "The pinned model, prompts, rubrics, and scoring code are unchanged."
        ),
    )
    args = parser.parse_args()

    repo = args.beam_repo.resolve()
    beam_root = args.beam_root.resolve()
    if not (beam_root / "topics.json").is_file():
        raise ValueError("--beam-root must point to the official chats/1M directory")
    source_hashes = validate_official_repo(repo)
    if args.preflight:
        imports = (
            "langchain_openai,nltk,rouge_score,sentence_transformers,scipy,json_repair"
        )
        subprocess.run(
            [args.python, "-c", f"import {imports}"],
            check=True,
        )
        print(json.dumps({
            "status": "ready",
            "official_source_commit": SOURCE_COMMIT,
            "official_source_hashes": source_hashes,
            "judge_model": JUDGE_MODEL,
            "judge_temperature": 0,
            "beam_root": str(beam_root),
        }, indent=2))
        return
    if args.results is None:
        raise ValueError("--results is required unless --preflight is used")
    results = args.results.resolve()
    if not results.is_dir():
        raise ValueError("--results does not exist")
    directories = numeric_result_directories(results)
    if not directories:
        raise ValueError("--results contains no numeric conversation directories")
    for directory in directories:
        if not (directory / args.filename).is_file():
            raise ValueError(f"missing {args.filename} in {directory}")
    if args.max_workers < 1:
        raise ValueError("--max-workers must be positive")

    execution = {
        "schema_version": 1,
        "benchmark": "BEAM",
        "tier": "1M",
        "official_source_commit": SOURCE_COMMIT,
        "official_source_hashes": source_hashes,
        "judge_model": JUDGE_MODEL,
        "judge_temperature": 0,
        "results_directory": str(results),
        "answer_filename": args.filename,
        "conversation_ids": [int(path.name) for path in directories],
        "max_workers": args.max_workers,
        "mode": "event_ordering_only" if args.event_ordering_only else "all_abilities",
        "request_timeout_seconds": args.request_timeout_seconds,
        "status": "running",
    }
    manifest_name = (
        "official-event-ordering-evaluation-manifest.json"
        if args.event_ordering_only
        else "official-evaluation-manifest.json"
    )
    manifest_path = results / manifest_name
    manifest_path.write_text(json.dumps(execution, indent=2) + "\n", encoding="utf-8")

    with tempfile.TemporaryDirectory(prefix="beam-official-evaluator-") as temporary:
        scratch = Path(temporary)
        configure_runtime_copy(
            repo,
            scratch,
            beam_root,
            request_timeout_seconds=args.request_timeout_seconds,
        )
        evaluation_results = results
        if args.event_ordering_only:
            evaluation_results = scratch / "event-ordering-results"
            evaluation_results.mkdir()
            for directory in directories:
                target = evaluation_results / directory.name
                target.mkdir()
                source = json.loads((directory / args.filename).read_text(encoding="utf-8"))
                if "event_ordering" not in source:
                    raise ValueError(f"{directory / args.filename} has no event_ordering entries")
                (target / args.filename).write_text(
                    json.dumps({"event_ordering": source["event_ordering"]}, indent=2) + "\n",
                    encoding="utf-8",
                )
        command = [
            args.python,
            "-m",
            "src.evaluation.run_evaluation",
            "--input_directory",
            str(evaluation_results),
            "--chat_size",
            "1M",
            "--start_index",
            "0",
            "--end_index",
            str(len(directories)),
            "--max_workers",
            str(args.max_workers),
            "--allowed_result_files",
            args.filename,
        ]
        env = dict(os.environ)
        env["PYTHONPATH"] = str(scratch)
        completed = subprocess.run(command, cwd=scratch, env=env, check=False)
        execution["exit_code"] = completed.returncode
        execution["status"] = "completed" if completed.returncode == 0 else "failed"
        if completed.returncode == 0 and args.event_ordering_only:
            for directory in directories:
                source = (
                    evaluation_results
                    / directory.name
                    / f"evaluation-{args.filename}"
                )
                destination = directory / f"evaluation-event-ordering-{args.filename}"
                shutil.copy2(source, destination)
        manifest_path.write_text(json.dumps(execution, indent=2) + "\n", encoding="utf-8")
        if completed.returncode != 0:
            raise subprocess.CalledProcessError(completed.returncode, command)


if __name__ == "__main__":
    main()
