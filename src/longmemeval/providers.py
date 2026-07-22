from __future__ import annotations

import asyncio
import os
from time import perf_counter
from typing import Any

from google import genai
from google.genai import types
from openai import AsyncOpenAI
from tenacity import AsyncRetrying, retry_if_exception, stop_after_attempt, wait_exponential

from longmemeval.config import EmbeddingModelConfig, ProviderConfig
from longmemeval.models import (
    EmbeddingProvider,
    EmbeddingRequest,
    EmbeddingResponse,
    GenerationRequest,
    GenerationResponse,
    TextProvider,
    TokenUsage,
)


class ProviderError(RuntimeError):
    """A normalized model-provider failure."""

    def __init__(
        self,
        message: str,
        *,
        retryable: bool = False,
        status_code: int | None = None,
        provider_code: str | None = None,
        request_id: str | None = None,
    ) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.status_code = status_code
        self.provider_code = provider_code
        self.request_id = request_id


def _status_code(exc: Exception) -> int | None:
    raw = getattr(exc, "status_code", None)
    try:
        return int(raw) if raw is not None else None
    except (TypeError, ValueError):
        return None


def _provider_code(exc: Exception) -> str | None:
    raw = getattr(exc, "code", None)
    if raw is None:
        body = getattr(exc, "body", None)
        if isinstance(body, dict):
            error = body.get("error", body)
            if isinstance(error, dict):
                raw = error.get("code") or error.get("type")
    return str(raw) if raw is not None else None


def _provider_request_id(exc: Exception) -> str | None:
    raw = getattr(exc, "request_id", None)
    return str(raw) if raw is not None else None


def _normalized_provider_error(exc: Exception, *, operation: str) -> ProviderError:
    detail = str(exc).strip() or f"{operation} failed"
    # Keep structured logs useful without allowing an unexpectedly large provider body
    # to dominate the per-question error ledger.
    detail = detail[:2000]
    return ProviderError(
        f"{type(exc).__name__}: {detail}",
        retryable=_retryable_provider_exception(exc),
        status_code=_status_code(exc),
        provider_code=_provider_code(exc),
        request_id=_provider_request_id(exc),
    )


def _retryable_provider_exception(exc: Exception) -> bool:
    status_number = _status_code(exc)
    return isinstance(exc, (ConnectionError, TimeoutError)) or status_number in {
        408,
        409,
        429,
        500,
        502,
        503,
        504,
    }


class _RequestPacer:
    """Space request starts so large prompts do not overlap a provider TPM window."""

    def __init__(self, minimum_interval_seconds: float) -> None:
        self.minimum_interval_seconds = minimum_interval_seconds
        self._lock = asyncio.Lock()
        self._last_started_at: float | None = None

    async def wait_for_slot(self) -> None:
        if self.minimum_interval_seconds <= 0:
            return
        async with self._lock:
            now = perf_counter()
            if self._last_started_at is not None:
                remaining = self.minimum_interval_seconds - (now - self._last_started_at)
                if remaining > 0:
                    await asyncio.sleep(remaining)
            self._last_started_at = perf_counter()


class _ProviderBase:
    def __init__(self, config: ProviderConfig) -> None:
        self.config = config
        self._semaphore = asyncio.Semaphore(config.concurrency)
        self._pacer = _RequestPacer(config.min_request_interval_seconds)

    async def generate(self, request: GenerationRequest) -> GenerationResponse:
        async with self._semaphore:
            attempts = max(self.config.max_retries + 1, 1)
            async for attempt in AsyncRetrying(
                stop=stop_after_attempt(attempts),
                wait=wait_exponential(multiplier=1, min=1, max=30),
                retry=retry_if_exception(
                    lambda exc: isinstance(exc, ProviderError) and exc.retryable
                ),
                reraise=True,
            ):
                with attempt:
                    try:
                        await self._pacer.wait_for_slot()
                        return await asyncio.wait_for(
                            self._generate_once(request), timeout=self.config.timeout_seconds
                        )
                    except TimeoutError as exc:
                        raise ProviderError("provider request timed out", retryable=True) from exc
                    except ProviderError as exc:
                        if not exc.retryable:
                            raise
                        raise
                    except Exception as exc:
                        raise _normalized_provider_error(exc, operation="provider request") from exc
        raise AssertionError("retry loop exited without returning or raising")

    async def _generate_once(self, request: GenerationRequest) -> GenerationResponse:
        raise NotImplementedError


class _EmbeddingProviderBase:
    def __init__(self, config: EmbeddingModelConfig) -> None:
        self.config = config
        self._semaphore = asyncio.Semaphore(config.concurrency)
        self._pacer = _RequestPacer(config.min_request_interval_seconds)

    async def embed(self, request: EmbeddingRequest) -> EmbeddingResponse:
        async with self._semaphore:
            attempts = max(self.config.max_retries + 1, 1)
            async for attempt in AsyncRetrying(
                stop=stop_after_attempt(attempts),
                wait=wait_exponential(multiplier=1, min=1, max=30),
                retry=retry_if_exception(
                    lambda exc: isinstance(exc, ProviderError) and exc.retryable
                ),
                reraise=True,
            ):
                with attempt:
                    try:
                        await self._pacer.wait_for_slot()
                        return await asyncio.wait_for(
                            self._embed_once(request), timeout=self.config.timeout_seconds
                        )
                    except TimeoutError as exc:
                        raise ProviderError(
                            "embedding provider request timed out", retryable=True
                        ) from exc
                    except ProviderError as exc:
                        if not exc.retryable:
                            raise
                        raise
                    except Exception as exc:
                        raise _normalized_provider_error(
                            exc, operation="embedding provider request"
                        ) from exc
        raise AssertionError("retry loop exited without returning or raising")

    async def _embed_once(self, request: EmbeddingRequest) -> EmbeddingResponse:
        raise NotImplementedError


class OpenAIProvider(_ProviderBase):
    def __init__(self, config: ProviderConfig, client: AsyncOpenAI | None = None) -> None:
        if config.provider != "openai":
            raise ValueError("OpenAIProvider requires provider=openai")
        api_key = os.getenv("OPENAI_API_KEY")
        if client is None and not api_key:
            raise ProviderError("OPENAI_API_KEY is not configured")
        self.client = client or AsyncOpenAI(
            api_key=api_key,
            organization=os.getenv("OPENAI_ORGANIZATION") or None,
            timeout=config.timeout_seconds,
        )
        super().__init__(config)

    async def _generate_once(self, request: GenerationRequest) -> GenerationResponse:
        started = perf_counter()
        parameters: dict[str, Any] = {
            "model": request.model,
            "messages": [{"role": "user", "content": request.prompt}],
            "temperature": request.temperature,
            "max_completion_tokens": request.max_output_tokens,
        }
        if request.reasoning_effort is not None:
            parameters["reasoning_effort"] = request.reasoning_effort
        response = await self.client.chat.completions.create(**parameters)
        text = response.choices[0].message.content
        if not text:
            raise ProviderError("OpenAI returned an empty response")
        usage = response.usage
        return GenerationResponse(
            text=text.strip(),
            model=response.model or request.model,
            provider="openai",
            usage=TokenUsage(
                input_tokens=getattr(usage, "prompt_tokens", None),
                output_tokens=getattr(usage, "completion_tokens", None),
                total_tokens=getattr(usage, "total_tokens", None),
            ),
            latency_ms=(perf_counter() - started) * 1000,
            request_id=getattr(response, "id", None),
        )


class GeminiProvider(_ProviderBase):
    def __init__(self, config: ProviderConfig, client: Any | None = None) -> None:
        if config.provider != "gemini":
            raise ValueError("GeminiProvider requires provider=gemini")
        api_key = os.getenv("GEMINI_API_KEY")
        if client is None and not api_key:
            raise ProviderError("GEMINI_API_KEY is not configured")
        self.client = client or genai.Client(api_key=api_key)
        super().__init__(config)

    async def _generate_once(self, request: GenerationRequest) -> GenerationResponse:
        if request.reasoning_effort is not None:
            raise ProviderError("Gemini generation roles do not support reasoning_effort")
        started = perf_counter()
        response = await self.client.aio.models.generate_content(
            model=request.model,
            contents=request.prompt,
            config=types.GenerateContentConfig(
                temperature=request.temperature,
                max_output_tokens=request.max_output_tokens,
            ),
        )
        text = getattr(response, "text", None)
        if not text:
            raise ProviderError("Gemini returned an empty response")
        usage = getattr(response, "usage_metadata", None)
        return GenerationResponse(
            text=text.strip(),
            model=getattr(response, "model_version", None) or request.model,
            provider="gemini",
            usage=TokenUsage(
                input_tokens=getattr(usage, "prompt_token_count", None),
                output_tokens=getattr(usage, "candidates_token_count", None),
                total_tokens=getattr(usage, "total_token_count", None),
            ),
            latency_ms=(perf_counter() - started) * 1000,
            request_id=getattr(response, "response_id", None),
        )


class OpenAIEmbeddingProvider(_EmbeddingProviderBase):
    def __init__(self, config: EmbeddingModelConfig, client: AsyncOpenAI | None = None) -> None:
        if config.provider != "openai":
            raise ValueError("OpenAIEmbeddingProvider requires provider=openai")
        api_key = os.getenv("OPENAI_API_KEY")
        if client is None and not api_key:
            raise ProviderError("OPENAI_API_KEY is not configured")
        self.client = client or AsyncOpenAI(
            api_key=api_key,
            organization=os.getenv("OPENAI_ORGANIZATION") or None,
            timeout=config.timeout_seconds,
        )
        super().__init__(config)

    async def _embed_once(self, request: EmbeddingRequest) -> EmbeddingResponse:
        if request.task_type is not None:
            raise ProviderError("OpenAI embedding roles do not support task_type")
        started = perf_counter()
        parameters: dict[str, Any] = {
            "model": request.model,
            "input": request.inputs,
            "encoding_format": "float",
        }
        if request.dimensions is not None:
            parameters["dimensions"] = request.dimensions
        response = await self.client.embeddings.create(**parameters)
        ordered = sorted(response.data, key=lambda item: item.index)
        embeddings = [list(item.embedding) for item in ordered]
        if len(embeddings) != len(request.inputs) or any(not vector for vector in embeddings):
            raise ProviderError("OpenAI returned malformed embeddings")
        usage = response.usage
        input_tokens = getattr(usage, "prompt_tokens", None)
        return EmbeddingResponse(
            embeddings=embeddings,
            model=response.model or request.model,
            provider="openai",
            usage=TokenUsage(
                input_tokens=input_tokens,
                total_tokens=getattr(usage, "total_tokens", None) or input_tokens,
            ),
            latency_ms=(perf_counter() - started) * 1000,
            request_id=getattr(response, "id", None),
        )


class GeminiEmbeddingProvider(_EmbeddingProviderBase):
    def __init__(self, config: EmbeddingModelConfig, client: Any | None = None) -> None:
        if config.provider != "gemini":
            raise ValueError("GeminiEmbeddingProvider requires provider=gemini")
        api_key = os.getenv("GEMINI_API_KEY")
        if client is None and not api_key:
            raise ProviderError("GEMINI_API_KEY is not configured")
        self.client = client or genai.Client(api_key=api_key)
        super().__init__(config)

    async def _embed_once(self, request: EmbeddingRequest) -> EmbeddingResponse:
        started = perf_counter()
        contents = [
            types.Content(parts=[types.Part.from_text(text=item)]) for item in request.inputs
        ]
        response = await self.client.aio.models.embed_content(
            model=request.model,
            contents=contents,
            config=types.EmbedContentConfig(
                task_type=request.task_type,
                output_dimensionality=request.dimensions,
            ),
        )
        raw_embeddings = getattr(response, "embeddings", None) or []
        embeddings = [list(getattr(item, "values", None) or []) for item in raw_embeddings]
        if len(embeddings) != len(request.inputs) or any(not vector for vector in embeddings):
            raise ProviderError("Gemini returned malformed embeddings")
        token_counts = [
            getattr(getattr(item, "statistics", None), "token_count", None)
            for item in raw_embeddings
        ]
        known_token_counts = [int(value) for value in token_counts if value is not None]
        input_tokens = sum(known_token_counts) if known_token_counts else None
        return EmbeddingResponse(
            embeddings=embeddings,
            model=getattr(response, "model_version", None) or request.model,
            provider="gemini",
            usage=TokenUsage(input_tokens=input_tokens, total_tokens=input_tokens),
            latency_ms=(perf_counter() - started) * 1000,
            request_id=getattr(response, "response_id", None),
        )


def create_provider(config: ProviderConfig) -> TextProvider:
    if config.provider == "openai":
        return OpenAIProvider(config)
    if config.provider == "gemini":
        return GeminiProvider(config)
    raise ValueError(f"unsupported provider: {config.provider}")


def create_embedding_provider(config: EmbeddingModelConfig) -> EmbeddingProvider:
    if config.provider == "openai":
        return OpenAIEmbeddingProvider(config)
    if config.provider == "gemini":
        return GeminiEmbeddingProvider(config)
    raise ValueError(f"unsupported embedding provider: {config.provider}")
