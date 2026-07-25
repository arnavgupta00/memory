from __future__ import annotations

from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from agents.current.artifacts.recorder import EventRecorder
from agents.current.contracts.models import ConsolidationOutput
from agents.current.inspector.server import app
from agents.current.memory.reducer import TemporalGraphReducer
from longmemeval.artifacts import FileArtifactStore
from longmemeval.utils import write_json


@pytest.mark.asyncio
async def test_inspector_indexes_replays_and_exports_allowlisted_artifacts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runs = tmp_path / "runs"
    run = runs / "inspector-run"
    case_path = run / "agent-artifacts" / "cases" / "q1"
    write_json(
        run / "manifest.json",
        {
            "status": "completed",
            "completed_count": 1,
            "selected_count": 1,
            "config": {"agent": {"entrypoint": "agents.current:create_agent"}},
        },
    )
    store = FileArtifactStore(case_path)
    output = ConsolidationOutput.model_validate(
        {
            "summary": "Jason appears.",
            "operations": [
                {
                    "op": "create_entity",
                    "ref": "jason",
                    "kind": "person",
                    "canonical_name": "Jason",
                    "provenance": {
                        "session_id": "s1",
                        "turn_index": 0,
                        "session_date": "2025/01/01",
                        "batch_id": "batch-0001",
                    },
                }
            ],
        }
    )
    reducer = TemporalGraphReducer("q1")
    record = reducer.apply("batch-0001", ["s1"], output)
    recorder = EventRecorder(store)
    await recorder.record(
        "batch_applied",
        {
            "batch_id": "batch-0001",
            "session_ids": ["s1"],
            "consolidation": output.model_dump(mode="json"),
            "batch_record": record.model_dump(mode="json"),
        },
        graph_state_hash=record.graph_hash,
    )
    await store.write_once("final-graph.json", reducer.graph.model_dump(mode="json"))
    await store.write_once("answer.json", {"hypothesis": "Jason"})
    monkeypatch.setenv("MEMORYBENCH_RUNS_DIR", str(runs))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        listed = (await client.get("/api/runs")).json()
        assert listed[0]["id"] == "inspector-run"
        assert listed[0]["has_graph_artifacts"] is True
        cases = (await client.get("/api/runs/inspector-run/cases")).json()
        assert cases == [
            {
                "id": "q1",
                "event_count": 1,
                "batch_count": 1,
                "has_final_graph": True,
                "has_answer": True,
            }
        ]
        replay = await client.get("/api/runs/inspector-run/cases/q1?batch=1")
        assert replay.status_code == 200
        assert len(replay.json()["graph"]["entities"]) == 1
        exported = await client.get("/api/runs/inspector-run/cases/q1/export.svg?batch=1")
        assert exported.status_code == 200
        assert exported.headers["content-type"].startswith("image/svg+xml")
        assert "Jason" in exported.text
        invalid_resume = await client.get(
            "/api/runs/inspector-run/cases/q1/events",
            headers={"Last-Event-ID": "not-an-integer"},
        )
        assert invalid_resume.status_code == 400
