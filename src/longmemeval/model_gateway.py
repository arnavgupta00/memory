from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, TypeVar, cast

from pydantic import BaseModel

from longmemeval.config import (
    EmbeddingModelConfig,
    GenerationModelConfig,
    ModelRoleConfig,
    ProviderConfig,
)
from longmemeval.models import (
    AgentArtifactStore,
    EmbeddingProvider,
    EmbeddingRequest,
    EmbeddingResponse,
    GenerationRequest,
    GenerationResponse,
    ModelCallRecord,
    ModelRoleInfo,
    PromptEnvelope,
    StructuredGenerationResponse,
    TextProvider,
)
from longmemeval.providers import create_embedding_provider, create_provider

ANSWER_ROLE = "answer"
TStructured = TypeVar("TStructured", bound=BaseModel)


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

    def __init__(
        self,
        bindings: Mapping[str, ModelBinding],
        *,
        artifacts: AgentArtifactStore | None = None,
        capture_model_io: bool = False,
    ) -> None:
        if ANSWER_ROLE not in bindings or not isinstance(bindings[ANSWER_ROLE], _GenerationBinding):
            raise ValueError("the model gateway requires a generation role named 'answer'")
        self._bindings = dict(bindings)
        self._artifacts = artifacts
        self._capture_model_io = capture_model_io
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
        """Start or resume a per-question call ledger from durable artifacts."""

        self._calls = []
        if self._artifacts is None:
            return
        for record in self._artifacts.read_stream("model-calls/calls"):
            raw_call = record.get("call")
            if isinstance(raw_call, dict):
                restored = dict(raw_call)
                raw_usage = restored.get("usage")
                if isinstance(raw_usage, dict):
                    restored["usage"] = {
                        key: None if value == "[REDACTED]" else value
                        for key, value in raw_usage.items()
                    }
                self._calls.append(ModelCallRecord.model_validate(restored))

    def finish_case(self) -> list[ModelCallRecord]:
        """Return and clear the current per-question call ledger."""

        calls = [item.model_copy(deep=True) for item in self._calls]
        self._calls = []
        return calls

    def for_case(
        self,
        artifacts: AgentArtifactStore,
        *,
        capture_model_io: bool,
    ) -> ConfiguredModelGateway:
        """Isolate the call ledger while sharing run-global provider semaphores."""

        return ConfiguredModelGateway(
            self._bindings,
            artifacts=artifacts,
            capture_model_io=capture_model_io,
        )

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
            reasoning_effort=binding.config.reasoning_effort,
            max_output_tokens=(
                binding.config.max_output_tokens if max_output_tokens is None else max_output_tokens
            ),
        )
        try:
            response = await binding.provider.generate(request)
        except Exception as exc:
            await self._capture_failure(role, "generation", [prompt], request.model_dump(), exc)
            raise
        call = ModelCallRecord(
            sequence=len(self._calls) + 1,
            role=role,
            kind="generation",
            provider=response.provider,
            model=response.model,
            input_sha256=_input_hash([prompt]),
            item_count=1,
            parameters={
                "temperature": request.temperature,
                "reasoning_effort": request.reasoning_effort,
                "max_output_tokens": request.max_output_tokens,
            },
            usage=response.usage,
            latency_ms=response.latency_ms,
            request_id=response.request_id,
            retry_count=response.retry_count,
        )
        self._calls.append(call)
        await self._capture(call, {"prompt": prompt, "response_text": response.text})
        return response

    async def generate_structured(
        self,
        role: str,
        prompt: PromptEnvelope,
        response_model: type[TStructured],
        *,
        temperature: float | None = None,
        max_output_tokens: int | None = None,
    ) -> StructuredGenerationResponse[TStructured]:
        binding = self._binding(role)
        if not isinstance(binding, _GenerationBinding):
            raise TypeError(f"model role {role!r} is an embedding role, not a generation role")
        request = GenerationRequest(
            prompt=prompt.as_text(),
            model=binding.config.model,
            temperature=binding.config.temperature if temperature is None else temperature,
            reasoning_effort=binding.config.reasoning_effort,
            max_output_tokens=(
                binding.config.max_output_tokens if max_output_tokens is None else max_output_tokens
            ),
        )
        try:
            response = await binding.provider.generate_structured(request, prompt, response_model)
        except Exception as exc:
            await self._capture_failure(
                role,
                "generation",
                [request.prompt],
                {
                    **request.model_dump(exclude={"prompt"}),
                    "prompt_id": prompt.prompt_id,
                    "output_contract": response_model.__name__,
                },
                exc,
            )
            raise
        call = ModelCallRecord(
            sequence=len(self._calls) + 1,
            role=role,
            kind="generation",
            provider=response.generation.provider,
            model=response.generation.model,
            input_sha256=_input_hash([request.prompt]),
            item_count=1,
            parameters={
                "temperature": request.temperature,
                "reasoning_effort": request.reasoning_effort,
                "max_output_tokens": request.max_output_tokens,
                "prompt_id": prompt.prompt_id,
                "output_contract": response_model.__name__,
            },
            usage=response.generation.usage,
            latency_ms=response.generation.latency_ms,
            request_id=response.generation.request_id,
            retry_count=response.generation.retry_count,
        )
        self._calls.append(call)
        await self._capture(
            call,
            {
                "prompt": prompt.model_dump(mode="json"),
                "response_schema": response_model.model_json_schema(),
                "raw_response": response.raw_text,
                "validated_response": response.value.model_dump(mode="json"),
            },
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
        try:
            response = await binding.provider.embed(request)
        except Exception as exc:
            await self._capture_failure(
                role,
                "embedding",
                request.inputs,
                request.model_dump(exclude={"inputs"}),
                exc,
            )
            raise
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
                retry_count=response.retry_count,
            )
        )
        return response

    async def _capture(self, call: ModelCallRecord, detail: dict[str, Any]) -> None:
        if not self._capture_model_io or self._artifacts is None:
            return
        payload = cast(
            dict[str, Any],
            {"call": call.model_dump(mode="json", exclude_none=True), **detail},
        )
        await self._artifacts.append("model-calls/calls", payload)

    async def _capture_failure(
        self,
        role: str,
        kind: str,
        inputs: Sequence[str],
        parameters: dict[str, Any],
        error: Exception,
    ) -> None:
        if not self._capture_model_io or self._artifacts is None:
            return
        await self._artifacts.append(
            "model-calls/failures",
            {
                "role": role,
                "kind": kind,
                "input_sha256": _input_hash(inputs),
                "parameters": parameters,
                "error_type": type(error).__name__,
                "message": str(error)[:2000],
            },
        )

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
