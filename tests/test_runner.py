from __future__ import annotations

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


@pytest.mark.asyncio
async def test_run_checkpoints_and_resume(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    cases = [make_case("q1"), make_case("q2")]
    fake = FakeSystem()
    monkeypatch.setattr("longmemeval.runner.RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr("longmemeval.runner.verify_data", lambda: {"data.json": "hash"})
    monkeypatch.setattr("longmemeval.runner.dataset_path", lambda mode: tmp_path / "data.json")
    monkeypatch.setattr("longmemeval.runner.load_cases", lambda path: cases)
    monkeypatch.setattr("longmemeval.runner.create_provider", lambda config: object())
    monkeypatch.setattr("longmemeval.runner.load_agent", lambda *args: fake)
    config = RunConfig.model_validate(
        {
            "name": "offline",
            "mode": "full-context",
            "agent": {"entrypoint": "agents.current:create_agent"},
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
