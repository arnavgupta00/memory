from __future__ import annotations

from pathlib import Path
from typing import TypeVar

import pytest
from pydantic import BaseModel

from agents.current.contracts.models import (
    ConsolidationOutput,
    FinalAnswerOutput,
    QueryPlan,
    RerankOutput,
)
from agents.current.system import TemporalContextGraphAgent
from longmemeval.api import (
    AgentRuntime,
    CaseMetadata,
    GenerationRequest,
    GenerationResponse,
    PromptEnvelope,
    StructuredGenerationResponse,
    TimestampedSession,
    TokenUsage,
    Turn,
)
from longmemeval.artifacts import FileArtifactStore
from longmemeval.config import AgentConfig, ProviderConfig
from longmemeval.model_gateway import create_model_gateway
from longmemeval.utils import read_jsonl

T = TypeVar("T", bound=BaseModel)


class StructuredFixtureProvider:
    async def generate(self, request: GenerationRequest) -> GenerationResponse:
        raise AssertionError("architecture 0002 uses structured generation")

    async def generate_structured(
        self,
        request: GenerationRequest,
        prompt: PromptEnvelope,
        response_model: type[T],
    ) -> StructuredGenerationResponse[T]:
        if response_model is ConsolidationOutput:
            payload: BaseModel = ConsolidationOutput(summary="compact batch", operations=[])
        elif response_model is QueryPlan:
            payload = QueryPlan(lexical_terms=["Pune"])
        elif response_model is RerankOutput:
            payload = RerankOutput(selected=[{"candidate_id": "s1", "reason": "direct"}])
        elif response_model is FinalAnswerOutput:
            payload = FinalAnswerOutput(
                hypothesis="Pune",
                evidence=[{"session_id": "s1"}],
                support_status="supported",
            )
        else:
            raise AssertionError(f"unexpected contract: {response_model}")
        value = response_model.model_validate(payload.model_dump())
        generation = GenerationResponse(
            text=value.model_dump_json(),
            model=request.model,
            provider="openai",
            usage=TokenUsage(input_tokens=10, output_tokens=3, total_tokens=13),
            latency_ms=2,
            request_id=f"request-{response_model.__name__}",
        )
        return StructuredGenerationResponse(
            value=value,
            generation=generation,
            raw_text=generation.text,
        )


@pytest.mark.asyncio
async def test_offline_end_to_end_writes_replayable_artifacts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "longmemeval.model_gateway.create_provider",
        lambda config: StructuredFixtureProvider(),
    )
    role = {
        "kind": "generation",
        "provider": "openai",
        "model": "gpt-test",
        "max_retries": 0,
    }
    config = AgentConfig.model_validate(
        {
            "entrypoint": "agents.current:create_agent",
            "models": {
                "memory_consolidator": role,
                "query_planner": role,
                "evidence_reranker": role,
            },
            "options": {"batch_size": 3},
        }
    )
    store = FileArtifactStore(tmp_path / "case")
    pool = create_model_gateway(
        ProviderConfig(provider="openai", model="gpt-test", max_retries=0),
        config.models,
    )
    gateway = pool.for_case(store, capture_model_io=True)
    runtime = AgentRuntime(models=gateway, artifacts=store, options=config.options)
    agent = TemporalContextGraphAgent(runtime)
    gateway.begin_case()
    await agent.reset(CaseMetadata(question_id="q-e2e", question_type="single-session-user"))
    for index in range(1, 5):
        await agent.ingest(
            TimestampedSession(
                session_id=f"s{index}",
                date=f"2025/01/0{index}",
                turns=[Turn(role="user", content=f"memory {index}: Pune")],
            )
        )
    answer = await agent.answer("Where?", "2025/01/05")
    calls = gateway.finish_case()

    assert answer.hypothesis == "Pune"
    assert [call.role for call in calls] == [
        "memory_consolidator",
        "memory_consolidator",
        "query_planner",
        "evidence_reranker",
        "answer",
    ]
    assert len(read_jsonl(tmp_path / "case" / "events.jsonl")) == 6
    assert len(read_jsonl(tmp_path / "case" / "model-calls" / "calls.jsonl")) == 5
    for name in ("final-graph.json", "final-context.json", "answer.json", "final.svg"):
        assert (tmp_path / "case" / name).exists()
