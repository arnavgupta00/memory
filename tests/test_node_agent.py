from __future__ import annotations

from pathlib import Path
from typing import cast

import pytest

from longmemeval.config import AgentConfig, ProviderConfig
from longmemeval.models import (
    CaseMetadata,
    JsonObject,
    JsonValue,
    TimestampedSession,
    Turn,
)
from longmemeval.node_agent import NodeAgentError, NodeAgentHost, NodeMemoryAgent


def _config() -> AgentConfig:
    role = {
        "kind": "generation",
        "provider": "openai",
        "model": "gpt-test",
        "max_retries": 0,
    }
    return AgentConfig.model_validate(
        {
            "backend": "node",
            "entrypoint": "src/agents/architecture-0003.2-hybrid-graph-reader/dist/host.js",
            "provider_model_limits": [
                {
                    "provider": "openai",
                    "model": "gpt-test",
                    "max_concurrency": 2,
                    "token_budget": 160000,
                    "window_seconds": 60,
                }
            ],
            "models": {"contexto": role, "shino": role, "reader": role},
            "options": {
                "graph_batch_size": 3,
                "summary_batch_size": 9,
                "latest_raw_sessions": 9,
                "allow_graph_replacement": True,
            },
        }
    )


def _session(index: int) -> TimestampedSession:
    return TimestampedSession(
        session_id=f"s{index}",
        date=f"2025/01/{index:02d}",
        turns=[Turn(role="user", content=f"memory {index}")],
    )


class _RecordingHost:
    def __init__(self) -> None:
        self.requests: list[tuple[str, JsonObject]] = []

    async def request(self, method: str, params: JsonObject) -> JsonValue:
        self.requests.append((method, params))
        return {"processedSessions": []}


@pytest.mark.asyncio
async def test_reset_keeps_question_type_outside_the_agent_protocol() -> None:
    recording_host = _RecordingHost()
    agent = NodeMemoryAgent(cast(NodeAgentHost, recording_host))

    await agent.reset(
        CaseMetadata(question_id="category-blind", question_type="invented-category")
    )

    assert recording_host.requests == [
        ("reset", {"case": {"question_id": "category-blind"}})
    ]


@pytest.mark.asyncio
async def test_node_host_protocol_and_partial_case_resume_without_provider_calls(
    tmp_path: Path,
) -> None:
    run_path = tmp_path / "node-run"
    run_path.mkdir()
    answer = ProviderConfig(provider="openai", model="gpt-test", max_retries=0)

    first_host = await NodeAgentHost.start(
        run_path=run_path,
        config=_config(),
        answer=answer,
        capture_model_io=True,
        auto_export_final_svg=True,
    )
    try:
        first = NodeMemoryAgent(first_host)
        await first.reset(CaseMetadata(question_id="q1", question_type="single-session-user"))
        await first.ingest(_session(1))
        await first.ingest(_session(2))
    finally:
        await first_host.close()

    second_host = await NodeAgentHost.start(
        run_path=run_path,
        config=_config(),
        answer=answer,
        capture_model_io=True,
        auto_export_final_svg=True,
    )
    try:
        resumed = NodeMemoryAgent(second_host)
        await resumed.reset(CaseMetadata(question_id="q1", question_type="single-session-user"))
        assert resumed.should_ingest(_session(1)) is False
        assert resumed.should_ingest(_session(2)) is False
        assert resumed.should_ingest(_session(3)) is True
    finally:
        await second_host.close()

    sessions = run_path / "agent-artifacts" / "cases" / "q1" / "sessions.jsonl"
    assert len(sessions.read_text().splitlines()) == 2
    assert not (run_path / "agent-artifacts" / "cases" / "q1" / "model-calls").exists()


@pytest.mark.asyncio
async def test_resume_uses_ordered_session_occurrences_not_unique_ids(tmp_path: Path) -> None:
    run_path = tmp_path / "node-duplicate-run"
    run_path.mkdir()
    answer = ProviderConfig(provider="openai", model="gpt-test", max_retries=0)
    first_session = _session(1).model_copy(update={"session_id": "duplicate"})
    second_session = _session(2).model_copy(update={"session_id": "duplicate"})

    first_host = await NodeAgentHost.start(
        run_path=run_path,
        config=_config(),
        answer=answer,
        capture_model_io=True,
        auto_export_final_svg=False,
    )
    try:
        first = NodeMemoryAgent(first_host)
        await first.reset(
            CaseMetadata(question_id="q-duplicate", question_type="single-session-user")
        )
        await first.ingest(first_session)
        await first.ingest(second_session)
    finally:
        await first_host.close()

    second_host = await NodeAgentHost.start(
        run_path=run_path,
        config=_config(),
        answer=answer,
        capture_model_io=True,
        auto_export_final_svg=False,
    )
    try:
        resumed = NodeMemoryAgent(second_host)
        await resumed.reset(
            CaseMetadata(question_id="q-duplicate", question_type="single-session-user")
        )
        assert resumed.should_ingest(first_session) is False
        assert resumed.should_ingest(second_session) is False
        assert resumed.should_ingest(_session(3)) is True

        changed = NodeMemoryAgent(second_host)
        await changed.reset(
            CaseMetadata(question_id="q-duplicate", question_type="single-session-user")
        )
        with pytest.raises(NodeAgentError, match="session changed at resume position 0"):
            changed.should_ingest(second_session)
    finally:
        await second_host.close()
