from __future__ import annotations

from pathlib import Path

import pytest
from conftest import make_case

from longmemeval.evaluation import _aggregate_model_usage, _build_cost_report, build_report
from longmemeval.utils import append_jsonl, write_json


def test_report_aggregates_official_labels(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    run_path = tmp_path / "run"
    run_path.mkdir()
    reference_path = tmp_path / "longmemeval_oracle.json"
    write_json(
        reference_path,
        [
            make_case("q1", "single-session-user").model_dump(mode="json"),
            make_case("q2_abs", "temporal-reasoning").model_dump(mode="json"),
        ],
    )
    write_json(
        run_path / "manifest.json",
        {
            "status": "completed",
            "dataset_mode": "full-context",
            "failure_count": 0,
            "config": {"answer": {"provider": "gemini", "model": "gemini-test"}},
        },
    )
    for question_id in ("q1", "q2_abs"):
        append_jsonl(
            run_path / "predictions.jsonl",
            {
                "question_id": question_id,
                "hypothesis": "answer",
                "generation": {
                    "latency_ms": 10,
                    "usage": {"input_tokens": 5, "output_tokens": 1, "total_tokens": 6},
                },
            },
        )
    append_jsonl(
        run_path / "judgments.jsonl",
        {
            "question_id": "q1",
            "autoeval_label": {"model": "gpt-4o-2024-08-06", "label": True},
        },
    )
    append_jsonl(
        run_path / "judgments.jsonl",
        {
            "question_id": "q2_abs",
            "autoeval_label": {"model": "gpt-4o-2024-08-06", "label": False},
        },
    )
    monkeypatch.setattr("longmemeval.evaluation.resolve_run_path", lambda run_id: run_path)
    monkeypatch.setattr("longmemeval.evaluation.DATA_DIR", tmp_path)
    report = build_report("run")
    assert report["overall_accuracy"] == 0.5
    assert report["abstention_accuracy"] == 0.0
    assert report["usage"]["total_tokens"] == 12


def test_canary_report_post_stratifies_to_full_population(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_path = tmp_path / "run"
    run_path.mkdir()
    reference_path = tmp_path / "longmemeval_oracle.json"
    write_json(
        reference_path,
        [
            make_case("q1", "single-session-user").model_dump(mode="json"),
            make_case("q2_abs", "temporal-reasoning").model_dump(mode="json"),
        ],
    )
    write_json(
        run_path / "manifest.json",
        {
            "status": "completed",
            "dataset_mode": "full-context",
            "failure_count": 0,
            "config": {"answer": {"provider": "gemini", "model": "gemini-test"}},
            "selection": {
                "strategy": "canary-2",
                "is_canary": True,
                "sample_count": 2,
                "population_count": 10,
                "strata": [
                    {
                        "question_type": "single-session-user",
                        "abstention": False,
                        "sample_count": 1,
                        "population_count": 8,
                    },
                    {
                        "question_type": "temporal-reasoning",
                        "abstention": True,
                        "sample_count": 1,
                        "population_count": 2,
                    },
                ],
            },
        },
    )
    for question_id in ("q1", "q2_abs"):
        append_jsonl(run_path / "predictions.jsonl", {"question_id": question_id})
    append_jsonl(
        run_path / "judgments.jsonl",
        {
            "question_id": "q1",
            "autoeval_label": {"model": "gpt-4o-2024-08-06", "label": True},
        },
    )
    append_jsonl(
        run_path / "judgments.jsonl",
        {
            "question_id": "q2_abs",
            "autoeval_label": {"model": "gpt-4o-2024-08-06", "label": False},
        },
    )
    monkeypatch.setattr("longmemeval.evaluation.resolve_run_path", lambda run_id: run_path)
    monkeypatch.setattr("longmemeval.evaluation.DATA_DIR", tmp_path)

    report = build_report("run")
    estimate = report["canary_estimate"]
    assert estimate["population_weighted_accuracy"] == 0.8
    assert estimate["population_weighted_task_averaged_accuracy"] == 0.5


def test_multi_role_usage_and_cost_are_aggregated_without_double_counting() -> None:
    manifest = {
        "config": {
            "answer": {
                "provider": "gemini",
                "model": "gemini-answer",
                "input_price_per_million": 2,
                "output_price_per_million": 4,
            },
            "agent": {
                "models": {
                    "memory_embedder": {
                        "kind": "embedding",
                        "provider": "openai",
                        "model": "embedding-test",
                        "input_price_per_million": 1,
                    }
                }
            },
        }
    }
    predictions = [
        {
            "generation": {
                "usage": {"input_tokens": 999, "output_tokens": 999, "total_tokens": 1998}
            },
            "model_calls": [
                {
                    "role": "memory_embedder",
                    "kind": "embedding",
                    "provider": "openai",
                    "model": "embedding-test",
                    "item_count": 3,
                    "usage": {"input_tokens": 100, "total_tokens": 100},
                    "latency_ms": 2,
                },
                {
                    "role": "answer",
                    "kind": "generation",
                    "provider": "gemini",
                    "model": "gemini-answer",
                    "item_count": 1,
                    "usage": {"input_tokens": 200, "output_tokens": 10, "total_tokens": 210},
                    "latency_ms": 4,
                },
            ],
        }
    ]
    usage = _aggregate_model_usage(predictions, manifest)
    cost = _build_cost_report(manifest, usage)
    assert usage["memory_embedder"]["item_count"] == 3
    assert usage["answer"]["total_tokens"] == 210
    assert cost["estimated_total"] == pytest.approx(0.00054)
