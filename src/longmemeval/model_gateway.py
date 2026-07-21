from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from types import MappingProxyType

from longmemeval.config import (
    EmbeddingModelConfig,
    GenerationModelConfig,
    ModelRoleConfig,
    ProviderConfig,
)
from longmemeval.models import (
    EmbeddingProvider,
    EmbeddingRequest,
    EmbeddingResponse,
    GenerationRequest,
    GenerationResponse,
    ModelCallRecord,
    ModelRoleInfo,
    TextProvider,
)
from longmemeval.providers import create_embedding_provider, create_provider

ANSWER_ROLE = "answer"


@dataclass(frozen=True)
class _GenerationBinding:
    config: ProviderConfig
    provider: TextProvider


@dataclass(frozen=True)
class _EmbeddingBinding:
    config: EmbeddingModelConfig
    provider: EmbeddingProvider


ModelBinding = _GenerationBinding | _EmbeddingBinding


def _input_hash(values: Sequence[str]) -> str:
    serialized = json.dumps(list(values), ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(serialized.encode()).hexdigest()


class ConfiguredModelGateway:
    """Dispatch named roles and retain metadata without serializing prompts or input text."""

    def __init__(self, bindings: Mapping[str, ModelBinding]) -> None:
        if ANSWER_ROLE not in bindings or not isinstance(bindings[ANSWER_ROLE], _GenerationBinding):
            raise ValueError("the model gateway requires a generation role named 'answer'")
        self._bindings = dict(bindings)
        self._calls: list[ModelCallRecord] = []
        self._roles = MappingProxyType(
            {
                role: ModelRoleInfo(
                    kind="generation" if isinstance(binding, _GenerationBinding) else "embedding",
                    provider=binding.config.provider,
                    model=binding.config.model,
                )
                for role, binding in self._bindings.items()
            }
        )

    @property
    def roles(self) -> Mapping[str, ModelRoleInfo]:
        return self._roles

    def begin_case(self) -> None:
        """Start a fresh per-question call ledger."""

        self._calls = []

    def finish_case(self) -> list[ModelCallRecord]:
        """Return and clear the current per-question call ledger."""

        calls = [item.model_copy(deep=True) for item in self._calls]
        self._calls = []
        return calls

    async def generate(
        self,
        role: str,
        prompt: str,
        *,
        temperature: float | None = None,
        max_output_tokens: int | None = None,
    ) -> GenerationResponse:
        binding = self._binding(role)
        if not isinstance(binding, _GenerationBinding):
            raise TypeError(f"model role {role!r} is an embedding role, not a generation role")
        request = GenerationRequest(
            prompt=prompt,
            model=binding.config.model,
            temperature=binding.config.temperature if temperature is None else temperature,
            max_output_tokens=(
                binding.config.max_output_tokens if max_output_tokens is None else max_output_tokens
            ),
        )
        response = await binding.provider.generate(request)
        self._calls.append(
            ModelCallRecord(
                sequence=len(self._calls) + 1,
                role=role,
                kind="generation",
                provider=response.provider,
                model=response.model,
                input_sha256=_input_hash([prompt]),
                item_count=1,
                parameters={
                    "temperature": request.temperature,
                    "max_output_tokens": request.max_output_tokens,
                },
                usage=response.usage,
                latency_ms=response.latency_ms,
                request_id=response.request_id,
            )
        )
        return response

    async def embed(
        self,
        role: str,
        inputs: Sequence[str],
        *,
        dimensions: int | None = None,
        task_type: str | None = None,
    ) -> EmbeddingResponse:
        binding = self._binding(role)
        if not isinstance(binding, _EmbeddingBinding):
            raise TypeError(f"model role {role!r} is a generation role, not an embedding role")
        request = EmbeddingRequest(
            inputs=list(inputs),
            model=binding.config.model,
            dimensions=binding.config.dimensions if dimensions is None else dimensions,
            task_type=binding.config.task_type if task_type is None else task_type,
        )
        response = await binding.provider.embed(request)
        self._calls.append(
            ModelCallRecord(
                sequence=len(self._calls) + 1,
                role=role,
                kind="embedding",
                provider=response.provider,
                model=response.model,
                input_sha256=_input_hash(request.inputs),
                item_count=len(request.inputs),
                parameters={
                    "dimensions": request.dimensions,
                    "task_type": request.task_type,
                },
                usage=response.usage,
                latency_ms=response.latency_ms,
                request_id=response.request_id,
            )
        )
        return response

    def _binding(self, role: str) -> ModelBinding:
        try:
            return self._bindings[role]
        except KeyError as exc:
            available = ", ".join(sorted(self._bindings))
            raise KeyError(f"unknown model role {role!r}; available roles: {available}") from exc


def create_model_gateway(
    answer: ProviderConfig,
    configured_roles: Mapping[str, ModelRoleConfig],
) -> ConfiguredModelGateway:
    """Build agent-visible roles. The canonical judge is intentionally not accepted here."""

    bindings: dict[str, ModelBinding] = {
        ANSWER_ROLE: _GenerationBinding(config=answer, provider=create_provider(answer))
    }
    for role, config in configured_roles.items():
        if isinstance(config, GenerationModelConfig):
            bindings[role] = _GenerationBinding(config=config, provider=create_provider(config))
        elif isinstance(config, EmbeddingModelConfig):
            bindings[role] = _EmbeddingBinding(
                config=config,
                provider=create_embedding_provider(config),
            )
        else:
            raise TypeError(f"unsupported model role configuration: {type(config).__name__}")
    return ConfiguredModelGateway(bindings)
