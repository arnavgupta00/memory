from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from typing import Any, Callable


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


def load_dotenv(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        os.environ.setdefault(key.strip(), value)


def validate_official_repo(repo: Path) -> dict[str, str]:
    commit = subprocess.check_output(
        ["git", "-C", str(repo), "rev-parse", "HEAD"], text=True
    ).strip()
    if commit != SOURCE_COMMIT:
        raise ValueError(f"official BEAM checkout is at {commit}, expected {SOURCE_COMMIT}")
    dirty = subprocess.check_output(
        ["git", "-C", str(repo), "status", "--porcelain", "--", *OFFICIAL_SOURCE_PATHS],
        text=True,
    ).strip()
    if dirty:
        raise ValueError("official BEAM evaluator sources are modified")
    missing = [path for path in OFFICIAL_SOURCE_PATHS if not (repo / path).is_file()]
    if missing:
        raise ValueError(f"official BEAM checkout is missing: {', '.join(missing)}")
    llm_source = (repo / "src/llm.py").read_text(encoding="utf-8")
    if f'model_name="{JUDGE_MODEL}"' not in llm_source or "temperature=0" not in llm_source:
        raise ValueError("official judge model/temperature contract is absent")
    return {path: sha256(repo / path) for path in OFFICIAL_SOURCE_PATHS}


def configure_runtime_copy(repo: Path, scratch: Path) -> None:
    shutil.copytree(repo / "src", scratch / "src")
    config_path = scratch / "src/llms_config.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("OPENAI_API_KEY is required")
    config["gpt"]["api_key"] = api_key
    for unused in ("llama", "qwen"):
        config[unused] = {
            "model_url": "https://api.openai.com/v1",
            "model_name": JUDGE_MODEL,
            "api_key": api_key,
        }
    config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")


def load_predictions(path: Path) -> dict[str, str]:
    predictions: dict[str, str] = {}
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        row = json.loads(line)
        question_id = row.get("question_id")
        hypothesis = row.get("hypothesis")
        if not isinstance(question_id, str) or not isinstance(hypothesis, str):
            raise ValueError(f"{path}:{line_number} lacks question_id or hypothesis")
        predictions[question_id] = hypothesis
    return predictions


def parse_question_id(question_id: str) -> tuple[int, str, int]:
    parts = question_id.split("/")
    if len(parts) != 4 or parts[0] != "beam-1m" or not parts[1].startswith("chat-"):
        raise ValueError(f"invalid BEAM question id: {question_id}")
    return int(parts[1].removeprefix("chat-")), parts[2], int(parts[3])


def score_from_result(ability: str, result: dict[str, Any]) -> float:
    field = "tau_norm" if ability == "event_ordering" else "llm_judge_score"
    score = result.get(field)
    if not isinstance(score, (int, float)):
        raise ValueError(f"official result for {ability} lacks {field}")
    return float(score)


def main() -> None:
    parser = argparse.ArgumentParser(description="Score a targeted paired BEAM answer A/B with pinned official functions.")
    parser.add_argument("--beam-repo", type=Path, required=True)
    parser.add_argument("--beam-root", type=Path, required=True)
    parser.add_argument("--raw-predictions", type=Path, required=True)
    parser.add_argument("--explorer-predictions", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--max-workers", type=int, default=16)
    args = parser.parse_args()

    project_root = Path(__file__).resolve().parents[5]
    load_dotenv(project_root / ".env")
    repo = args.beam_repo.resolve()
    beam_root = args.beam_root.resolve()
    source_hashes = validate_official_repo(repo)
    arms = {
        "raw-union": load_predictions(args.raw_predictions.resolve()),
        "coverage-explorer": load_predictions(args.explorer_predictions.resolve()),
    }
    question_ids = list(arms["raw-union"].keys())
    if set(question_ids) != set(arms["coverage-explorer"].keys()):
        raise ValueError("paired prediction files contain different question IDs")
    if not 5 <= len(question_ids) <= 10:
        raise ValueError("targeted comparison must contain 5-10 questions")
    args.out.parent.mkdir(parents=True, exist_ok=True)

    execution: dict[str, Any] = {
        "schema_version": 1,
        "benchmark": "BEAM",
        "tier": "1M",
        "official_source_commit": SOURCE_COMMIT,
        "official_source_hashes": source_hashes,
        "judge_model": JUDGE_MODEL,
        "judge_temperature": 0,
        "questions": len(question_ids),
        "status": "running",
        "rows": [],
    }
    args.out.write_text(json.dumps(execution, indent=2) + "\n", encoding="utf-8")

    with tempfile.TemporaryDirectory(prefix="beam-targeted-official-") as temporary:
        scratch = Path(temporary)
        configure_runtime_copy(repo, scratch)
        sys.path.insert(0, str(scratch))
        from src.evaluation.compute_metrics import (  # type: ignore[import-not-found]
            evaluate_multi_session_reasoning,
            evaluate_summarization,
            initialize_models,
        )
        from src.llm import gpt_llm  # type: ignore[import-not-found]

        evaluators: dict[str, Callable[..., dict[str, Any]]] = {
            "summarization": evaluate_summarization,
            "multi_session_reasoning": evaluate_multi_session_reasoning,
        }
        initialize_models()

        def evaluate(arm: str, question_id: str) -> dict[str, Any]:
            conversation_id, ability, one_based_index = parse_question_id(question_id)
            evaluator = evaluators.get(ability)
            if evaluator is None:
                raise ValueError(f"unsupported targeted ability: {ability}")
            probe_path = beam_root / str(conversation_id) / "probing_questions/probing_questions.json"
            probes = json.loads(probe_path.read_text(encoding="utf-8"))
            probe = probes[ability][one_based_index - 1]
            result = evaluator(
                rubric=probe["rubric"],
                llm_response=arms[arm][question_id],
                probing_question=probe["question"],
                model=gpt_llm,
            )
            return {
                "arm": arm,
                "question_id": question_id,
                "ability": ability,
                "rubric_items": len(probe["rubric"]),
                "score": score_from_result(ability, result),
                "official_result": result,
            }

        tasks = [(arm, question_id) for question_id in question_ids for arm in arms]
        rows: list[dict[str, Any]] = []
        with ThreadPoolExecutor(max_workers=args.max_workers) as executor:
            futures = {executor.submit(evaluate, arm, question_id): (arm, question_id) for arm, question_id in tasks}
            for future in as_completed(futures):
                row = future.result()
                rows.append(row)
                execution["rows"] = sorted(rows, key=lambda item: (item["question_id"], item["arm"]))
                args.out.write_text(json.dumps(execution, indent=2) + "\n", encoding="utf-8")
                print(json.dumps({
                    "event": "beam_targeted_official_score",
                    "arm": row["arm"],
                    "question_id": row["question_id"],
                    "score": row["score"],
                }))

    by_arm = {
        arm: [row["score"] for row in execution["rows"] if row["arm"] == arm]
        for arm in arms
    }
    paired = []
    wins = {"raw-union": 0, "coverage-explorer": 0, "ties": 0}
    for question_id in question_ids:
        scores = {
            arm: next(row["score"] for row in execution["rows"] if row["arm"] == arm and row["question_id"] == question_id)
            for arm in arms
        }
        delta = scores["coverage-explorer"] - scores["raw-union"]
        if delta > 0:
            wins["coverage-explorer"] += 1
        elif delta < 0:
            wins["raw-union"] += 1
        else:
            wins["ties"] += 1
        paired.append({"question_id": question_id, **scores, "explorer_delta": delta})
    execution["aggregate"] = {
        "arms": {
            arm: {
                "questions": len(scores),
                "mean_score": sum(scores) / len(scores),
            }
            for arm, scores in by_arm.items()
        },
        "paired": wins,
        "cases": paired,
    }
    execution["status"] = "completed"
    args.out.write_text(json.dumps(execution, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(execution["aggregate"], indent=2))


if __name__ == "__main__":
    main()
