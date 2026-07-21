from __future__ import annotations

from pathlib import Path

import pytest
from conftest import make_case

from longmemeval.evaluation import build_report
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
