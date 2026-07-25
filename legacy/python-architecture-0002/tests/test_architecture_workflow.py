from __future__ import annotations

from pathlib import Path
from typing import ClassVar, TypeVar

import pytest
from pydantic import BaseModel

from agents.current.config import CurrentArchitectureConfig
from agents.current.contracts.models import (
    ConsolidationOutput,
    RerankOutput,
    RetrievalCandidate,
)
from agents.current.workflows.answering import AnsweringWorkflow
from agents.current.workflows.construction import ConstructionWorkflow
from longmemeval.api import (
    AgentRuntime,
    GenerationResponse,
    ModelRoleInfo,
    PromptEnvelope,
    StructuredGenerationResponse,
    TimestampedSession,
    Turn,
)
from longmemeval.artifacts import FileArtifactStore

T = TypeVar("T", bound=BaseModel)


class ConsolidationGateway:
    roles: ClassVar = {
        "answer": ModelRoleInfo(kind="generation", provider="openai", model="gpt-test"),
        "memory_consolidator": ModelRoleInfo(
            kind="generation", provider="openai", model="gpt-test"
        ),
    }

    def __init__(self) -> None:
        self.calls: list[str] = []

    async def generate_structured(
        self,
        role: str,
        prompt: PromptEnvelope,
        response_model: type[T],
        *,
        temperature: float | None = None,
        max_output_tokens: int | None = None,
    ) -> StructuredGenerationResponse[T]:
        self.calls.append(role)
        value = response_model.model_validate(
            ConsolidationOutput(summary=f"summary {len(self.calls)}", operations=[]).model_dump()
        )
        generation = GenerationResponse(
            text=value.model_dump_json(), model="gpt-test", provider="openai", latency_ms=1
        )
        return StructuredGenerationResponse(
            value=value, generation=generation, raw_text=generation.text
        )

    async def generate(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        raise AssertionError("plain generation is not used")

    async def embed(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        raise AssertionError("architecture 0002 must not use embeddings")


class FailOnceConsolidationGateway(ConsolidationGateway):
    def __init__(self) -> None:
        super().__init__()
        self.failed = False

    async def generate_structured(
        self,
        role: str,
        prompt: PromptEnvelope,
        response_model: type[T],
        *,
        temperature: float | None = None,
        max_output_tokens: int | None = None,
    ) -> StructuredGenerationResponse[T]:
        if not self.failed:
            self.failed = True
            raise RuntimeError("synthetic incomplete batch")
        return await super().generate_structured(
            role,
            prompt,
            response_model,
            temperature=temperature,
            max_output_tokens=max_output_tokens,
        )


def sessions(count: int) -> list[TimestampedSession]:
    return [
        TimestampedSession(
            session_id=f"s{index}",
            date=f"2025/01/{index:02d}",
            turns=[Turn(role="user", content=f"memory {index}")],
        )
        for index in range(1, count + 1)
    ]


def test_unknown_reranker_ids_are_ignored_with_deterministic_fallback() -> None:
    workflow = AnsweringWorkflow.__new__(AnsweringWorkflow)
    workflow.config = CurrentArchitectureConfig(evidence_limit=2)
    candidates = [
        RetrievalCandidate(id="known-1", kind="session", text="one"),
        RetrievalCandidate(id="known-2", kind="session", text="two"),
    ]
    selected, invalid = workflow._validate_selection(
        candidates,
        RerankOutput(selected=[{"candidate_id": "invented", "reason": "mistake"}]),
    )
    assert [item.id for item in selected] == ["known-1", "known-2"]
    assert invalid == ["invented"]


@pytest.mark.asyncio
@pytest.mark.parametrize(("batch_size", "expected_calls"), [(3, 4), (9, 2)])
async def test_batch_cadence_and_remainder_flush(
    tmp_path: Path, batch_size: int, expected_calls: int
) -> None:
    gateway = ConsolidationGateway()
    artifacts = FileArtifactStore(tmp_path / f"b{batch_size}")
    runtime = AgentRuntime(models=gateway, artifacts=artifacts, options={})
    workflow = ConstructionWorkflow(
        runtime, CurrentArchitectureConfig(batch_size=batch_size), "question"
    )
    await workflow.resume()
    for session in sessions(10):
        await workflow.ingest(session)
    await workflow.flush()
    assert gateway.calls == ["memory_consolidator"] * expected_calls
    assert len(workflow.batches) == expected_calls
    assert workflow.batches[-1].session_ids[-1] == "s10"

    resumed = ConstructionWorkflow(
        runtime, CurrentArchitectureConfig(batch_size=batch_size), "question"
    )
    await resumed.resume()
    for session in sessions(10):
        await resumed.ingest(session)
    await resumed.flush()
    assert gateway.calls == ["memory_consolidator"] * expected_calls
    assert len(resumed.batches) == expected_calls


@pytest.mark.asyncio
async def test_resume_retries_exact_incomplete_batch_before_new_sessions(tmp_path: Path) -> None:
    artifacts = FileArtifactStore(tmp_path / "resume-incomplete")
    failing = FailOnceConsolidationGateway()
    first = ConstructionWorkflow(
        AgentRuntime(models=failing, artifacts=artifacts, options={}),
        CurrentArchitectureConfig(batch_size=3),
        "question",
    )
    await first.resume()
    source_sessions = sessions(3)
    await first.ingest(source_sessions[0])
    await first.ingest(source_sessions[1])
    with pytest.raises(RuntimeError, match="incomplete batch"):
        await first.ingest(source_sessions[2])

    succeeding = ConsolidationGateway()
    resumed = ConstructionWorkflow(
        AgentRuntime(models=succeeding, artifacts=artifacts, options={}),
        CurrentArchitectureConfig(batch_size=3),
        "question",
    )
    await resumed.resume()
    assert len(resumed.batches) == 1
    assert resumed.batches[0].session_ids == ["s1", "s2", "s3"]
