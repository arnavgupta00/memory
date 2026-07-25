from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from conftest import make_case

from longmemeval.config import RunConfig
from longmemeval.models import AnswerResult
from longmemeval.runner import execute_run
from longmemeval.utils import read_json, read_jsonl


class FakeSystem:
    def __init__(self) -> None:
        self.answer_calls = 0

    async def reset(self, case):  # type: ignore[no-untyped-def]
        return None

    async def ingest(self, session):  # type: ignore[no-untyped-def]
        assert all("has_answer" not in turn.model_dump() for turn in session.turns)

    async def answer(self, question, question_date):  # type: ignore[no-untyped-def]
        self.answer_calls += 1
        return AnswerResult(hypothesis="Pune")


class FakeGateway:
    def begin_case(self) -> None:
        return None

    def finish_case(self) -> list[object]:
        return []


class FakeGatewayPool(FakeGateway):
    def for_case(self, artifacts, *, capture_model_io):  # type: ignore[no-untyped-def]
        return FakeGateway()


class ConcurrentSystem:
    active = 0
    max_active = 0

    def __init__(self, artifacts) -> None:  # type: ignore[no-untyped-def]
        self.artifacts = artifacts
        self.question_id = ""

    async def reset(self, case):  # type: ignore[no-untyped-def]
        self.question_id = case.question_id

    async def ingest(self, session):  # type: ignore[no-untyped-def]
        return None

    async def answer(self, question, question_date):  # type: ignore[no-untyped-def]
        type(self).active += 1
        type(self).max_active = max(type(self).max_active, type(self).active)
        await asyncio.sleep(0.01)
        await self.artifacts.write_once("concurrency.json", {"question_id": self.question_id})
        type(self).active -= 1
        return AnswerResult(hypothesis="Pune")


@pytest.mark.asyncio
async def test_run_checkpoints_and_resume(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    cases = [make_case("q1"), make_case("q2")]
    fake = FakeSystem()
    monkeypatch.setattr("longmemeval.runner.RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr("longmemeval.runner.verify_data", lambda: {"data.json": "hash"})
    monkeypatch.setattr("longmemeval.runner.dataset_path", lambda mode: tmp_path / "data.json")
    monkeypatch.setattr("longmemeval.runner.load_cases", lambda path: cases)
    monkeypatch.setattr(
        "longmemeval.runner.create_model_gateway", lambda answer, models: FakeGateway()
    )
    monkeypatch.setattr("longmemeval.runner.load_agent", lambda *args: fake)
    config = RunConfig.model_validate(
        {
            "name": "offline",
            "mode": "full-context",
            "agent": {"entrypoint": "agents.baselines.full_context:create_agent"},
            "answer": {"provider": "openai", "model": "gpt-test"},
        }
    )
    config_path = tmp_path / "config.yaml"
    config_path.write_text("name: offline\n")
    run_path = await execute_run(config, config_path, run_id="offline-run")
    assert fake.answer_calls == 2
    assert len(read_jsonl(run_path / "predictions.jsonl")) == 2
    assert read_json(run_path / "manifest.json")["status"] == "completed"

    await execute_run(config, config_path, resume=True, run_id="offline-run")
    assert fake.answer_calls == 2
    assert len(read_jsonl(run_path / "predictions.jsonl")) == 2

    with pytest.raises(ValueError, match="different question selection"):
        await execute_run(
            config,
            config_path,
            requested_ids=["q1"],
            resume=True,
            run_id="offline-run",
        )


@pytest.mark.asyncio
async def test_four_cases_run_concurrently_with_isolated_artifacts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cases = [make_case(f"q{index}") for index in range(1, 5)]
    ConcurrentSystem.active = 0
    ConcurrentSystem.max_active = 0
    monkeypatch.setattr("longmemeval.runner.RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr("longmemeval.runner.verify_data", lambda: {"data.json": "hash"})
    monkeypatch.setattr("longmemeval.runner.dataset_path", lambda mode: tmp_path / "data.json")
    monkeypatch.setattr("longmemeval.runner.load_cases", lambda path: cases)
    monkeypatch.setattr(
        "longmemeval.runner.create_model_gateway", lambda answer, models: FakeGatewayPool()
    )
    monkeypatch.setattr(
        "longmemeval.runner.load_agent",
        lambda config, models, artifacts, node_host: ConcurrentSystem(artifacts),
    )
    config = RunConfig.model_validate(
        {
            "name": "parallel",
            "mode": "full-context",
            "agent": {"entrypoint": "agents.baselines.full_context:create_agent"},
            "answer": {"provider": "openai", "model": "gpt-test"},
            "execution": {"case_concurrency": 4},
        }
    )
    config_path = tmp_path / "parallel.yaml"
    config_path.write_text("name: parallel\n")
    run_path = await execute_run(config, config_path, run_id="parallel-run")
    assert ConcurrentSystem.max_active == 4
    assert len(read_jsonl(run_path / "predictions.jsonl")) == 4
    for case in cases:
        assert (
            run_path / "agent-artifacts" / "cases" / case.question_id / "concurrency.json"
        ).exists()
