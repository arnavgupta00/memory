from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field


class Turn(BaseModel):
    model_config = ConfigDict(extra="allow")

    role: Literal["user", "assistant"]
    content: str


class TimestampedSession(BaseModel):
    session_id: str
    date: str
    turns: list[Turn]


class CaseMetadata(BaseModel):
    question_id: str
    question_type: str


class BenchmarkCase(BaseModel):
    model_config = ConfigDict(coerce_numbers_to_str=True)

    question_id: str
    question_type: str
    question: str
    answer: str
    question_date: str
    haystack_session_ids: list[str]
    haystack_dates: list[str]
    haystack_sessions: list[list[dict[str, Any]]]
    answer_session_ids: list[str]

    def metadata(self) -> CaseMetadata:
        return CaseMetadata(question_id=self.question_id, question_type=self.question_type)


class EvidenceReference(BaseModel):
    session_id: str
    turn_index: int | None = None


class GenerationRequest(BaseModel):
    prompt: str
    model: str
    temperature: float = 0.0
    max_output_tokens: int = 800


class TokenUsage(BaseModel):
    input_tokens: int | None = None
    output_tokens: int | None = None
    total_tokens: int | None = None


class GenerationResponse(BaseModel):
    text: str
    model: str
    provider: Literal["openai", "gemini"]
    usage: TokenUsage = Field(default_factory=TokenUsage)
    latency_ms: float
    request_id: str | None = None


class AnswerResult(BaseModel):
    hypothesis: str
    evidence: list[EvidenceReference] = Field(default_factory=list)
    trace: dict[str, Any] = Field(default_factory=dict)
    generation: GenerationResponse | None = None


class FailureRecord(BaseModel):
    question_id: str
    error_type: str
    message: str
    retryable: bool


class PredictionRecord(BaseModel):
    question_id: str
    question_type: str
    hypothesis: str
    evidence: list[EvidenceReference] = Field(default_factory=list)
    trace: dict[str, Any] = Field(default_factory=dict)
    generation: GenerationResponse | None = None


class TextProvider(Protocol):
    async def generate(self, request: GenerationRequest) -> GenerationResponse: ...


@dataclass(frozen=True)
class AgentRuntime:
    """Dependencies supplied by the harness to a dynamically loaded agent."""

    provider: TextProvider
    answer_model: str
    temperature: float
    max_output_tokens: int
    options: Mapping[str, Any]


class MemoryAgent(Protocol):
    async def reset(self, case: CaseMetadata) -> None: ...

    async def ingest(self, session: TimestampedSession) -> None: ...

    async def answer(self, question: str, question_date: str) -> AnswerResult: ...


MemorySystem = MemoryAgent
JsonMapping = Mapping[str, Any]
