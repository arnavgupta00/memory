from __future__ import annotations

from pathlib import Path

import pytest

from longmemeval.agent_loader import load_agent
from longmemeval.api import (
    CaseMetadata,
    GenerationRequest,
    GenerationResponse,
    TimestampedSession,
    Turn,
)
from longmemeval.config import AgentConfig, ProviderConfig


class FakeProvider:
    async def generate(self, request: GenerationRequest) -> GenerationResponse:
        return GenerationResponse(
            text="Pune",
            model=request.model,
            provider="openai",
            latency_ms=1,
        )


@pytest.mark.asyncio
async def test_current_agent_loads_dynamically_and_implements_contract() -> None:
    agent = load_agent(
        AgentConfig(
            entrypoint="agents.current:create_agent",
            options={"chain_of_note": False, "history_format": "text"},
        ),
        FakeProvider(),
        ProviderConfig(provider="openai", model="gpt-test", max_retries=0),
    )
    await agent.reset(CaseMetadata(question_id="q1", question_type="single-session-user"))
    await agent.ingest(
        TimestampedSession(
            session_id="s1",
            date="2025/01/01",
            turns=[Turn(role="user", content="I moved to Pune.")],
        )
    )
    result = await agent.answer("Where did I move?", "2025/01/02")
    assert result.hypothesis == "Pune"
    assert result.trace["architecture_id"] == "0001-full-context"


def test_source_tree_has_only_harness_and_agent_packages() -> None:
    source = Path(__file__).parents[1] / "src"
    directories = {path.name for path in source.iterdir() if path.is_dir()}
    assert directories == {"agents", "longmemeval"}


def test_current_agent_imports_only_the_public_harness_api() -> None:
    current = Path(__file__).parents[1] / "src" / "agents" / "current"
    for path in current.glob("*.py"):
        for line in path.read_text().splitlines():
            if line.startswith("from longmemeval."):
                assert line.startswith("from longmemeval.api "), (
                    f"agent architecture imports harness internals in {path.name}: {line}"
                )
