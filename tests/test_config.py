from pathlib import Path

import pytest
from pydantic import ValidationError

from longmemeval.config import RunConfig, load_config


def test_loads_example_configs() -> None:
    root = Path(__file__).parents[1]
    config_dir = root / "src" / "agents" / "current" / "configs"
    for path in sorted(config_dir.rglob("*.yaml")):
        config = load_config(path)
        assert config.agent.backend == "node"
        assert config.agent.entrypoint == "src/agents/current/dist/host.js"
        assert set(config.agent.models) == {"contexto", "shino", "reader"}
        assert config.agent.provider_model_limits
        assert config.answer.model
        assert config.judge.model == "gpt-4o-2024-08-06"


def test_frozen_baseline_configs_remain_runnable() -> None:
    root = Path(__file__).parents[1]
    config_dir = root / "src" / "agents" / "baselines" / "full_context" / "configs"
    for path in sorted(config_dir.rglob("*.yaml")):
        config = load_config(path)
        assert config.agent.entrypoint == "agents.baselines.full_context:create_agent"
        assert config.answer.model


def test_b3_b9_experiment_differs_only_by_name_and_batch_size() -> None:
    root = Path(__file__).parents[1] / "src" / "agents" / "current" / "configs"
    b3 = load_config(root / "architecture-0003-openai-b3-c9.yaml").canonical_dict()
    b9 = load_config(root / "architecture-0003-openai-b9-c9.yaml").canonical_dict()
    b3["name"] = "experiment"
    b9["name"] = "experiment"
    assert isinstance(b3["agent"], dict)
    assert isinstance(b9["agent"], dict)
    assert isinstance(b3["agent"]["options"], dict)
    assert isinstance(b9["agent"]["options"], dict)
    b3["agent"]["options"]["graph_batch_size"] = 0
    b9["agent"]["options"]["graph_batch_size"] = 0
    assert b3 == b9


def test_rejects_invalid_agent_entrypoint() -> None:
    with pytest.raises(ValidationError, match="entrypoint"):
        RunConfig.model_validate(
            {
                "name": "bad",
                "mode": "full-context",
                "agent": {"entrypoint": "not a valid entrypoint"},
                "answer": {"provider": "openai", "model": "gpt-4.1-2025-04-14"},
            }
        )


def test_rejects_canary_over_oracle_data() -> None:
    with pytest.raises(ValidationError, match="canary selections require full-context"):
        RunConfig.model_validate(
            {
                "name": "bad-canary",
                "mode": "oracle",
                "agent": {"entrypoint": "agents.baselines.full_context:create_agent"},
                "answer": {"provider": "openai", "model": "gpt-4.1-2025-04-14"},
                "selection": {"strategy": "canary-2"},
            }
        )


def test_fingerprint_is_stable() -> None:
    data = {
        "name": "stable",
        "mode": "oracle",
        "agent": {"entrypoint": "agents.baselines.full_context:create_agent"},
        "answer": {"provider": "gemini", "model": "gemini-3.1-pro-preview"},
    }
    assert (
        RunConfig.model_validate(data).fingerprint() == RunConfig.model_validate(data).fingerprint()
    )


def test_named_generation_and_embedding_roles_are_validated() -> None:
    config = RunConfig.model_validate(
        {
            "name": "multi-model",
            "mode": "full-context",
            "agent": {
                "entrypoint": "agents.baselines.full_context:create_agent",
                "models": {
                    "memory_writer": {
                        "kind": "generation",
                        "provider": "gemini",
                        "model": "gemini-test",
                    },
                    "memory_embedder": {
                        "kind": "embedding",
                        "provider": "openai",
                        "model": "text-embedding-test",
                        "dimensions": 256,
                    },
                },
            },
            "answer": {"provider": "openai", "model": "gpt-test"},
        }
    )
    assert config.agent.models["memory_writer"].kind == "generation"
    assert config.agent.models["memory_embedder"].kind == "embedding"


def test_node_roles_require_unique_provider_model_limits() -> None:
    base = {
        "backend": "node",
        "entrypoint": "src/agents/current/dist/host.js",
        "models": {
            "contexto": {
                "kind": "generation",
                "provider": "openai",
                "model": "gpt-test",
            }
        },
    }
    with pytest.raises(ValidationError, match="missing provider/model rate limits"):
        RunConfig.model_validate(
            {
                "name": "missing-limit",
                "mode": "full-context",
                "agent": base,
                "answer": {"provider": "openai", "model": "gpt-test"},
            }
        )
    with pytest.raises(ValidationError, match="unique provider and model pairs"):
        RunConfig.model_validate(
            {
                "name": "duplicate-limit",
                "mode": "full-context",
                "agent": {
                    **base,
                    "provider_model_limits": [
                        {
                            "provider": "openai",
                            "model": "gpt-test",
                            "max_concurrency": 2,
                            "token_budget": 160000,
                            "window_seconds": 60,
                        },
                        {
                            "provider": "openai",
                            "model": "gpt-test",
                            "max_concurrency": 2,
                            "token_budget": 160000,
                            "window_seconds": 60,
                        },
                    ],
                },
                "answer": {"provider": "openai", "model": "gpt-test"},
            }
        )


def test_gemini_generation_rejects_openai_reasoning_effort() -> None:
    with pytest.raises(ValidationError, match="reasoning_effort"):
        RunConfig.model_validate(
            {
                "name": "bad-gemini-reasoning",
                "mode": "full-context",
                "agent": {"entrypoint": "agents.baselines.full_context:create_agent"},
                "answer": {
                    "provider": "gemini",
                    "model": "gemini-test",
                    "reasoning_effort": "minimal",
                },
            }
        )


@pytest.mark.parametrize("role", ["answer", "judge", "BadRole", "memory.writer"])
def test_rejects_reserved_or_invalid_model_roles(role: str) -> None:
    with pytest.raises(ValidationError, match="model role"):
        RunConfig.model_validate(
            {
                "name": "bad-role",
                "mode": "full-context",
                "agent": {
                    "entrypoint": "agents.baselines.full_context:create_agent",
                    "models": {
                        role: {
                            "kind": "generation",
                            "provider": "openai",
                            "model": "gpt-test",
                        }
                    },
                },
                "answer": {"provider": "openai", "model": "gpt-test"},
            }
        )
