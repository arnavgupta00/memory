from __future__ import annotations

import importlib
from collections.abc import Callable
from typing import Any, cast

from longmemeval.artifacts import NullArtifactStore
from longmemeval.config import AgentConfig
from longmemeval.models import AgentArtifactStore, AgentRuntime, MemoryAgent, ModelGateway
from longmemeval.node_agent import NodeAgentHost, NodeMemoryAgent


def load_agent(
    config: AgentConfig,
    models: ModelGateway | None,
    artifacts: AgentArtifactStore | None = None,
    node_host: NodeAgentHost | None = None,
) -> MemoryAgent:
    """Load an agent factory without requiring changes to the benchmark harness."""

    if config.backend == "node":
        if node_host is None:
            raise ValueError("Node agent backend requires a run-scoped host")
        return NodeMemoryAgent(node_host)
    if models is None:
        raise ValueError("Python agent backend requires a model gateway")

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
        models=models,
        artifacts=artifacts or NullArtifactStore(),
        options=dict(config.options),
    )
    agent = factory(runtime)
    missing = [
        name for name in ("reset", "ingest", "answer") if not callable(getattr(agent, name, None))
    ]
    if missing:
        raise TypeError(f"agent {config.entrypoint} is missing methods: {', '.join(missing)}")
    return cast(MemoryAgent, agent)
