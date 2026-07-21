from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from longmemeval.config import ProviderConfig
from longmemeval.models import GenerationRequest
from longmemeval.providers import GeminiProvider, OpenAIProvider, ProviderError


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
