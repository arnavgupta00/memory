from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal, Protocol, TypeVar

from pydantic import BaseModel, ConfigDict, Field, field_validator

type JsonScalar = str | int | float | bool | None
type JsonValue = JsonScalar | list[JsonValue] | dict[str, JsonValue]
type JsonObject = dict[str, JsonValue]
TStructured = TypeVar("TStructured", bound=BaseModel)


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
    reasoning_effort: Literal["none", "minimal", "low", "medium", "high", "xhigh", "max"] | None = (
        None
    )
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
    retry_count: int = Field(default=0, ge=0)


class PromptMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["system", "user", "assistant"]
    content: str


class PromptEnvelope(BaseModel):
    """Rendered messages plus the stable prompt identity used for model-I/O replay."""

    model_config = ConfigDict(extra="forbid")

    prompt_id: str
    messages: list[PromptMessage] = Field(min_length=1)

    def as_text(self) -> str:
        return "\n\n".join(f"<{message.role}>\n{message.content}" for message in self.messages)


class StructuredGenerationResponse[TStructured: BaseModel](BaseModel):
    """Provider-normalized metadata paired with a schema-validated payload."""

    value: TStructured
    generation: GenerationResponse
    raw_text: str


class EmbeddingRequest(BaseModel):
    inputs: list[str] = Field(min_length=1)
    model: str
    dimensions: int | None = Field(default=None, gt=0)
    task_type: str | None = None

    @field_validator("inputs")
    @classmethod
    def reject_empty_inputs(cls, value: list[str]) -> list[str]:
        if any(not item.strip() for item in value):
            raise ValueError("embedding inputs cannot be empty")
        return value


class EmbeddingResponse(BaseModel):
    embeddings: list[list[float]]
    model: str
    provider: Literal["openai", "gemini"]
    usage: TokenUsage = Field(default_factory=TokenUsage)
    latency_ms: float
    request_id: str | None = None
    retry_count: int = Field(default=0, ge=0)


class ModelRoleInfo(BaseModel):
    kind: Literal["generation", "embedding"]
    provider: Literal["openai", "gemini"]
    model: str


class ModelCallRecord(BaseModel):
    sequence: int
    role: str
    kind: Literal["generation", "embedding"]
    provider: Literal["openai", "gemini"]
    model: str
    input_sha256: str
    item_count: int = Field(ge=1)
    parameters: dict[str, Any] = Field(default_factory=dict)
    usage: TokenUsage = Field(default_factory=TokenUsage)
    latency_ms: float
    request_id: str | None = None
    retry_count: int = Field(default=0, ge=0)


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
    status_code: int | None = None
    provider_code: str | None = None
    request_id: str | None = None


class PredictionRecord(BaseModel):
    question_id: str
    question_type: str
    hypothesis: str
    evidence: list[EvidenceReference] = Field(default_factory=list)
    trace: dict[str, Any] = Field(default_factory=dict)
    generation: GenerationResponse | None = None
    model_calls: list[ModelCallRecord] = Field(default_factory=list)


class TextProvider(Protocol):
    async def generate(self, request: GenerationRequest) -> GenerationResponse: ...

    async def generate_structured(
        self,
        request: GenerationRequest,
        prompt: PromptEnvelope,
        response_model: type[TStructured],
    ) -> StructuredGenerationResponse[TStructured]: ...


class EmbeddingProvider(Protocol):
    async def embed(self, request: EmbeddingRequest) -> EmbeddingResponse: ...


class ModelGateway(Protocol):
    """Named, instrumented model roles exposed to an agent architecture."""

    @property
    def roles(self) -> Mapping[str, ModelRoleInfo]: ...

    async def generate(
        self,
        role: str,
        prompt: str,
        *,
        temperature: float | None = None,
        max_output_tokens: int | None = None,
    ) -> GenerationResponse: ...

    async def generate_structured(
        self,
        role: str,
        prompt: PromptEnvelope,
        response_model: type[TStructured],
        *,
        temperature: float | None = None,
        max_output_tokens: int | None = None,
    ) -> StructuredGenerationResponse[TStructured]: ...

    async def embed(
        self,
        role: str,
        inputs: Sequence[str],
        *,
        dimensions: int | None = None,
        task_type: str | None = None,
    ) -> EmbeddingResponse: ...


class ArtifactReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid")

    relative_path: str
    sequence: int | None = None
    sha256: str


class AgentArtifactStore(Protocol):
    """Case-scoped durable storage. Implementations must redact secrets before writing."""

    async def append(self, stream: str, record: JsonObject) -> ArtifactReceipt: ...

    async def write_once(self, name: str, value: JsonValue | str) -> ArtifactReceipt: ...

    def read_stream(self, stream: str) -> Sequence[JsonObject]: ...


@dataclass(frozen=True)
class AgentRuntime:
    """Dependencies supplied by the harness to a dynamically loaded agent."""

    models: ModelGateway
    artifacts: AgentArtifactStore
    options: Mapping[str, JsonValue]
    answer_role: str = "answer"


class MemoryAgent(Protocol):
    async def reset(self, case: CaseMetadata) -> None: ...

    async def ingest(self, session: TimestampedSession) -> None: ...

    async def answer(self, question: str, question_date: str) -> AnswerResult: ...


MemorySystem = MemoryAgent
JsonMapping = Mapping[str, Any]
