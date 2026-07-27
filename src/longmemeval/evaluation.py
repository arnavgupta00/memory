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

    usage_by_role = _aggregate_model_usage(predictions, manifest)
    input_tokens = sum(item["input_tokens"] for item in usage_by_role.values())
    output_tokens = sum(item["output_tokens"] for item in usage_by_role.values())
    total_tokens = sum(item["total_tokens"] for item in usage_by_role.values())
    total_latency_ms = sum(item["latency_ms"] for item in usage_by_role.values())
    model_call_count = sum(item["call_count"] for item in usage_by_role.values())
    answer_usage = usage_by_role.get("answer") or {}
    answer_latency_ms = float(answer_usage.get("latency_ms", 0.0))
    answer_call_count = int(answer_usage.get("call_count", 0))

    report = {
        "schema_version": 2,
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
            "model_call_count": model_call_count,
            "total_model_latency_ms": total_latency_ms,
            "answer_latency_ms": answer_latency_ms,
            "mean_answer_latency_ms": (
                answer_latency_ms / answer_call_count if answer_call_count else None
            ),
            "by_role": usage_by_role,
            "expected_vs_actual_calls": _expected_call_counts(predictions, usage_by_role),
            "by_phase": _phase_usage(usage_by_role),
        },
        "cost": _build_cost_report(manifest, usage_by_role),
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


def _aggregate_model_usage(
    predictions: list[dict[str, Any]], manifest: dict[str, Any]
) -> dict[str, dict[str, Any]]:
    totals: dict[str, dict[str, Any]] = {}
    answer_config = manifest["config"]["answer"]
    for prediction in predictions:
        if "model_calls" in prediction:
            calls = prediction.get("model_calls") or []
        else:
            generation = prediction.get("generation") or {}
            calls = (
                [
                    {
                        "role": "answer",
                        "kind": "generation",
                        "provider": generation.get("provider") or answer_config["provider"],
                        "model": generation.get("model") or answer_config["model"],
                        "item_count": 1,
                        "usage": generation.get("usage") or {},
                        "latency_ms": generation.get("latency_ms") or 0.0,
                    }
                ]
                if generation
                else []
            )
        for call in calls:
            role = str(call["role"])
            usage = call.get("usage") or {}
            input_count = int(usage.get("input_tokens") or 0)
            output_count = int(usage.get("output_tokens") or 0)
            total_count = int(usage.get("total_tokens") or input_count + output_count)
            summary = totals.setdefault(
                role,
                {
                    "kind": call["kind"],
                    "provider": call["provider"],
                    "model": call["model"],
                    "call_count": 0,
                    "item_count": 0,
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "total_tokens": 0,
                    "latency_ms": 0.0,
                    "retry_count": 0,
                },
            )
            if (
                summary["kind"] != call["kind"]
                or summary["provider"] != call["provider"]
                or summary["model"] != call["model"]
            ):
                raise ValueError(f"model role {role!r} changed identity within one run")
            summary["call_count"] += 1
            summary["item_count"] += int(call.get("item_count") or 1)
            summary["input_tokens"] += input_count
            summary["output_tokens"] += output_count
            summary["total_tokens"] += total_count
            summary["latency_ms"] += float(call.get("latency_ms") or 0.0)
            summary["retry_count"] += int(call.get("retry_count") or 0)
    return dict(sorted(totals.items()))


def _expected_call_counts(
    predictions: list[dict[str, Any]],
    usage_by_role: dict[str, dict[str, Any]],
) -> dict[str, dict[str, int | None]]:
    expected: defaultdict[str, int] = defaultdict(int)
    for prediction in predictions:
        trace = prediction.get("trace") or {}
        if trace.get("architecture_id") == "0002-temporal-context-graph":
            expected["memory_consolidator"] += int(trace.get("batch_count") or 0)
            expected["query_planner"] += 1
            expected["evidence_reranker"] += 1
            expected["answer"] += 1
        elif trace.get("architecture_id") in {
            "0003-contexto-shino-langgraph",
            "0003.1-contexto-semantic-memory",
            "0003.2-hybrid-graph-reader",
        }:
            expected["contexto"] += int(trace.get("contexto_call_count") or 0)
            expected["shino"] += int(trace.get("shino_call_count") or 0)
            if trace.get("architecture_id") == "0003.2-hybrid-graph-reader":
                expected["reader"] += int(trace.get("reader_call_count") or 1)
            expected["answer"] += 1
        elif trace.get("architecture_id") == "0005-context-service":
            expected["select"] += int(trace.get("select_call_count") or 0)
            expected["answer"] += int(trace.get("answer_call_count") or 1)
        else:
            expected["answer"] += 1
    roles = sorted(set(expected) | set(usage_by_role))
    return {
        role: {
            "expected": expected.get(role),
            "actual": int((usage_by_role.get(role) or {}).get("call_count", 0)),
        }
        for role in roles
    }


def _phase_usage(usage_by_role: dict[str, dict[str, Any]]) -> dict[str, dict[str, int | float]]:
    phases: dict[str, dict[str, int | float]] = {
        "memory_construction": {"call_count": 0, "total_tokens": 0, "latency_ms": 0.0},
        "question_time": {"call_count": 0, "total_tokens": 0, "latency_ms": 0.0},
    }
    for role, usage in usage_by_role.items():
        phase = (
            "memory_construction"
            if role in {"memory_consolidator", "contexto", "shino"}
            else "question_time"
        )
        phases[phase]["call_count"] += int(usage["call_count"])
        phases[phase]["total_tokens"] += int(usage["total_tokens"])
        phases[phase]["latency_ms"] += float(usage["latency_ms"])
    return phases


def _role_configs(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    run_config = manifest["config"]
    roles = {"answer": run_config["answer"]}
    roles.update((run_config.get("agent") or {}).get("models") or {})
    return roles


def _build_cost_report(
    manifest: dict[str, Any], usage_by_role: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    configs = _role_configs(manifest)
    role_costs: dict[str, dict[str, Any]] = {}
    known_total = 0.0
    complete = True
    for role, usage in usage_by_role.items():
        config = configs.get(role) or {}
        input_price = config.get("input_price_per_million")
        output_price = config.get("output_price_per_million")
        price_complete = input_price is not None and (
            usage["kind"] == "embedding" or output_price is not None
        )
        estimated = None
        if price_complete:
            assert input_price is not None
            estimated = (
                usage["input_tokens"] * float(input_price)
                + usage["output_tokens"] * float(output_price or 0)
            ) / 1_000_000
            known_total += estimated
        else:
            complete = False
        role_costs[role] = {
            "kind": usage["kind"],
            "provider": usage["provider"],
            "model": usage["model"],
            "input_unit_price_per_million": input_price,
            "output_unit_price_per_million": output_price,
            "estimated_total": estimated,
        }
    return {
        "currency": "USD",
        "estimated_total": known_total if complete else None,
        "by_role": role_costs,
        "note": "Prices are user-supplied run-date inputs; model aliases and prices change.",
    }
