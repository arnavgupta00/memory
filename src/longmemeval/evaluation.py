from __future__ import annotations

import os
import shutil
import subprocess
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

from longmemeval.constants import (
    CACHE_DIR,
    CANONICAL_JUDGE_MODEL,
    DATA_DIR,
    EVALUATOR_FILE,
    LONGMEMEVAL_ORACLE_FILE,
    PROJECT_ROOT,
    QUESTION_TYPES,
)
from longmemeval.data import load_cases, verify_data
from longmemeval.runner import resolve_run_path, write_official_predictions
from longmemeval.utils import read_json, read_jsonl, utc_now, write_json


def judge_run(run_id: str) -> Path:
    if not os.getenv("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY is required for canonical judging")
    verify_data()
    run_path = resolve_run_path(run_id)
    manifest_path = run_path / "manifest.json"
    manifest = read_json(manifest_path)
    if manifest.get("status") != "completed":
        raise ValueError("run must be complete before judging")

    prediction_path = write_official_predictions(run_path)
    evaluator = CACHE_DIR / EVALUATOR_FILE
    reference = DATA_DIR / LONGMEMEVAL_ORACLE_FILE
    generated = Path(str(prediction_path) + ".eval-results-gpt-4o")
    command = [sys.executable, str(evaluator), "gpt-4o", str(prediction_path), str(reference)]
    completed = subprocess.run(
        command,
        cwd=PROJECT_ROOT,
        env=os.environ.copy(),
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        tail = "\n".join((completed.stderr or completed.stdout).splitlines()[-20:])
        raise RuntimeError(f"canonical evaluator failed:\n{tail}")
    if not generated.exists():
        raise RuntimeError("canonical evaluator did not produce an output file")
    judgments = run_path / "judgments.jsonl"
    shutil.copyfile(generated, judgments)
    generated.unlink()
    prediction_path.unlink()

    judged = read_jsonl(judgments)
    expected = manifest["selected_count"]
    if len(judged) != expected:
        raise ValueError(f"expected {expected} judgments, found {len(judged)}")
    manifest["judging"] = {
        "provider": "openai",
        "model": CANONICAL_JUDGE_MODEL,
        "temperature": 0,
        "upstream_evaluator": EVALUATOR_FILE,
        "completed_at": utc_now(),
        "count": len(judged),
    }
    manifest["updated_at"] = utc_now()
    write_json(manifest_path, manifest)
    return judgments


def _judgment_label(entry: dict[str, Any]) -> bool:
    label = entry.get("autoeval_label")
    if not isinstance(label, dict) or label.get("model") != CANONICAL_JUDGE_MODEL:
        raise ValueError("judgment is missing the canonical evaluator label")
    value = label.get("label")
    if not isinstance(value, bool):
        raise ValueError("canonical evaluator label must be boolean")
    return value


def build_report(run_id: str) -> dict[str, Any]:
    run_path = resolve_run_path(run_id)
    manifest = read_json(run_path / "manifest.json")
    predictions = read_jsonl(run_path / "predictions.jsonl")
    judgments = read_jsonl(run_path / "judgments.jsonl")
    if not judgments:
        raise ValueError("run has not been judged")
    if len({item["question_id"] for item in judgments}) != len(judgments):
        raise ValueError("judgments contain duplicate question IDs")

    references = {case.question_id: case for case in load_cases(DATA_DIR / LONGMEMEVAL_ORACLE_FILE)}
    by_type: dict[str, list[bool]] = defaultdict(list)
    abstention: list[bool] = []
    all_labels: list[bool] = []
    for entry in judgments:
        question_id = entry["question_id"]
        if question_id not in references:
            raise ValueError(f"unknown judged question ID: {question_id}")
        label = _judgment_label(entry)
        question_type = references[question_id].question_type
        by_type[question_type].append(label)
        all_labels.append(label)
        if question_id.endswith("_abs"):
            abstention.append(label)

    per_type = {
        name: {
            "accuracy": sum(values) / len(values) if values else None,
            "correct": sum(values),
            "count": len(values),
        }
        for name in sorted(QUESTION_TYPES)
        if (values := by_type.get(name, []))
    }
    type_accuracies = [sum(values) / len(values) for values in by_type.values() if values]
    canary_estimate = _canary_estimate(manifest, judgments, references)

    input_tokens = 0
    output_tokens = 0
    total_tokens = 0
    latency_ms = 0.0
    usage_records = 0
    for item in predictions:
        generation = item.get("generation") or {}
        usage = generation.get("usage") or {}
        input_tokens += usage.get("input_tokens") or 0
        output_tokens += usage.get("output_tokens") or 0
        total_tokens += usage.get("total_tokens") or 0
        latency_ms += generation.get("latency_ms") or 0.0
        if generation:
            usage_records += 1

    report = {
        "schema_version": 1,
        "run_id": run_id,
        "generated_at": utc_now(),
        "status": manifest["status"],
        "mode": manifest["dataset_mode"],
        "answer_provider": manifest["config"]["answer"]["provider"],
        "answer_model": manifest["config"]["answer"]["model"],
        "judge_model": CANONICAL_JUDGE_MODEL,
        "overall_accuracy": sum(all_labels) / len(all_labels),
        "task_averaged_accuracy": sum(type_accuracies) / len(type_accuracies),
        "per_question_type": per_type,
        "abstention_accuracy": sum(abstention) / len(abstention) if abstention else None,
        "abstention_count": len(abstention),
        "canary_estimate": canary_estimate,
        "completed_count": len(predictions),
        "judged_count": len(judgments),
        "failure_count": manifest.get("failure_count", 0),
        "usage": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": total_tokens,
            "answer_latency_ms": latency_ms,
            "mean_answer_latency_ms": latency_ms / usage_records if usage_records else None,
        },
        "cost": {
            "currency": "USD",
            "input_unit_price_per_million": manifest["config"]["answer"].get(
                "input_price_per_million"
            ),
            "output_unit_price_per_million": manifest["config"]["answer"].get(
                "output_price_per_million"
            ),
            "estimated_total": _estimated_cost(manifest, input_tokens, output_tokens),
            "note": "Prices are user-supplied run-date inputs; model aliases and prices change.",
        },
    }
    write_json(run_path / "report.json", report)
    return report


def _canary_estimate(
    manifest: dict[str, Any],
    judgments: list[dict[str, Any]],
    references: dict[str, Any],
) -> dict[str, Any] | None:
    selection = manifest.get("selection") or {}
    if not selection.get("is_canary"):
        return None
    strata = selection.get("strata")
    population_count = selection.get("population_count")
    if not isinstance(strata, list) or not isinstance(population_count, int):
        raise ValueError("canary run is missing its frozen stratum metadata")

    labels_by_id = {entry["question_id"]: _judgment_label(entry) for entry in judgments}
    weighted_correct = 0.0
    estimates_by_type: dict[str, list[tuple[int, float]]] = defaultdict(list)
    stratum_results: list[dict[str, Any]] = []
    for stratum in strata:
        question_type = stratum["question_type"]
        abstention = stratum["abstention"]
        expected_sample = stratum["sample_count"]
        population = stratum["population_count"]
        labels = [
            label
            for question_id, label in labels_by_id.items()
            if references[question_id].question_type == question_type
            and question_id.endswith("_abs") == abstention
        ]
        if len(labels) != expected_sample:
            raise ValueError(
                f"canary stratum {question_type}/{abstention} expected "
                f"{expected_sample} judgments, found {len(labels)}"
            )
        accuracy = sum(labels) / len(labels)
        weighted_correct += population * accuracy
        estimates_by_type[question_type].append((population, accuracy))
        stratum_results.append(
            {
                "question_type": question_type,
                "abstention": abstention,
                "sample_count": expected_sample,
                "population_count": population,
                "accuracy": accuracy,
            }
        )

    type_estimates = {
        question_type: sum(population * accuracy for population, accuracy in values)
        / sum(population for population, _ in values)
        for question_type, values in estimates_by_type.items()
    }
    return {
        "slice": selection["strategy"],
        "sample_count": selection["sample_count"],
        "population_count": population_count,
        "population_weighted_accuracy": weighted_correct / population_count,
        "population_weighted_task_averaged_accuracy": sum(type_estimates.values())
        / len(type_estimates),
        "estimated_per_question_type": dict(sorted(type_estimates.items())),
        "strata": stratum_results,
        "method": "post-stratified by question type and abstention status",
        "warning": "Regression estimate only; a public benchmark result requires all 500 cases.",
    }


def _estimated_cost(
    manifest: dict[str, Any], input_tokens: int, output_tokens: int
) -> float | None:
    answer_config = manifest["config"]["answer"]
    input_price = answer_config.get("input_price_per_million")
    output_price = answer_config.get("output_price_per_million")
    if input_price is None or output_price is None:
        return None
    return (input_tokens * float(input_price) + output_tokens * float(output_price)) / 1_000_000
