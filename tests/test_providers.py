from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from longmemeval.config import EmbeddingModelConfig, ProviderConfig
from longmemeval.models import EmbeddingRequest, GenerationRequest
from longmemeval.providers import (
    GeminiEmbeddingProvider,
    GeminiProvider,
    OpenAIEmbeddingProvider,
    OpenAIProvider,
    ProviderError,
)


class FakeOpenAICompletions:
    async def create(self, **kwargs):  # type: ignore[no-untyped-def]
        return SimpleNamespace(
            id="openai-request",
            model=kwargs["model"],
            choices=[SimpleNamespace(message=SimpleNamespace(content="Pune"))],
            usage=SimpleNamespace(prompt_tokens=10, completion_tokens=2, total_tokens=12),
        )


class FakeOpenAIClient:
    def __init__(self) -> None:
        self.chat = SimpleNamespace(completions=FakeOpenAICompletions())


class FakeOpenAIEmbeddings:
    async def create(self, **kwargs):  # type: ignore[no-untyped-def]
        assert kwargs["dimensions"] == 2
        return SimpleNamespace(
            id="openai-embedding-request",
            model=kwargs["model"],
            data=[
                SimpleNamespace(index=1, embedding=[0.0, 1.0]),
                SimpleNamespace(index=0, embedding=[1.0, 0.0]),
            ],
            usage=SimpleNamespace(prompt_tokens=8, total_tokens=8),
        )


class FakeOpenAIEmbeddingClient:
    def __init__(self) -> None:
        self.embeddings = FakeOpenAIEmbeddings()


class FakeGeminiModels:
    async def generate_content(self, **kwargs):  # type: ignore[no-untyped-def]
        return SimpleNamespace(
            text="Pune",
            model_version=kwargs["model"],
            response_id="gemini-request",
            usage_metadata=SimpleNamespace(
                prompt_token_count=9, candidates_token_count=2, total_token_count=11
            ),
        )


class FakeGeminiClient:
    def __init__(self) -> None:
        self.aio = SimpleNamespace(models=FakeGeminiModels())


class FakeGeminiEmbeddingModels:
    async def embed_content(self, **kwargs):  # type: ignore[no-untyped-def]
        assert kwargs["config"].output_dimensionality == 2
        return SimpleNamespace(
            embeddings=[
                SimpleNamespace(values=[1.0, 0.0], statistics=SimpleNamespace(token_count=3)),
                SimpleNamespace(values=[0.0, 1.0], statistics=SimpleNamespace(token_count=4)),
            ],
            model_version=kwargs["model"],
            response_id="gemini-embedding-request",
        )


class FakeGeminiEmbeddingClient:
    def __init__(self) -> None:
        self.aio = SimpleNamespace(models=FakeGeminiEmbeddingModels())


class EmptyOpenAICompletions:
    async def create(self, **kwargs):  # type: ignore[no-untyped-def]
        return SimpleNamespace(
            id="empty",
            model=kwargs["model"],
            choices=[SimpleNamespace(message=SimpleNamespace(content=""))],
            usage=None,
        )


class SlowOpenAICompletions:
    async def create(self, **kwargs):  # type: ignore[no-untyped-def]
        await asyncio.sleep(0.1)


class CustomOpenAIClient:
    def __init__(self, completions) -> None:  # type: ignore[no-untyped-def]
        self.chat = SimpleNamespace(completions=completions)


@pytest.mark.asyncio
async def test_openai_normalization() -> None:
    config = ProviderConfig(provider="openai", model="gpt-test", max_retries=0)
    provider = OpenAIProvider(config, client=FakeOpenAIClient())  # type: ignore[arg-type]
    response = await provider.generate(GenerationRequest(prompt="?", model="gpt-test"))
    assert response.text == "Pune"
    assert response.usage.total_tokens == 12
    assert response.request_id == "openai-request"


@pytest.mark.asyncio
async def test_gemini_normalization() -> None:
    config = ProviderConfig(provider="gemini", model="gemini-test", max_retries=0)
    provider = GeminiProvider(config, client=FakeGeminiClient())
    response = await provider.generate(GenerationRequest(prompt="?", model="gemini-test"))
    assert response.text == "Pune"
    assert response.usage.total_tokens == 11
    assert response.request_id == "gemini-request"


@pytest.mark.asyncio
async def test_openai_embedding_normalization_and_ordering() -> None:
    config = EmbeddingModelConfig(
        provider="openai", model="text-embedding-test", dimensions=2, max_retries=0
    )
    provider = OpenAIEmbeddingProvider(  # type: ignore[arg-type]
        config, client=FakeOpenAIEmbeddingClient()
    )
    response = await provider.embed(
        EmbeddingRequest(inputs=["first", "second"], model=config.model, dimensions=2)
    )
    assert response.embeddings == [[1.0, 0.0], [0.0, 1.0]]
    assert response.usage.total_tokens == 8
    assert response.request_id == "openai-embedding-request"


@pytest.mark.asyncio
async def test_gemini_embedding_normalization() -> None:
    config = EmbeddingModelConfig(
        provider="gemini",
        model="gemini-embedding-test",
        dimensions=2,
        task_type="RETRIEVAL_DOCUMENT",
        max_retries=0,
    )
    provider = GeminiEmbeddingProvider(config, client=FakeGeminiEmbeddingClient())
    response = await provider.embed(
        EmbeddingRequest(
            inputs=["first", "second"],
            model=config.model,
            dimensions=2,
            task_type="RETRIEVAL_DOCUMENT",
        )
    )
    assert response.embeddings == [[1.0, 0.0], [0.0, 1.0]]
    assert response.usage.input_tokens == 7
    assert response.request_id == "gemini-embedding-request"


def test_missing_openai_credential(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    config = ProviderConfig(provider="openai", model="gpt-test")
    with pytest.raises(ProviderError, match="not configured"):
        OpenAIProvider(config)


@pytest.mark.asyncio
async def test_empty_provider_response_is_not_retried() -> None:
    config = ProviderConfig(provider="openai", model="gpt-test", max_retries=2)
    provider = OpenAIProvider(  # type: ignore[arg-type]
        config, client=CustomOpenAIClient(EmptyOpenAICompletions())
    )
    with pytest.raises(ProviderError, match="empty response") as captured:
        await provider.generate(GenerationRequest(prompt="?", model="gpt-test"))
    assert captured.value.retryable is False


@pytest.mark.asyncio
async def test_provider_timeout_is_structured() -> None:
    config = ProviderConfig(
        provider="openai", model="gpt-test", timeout_seconds=0.01, max_retries=0
    )
    provider = OpenAIProvider(  # type: ignore[arg-type]
        config, client=CustomOpenAIClient(SlowOpenAICompletions())
    )
    with pytest.raises(ProviderError, match="timed out") as captured:
        await provider.generate(GenerationRequest(prompt="?", model="gpt-test"))
    assert captured.value.retryable is True
