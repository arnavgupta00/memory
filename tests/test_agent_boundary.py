from __future__ import annotations

from pathlib import Path

import pytest

from longmemeval.agent_loader import load_agent
from longmemeval.artifacts import NullArtifactStore
from longmemeval.config import AgentConfig


def test_source_tree_has_only_harness_and_agent_packages() -> None:
    source = Path(__file__).parents[1] / "src"
    directories = {path.name for path in source.iterdir() if path.is_dir()}
    assert directories == {"agents", "longmemeval"}


def test_active_architecture_contains_no_python_algorithm_modules() -> None:
    current = Path(__file__).parents[1] / "src" / "agents" / "current"
    python_sources = [path for path in current.rglob("*.py") if "node_modules" not in path.parts]
    assert not python_sources
    assert (current / "src" / "workflow.ts").is_file()
    assert (current / "src" / "state.ts").is_file()
    assert (current / "src" / "host.ts").is_file()


def test_node_agent_requires_the_run_scoped_host() -> None:
    config = AgentConfig.model_validate(
        {
            "backend": "node",
            "entrypoint": "src/agents/current/dist/host.js",
            "provider_model_limits": [
                {
                    "provider": "openai",
                    "model": "gpt-test",
                    "max_concurrency": 2,
                    "token_budget": 160000,
                    "window_seconds": 60,
                }
            ],
            "models": {
                "contexto": {"kind": "generation", "provider": "openai", "model": "gpt-test"},
                "shino": {"kind": "generation", "provider": "openai", "model": "gpt-test"},
                "reader": {"kind": "generation", "provider": "openai", "model": "gpt-test"},
            },
        }
    )
    with pytest.raises(ValueError, match="run-scoped host"):
        load_agent(config, None, NullArtifactStore(), None)
