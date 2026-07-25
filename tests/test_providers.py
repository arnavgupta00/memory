from __future__ import annotations

import asyncio
from time import perf_counter
from types import SimpleNamespace

import pytest
from openai import LengthFinishReasonError
from openai.types.chat import ChatCompletion
from openai.types.completion_usage import CompletionUsage
from pydantic import BaseModel

from longmemeval.config import EmbeddingModelConfig, ProviderConfig
from longmemeval.models import EmbeddingRequest, GenerationRequest, PromptEnvelope, PromptMessage
from longmemeval.providers import (
    GeminiEmbeddingProvider,
    GeminiProvider,
    OpenAIEmbeddingProvider,
    OpenAIProvider,
    ProviderError,
)


class FakeOpenAICompletions:
    def __init__(self) -> None:
        self.last_kwargs = {}

    async def create(self, **kwargs):  # type: ignore[no-untyped-def]
        self.last_kwargs = kwargs
        return SimpleNamespace(
            id="openai-request",
            model=kwargs["model"],
            choices=[SimpleNamespace(message=SimpleNamespace(content="Pune"))],
            usage=SimpleNamespace(prompt_tokens=10, completion_tokens=2, total_tokens=12),
        )

    async def parse(self, **kwargs):  # type: ignore[no-untyped-def]
        self.last_kwargs = kwargs
        parsed = StructuredFixture(answer="Pune")
        return SimpleNamespace(
            id="openai-structured-request",
            model=kwargs["model"],
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(
                        content=parsed.model_dump_json(), parsed=parsed, refusal=None
                    )
                )
            ],
            usage=SimpleNamespace(prompt_tokens=12, completion_tokens=4, total_tokens=16),
        )


class FakeOpenAIClient:
    def __init__(self) -> None:
        self.completions = FakeOpenAICompletions()
        self.chat = SimpleNamespace(completions=self.completions)


class LengthThenSuccessOpenAICompletions(FakeOpenAICompletions):
    def __init__(self) -> None:
        super().__init__()
        self.attempts = 0

    async def parse(self, **kwargs):  # type: ignore[no-untyped-def]
        self.attempts += 1
        if self.attempts == 1:
            raise LengthFinishReasonError(
                completion=ChatCompletion(
                    id="length-limited",
                    choices=[
                        {
                            "finish_reason": "length",
                            "index": 0,
                            "logprobs": None,
                            "message": {"content": "", "role": "assistant"},
                        }
                    ],
                    created=0,
                    model=kwargs["model"],
                    object="chat.completion",
                    usage=CompletionUsage(
                        prompt_tokens=10,
                        completion_tokens=32_000,
                        total_tokens=32_010,
                    ),
                )
            )
        return await super().parse(**kwargs)


class LengthThenSuccessOpenAIClient:
    def __init__(self) -> None:
        self.completions = LengthThenSuccessOpenAICompletions()
        self.chat = SimpleNamespace(completions=self.completions)


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
        structured = getattr(kwargs.get("config"), "response_schema", None) is not None
        return SimpleNamespace(
            text='{"answer":"Pune"}' if structured else "Pune",
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


class TimedOpenAICompletions(FakeOpenAICompletions):
    def __init__(self) -> None:
        super().__init__()
        self.started_at: list[float] = []

    async def create(self, **kwargs):  # type: ignore[no-untyped-def]
        self.started_at.append(perf_counter())
        return await super().create(**kwargs)


class RateLimitErrorForTest(Exception):
    status_code = 429
    code = "rate_limit_exceeded"
    request_id = "req_rate_limit"


class StructuredFixture(BaseModel):
    answer: str


@pytest.mark.asyncio
async def test_openai_normalization() -> None:
    config = ProviderConfig(provider="openai", model="gpt-test", max_retries=0)
    provider = OpenAIProvider(config, client=FakeOpenAIClient())  # type: ignore[arg-type]
    response = await provider.generate(GenerationRequest(prompt="?", model="gpt-test"))
    assert response.text == "Pune"
    assert response.usage.total_tokens == 12
    assert response.request_id == "openai-request"


@pytest.mark.asyncio
async def test_openai_reasoning_effort_is_forwarded() -> None:
    config = ProviderConfig(
        provider="openai",
        model="gpt-test",
        temperature=1,
        reasoning_effort="minimal",
        max_retries=0,
    )
    client = FakeOpenAIClient()
    provider = OpenAIProvider(config, client=client)  # type: ignore[arg-type]
    await provider.generate(
        GenerationRequest(
            prompt="?",
            model="gpt-test",
            temperature=1,
            reasoning_effort="minimal",
        )
    )
    assert client.completions.last_kwargs["reasoning_effort"] == "minimal"


@pytest.mark.asyncio
async def test_gemini_normalization() -> None:
    config = ProviderConfig(provider="gemini", model="gemini-test", max_retries=0)
    provider = GeminiProvider(config, client=FakeGeminiClient())
    response = await provider.generate(GenerationRequest(prompt="?", model="gemini-test"))
    assert response.text == "Pune"
    assert response.usage.total_tokens == 11
    assert response.request_id == "gemini-request"


@pytest.mark.asyncio
@pytest.mark.parametrize("provider_name", ["openai", "gemini"])
async def test_provider_structured_output_is_schema_validated(provider_name: str) -> None:
    prompt = PromptEnvelope(
        prompt_id="fixture",
        messages=[PromptMessage(role="user", content="Where?")],
    )
    request = GenerationRequest(prompt=prompt.as_text(), model=f"{provider_name}-test")
    if provider_name == "openai":
        provider = OpenAIProvider(
            ProviderConfig(provider="openai", model="openai-test", max_retries=0),
            client=FakeOpenAIClient(),  # type: ignore[arg-type]
        )
    else:
        provider = GeminiProvider(
            ProviderConfig(provider="gemini", model="gemini-test", max_retries=0),
            client=FakeGeminiClient(),
        )
    response = await provider.generate_structured(request, prompt, StructuredFixture)
    assert response.value.answer == "Pune"
    assert response.generation.usage.total_tokens in {11, 16}


@pytest.mark.asyncio
async def test_openai_structured_output_adapts_to_length_limit_and_accounts_usage() -> None:
    client = LengthThenSuccessOpenAIClient()
    provider = OpenAIProvider(
        ProviderConfig(provider="openai", model="gpt-test", max_retries=0),
        client=client,  # type: ignore[arg-type]
    )
    prompt = PromptEnvelope(
        prompt_id="fixture",
        messages=[PromptMessage(role="user", content="Where?")],
    )
    request = GenerationRequest(prompt=prompt.as_text(), model="gpt-test", max_output_tokens=32_000)
    response = await provider.generate_structured(request, prompt, StructuredFixture)
    assert client.completions.attempts == 2
    assert client.completions.last_kwargs["max_completion_tokens"] == 64_000
    assert response.generation.retry_count == 1
    assert response.generation.usage.input_tokens == 22
    assert response.generation.usage.output_tokens == 32_004
    assert response.generation.usage.total_tokens == 32_026


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


@pytest.mark.asyncio
async def test_provider_spaces_request_starts() -> None:
    completions = TimedOpenAICompletions()
    config = ProviderConfig(
        provider="openai",
        model="gpt-test",
        concurrency=2,
        max_retries=0,
        min_request_interval_seconds=0.02,
    )
    provider = OpenAIProvider(  # type: ignore[arg-type]
        config, client=CustomOpenAIClient(completions)
    )
    await asyncio.gather(
        provider.generate(GenerationRequest(prompt="one", model="gpt-test")),
        provider.generate(GenerationRequest(prompt="two", model="gpt-test")),
    )
    assert len(completions.started_at) == 2
    assert completions.started_at[1] - completions.started_at[0] >= 0.015


@pytest.mark.asyncio
async def test_provider_preserves_error_metadata() -> None:
    class FailingCompletions:
        async def create(self, **kwargs):  # type: ignore[no-untyped-def]
            raise RateLimitErrorForTest("wait before retrying")

    config = ProviderConfig(provider="openai", model="gpt-test", max_retries=0)
    provider = OpenAIProvider(  # type: ignore[arg-type]
        config, client=CustomOpenAIClient(FailingCompletions())
    )
    with pytest.raises(ProviderError, match="wait before retrying") as captured:
        await provider.generate(GenerationRequest(prompt="?", model="gpt-test"))
    assert captured.value.retryable is True
    assert captured.value.status_code == 429
    assert captured.value.provider_code == "rate_limit_exceeded"
    assert captured.value.request_id == "req_rate_limit"
