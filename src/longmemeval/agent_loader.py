from __future__ import annotations

import importlib
from collections.abc import Callable
from typing import Any, cast

from longmemeval.config import AgentConfig, ProviderConfig
from longmemeval.models import AgentRuntime, MemoryAgent, TextProvider


def load_agent(
    config: AgentConfig,
    provider: TextProvider,
    provider_config: ProviderConfig,
) -> MemoryAgent:
    """Load an agent factory without requiring changes to the benchmark harness."""

    module_name, factory_name = config.entrypoint.split(":", maxsplit=1)
    try:
        module = importlib.import_module(module_name)
    except ImportError as exc:
        raise ValueError(f"cannot import agent module {module_name!r}") from exc
    factory_value: Any = getattr(module, factory_name, None)
    if not callable(factory_value):
        raise ValueError(f"agent entrypoint is not callable: {config.entrypoint}")
    factory = cast(Callable[[AgentRuntime], object], factory_value)
    runtime = AgentRuntime(
        provider=provider,
        answer_model=provider_config.model,
        temperature=provider_config.temperature,
        max_output_tokens=provider_config.max_output_tokens,
        options=dict(config.options),
    )
    agent = factory(runtime)
    missing = [
        name for name in ("reset", "ingest", "answer") if not callable(getattr(agent, name, None))
    ]
    if missing:
        raise TypeError(f"agent {config.entrypoint} is missing methods: {', '.join(missing)}")
    return cast(MemoryAgent, agent)
