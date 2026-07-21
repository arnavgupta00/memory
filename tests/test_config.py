from pathlib import Path

import pytest
from pydantic import ValidationError

from longmemeval.config import RunConfig, load_config


def test_loads_example_configs() -> None:
    root = Path(__file__).parents[1]
    config_dir = root / "src" / "agents" / "current" / "configs"
    for path in sorted(config_dir.glob("*.yaml")):
        config = load_config(path)
        assert config.agent.entrypoint == "agents.current:create_agent"
        assert config.answer.model
        assert config.judge.model == "gpt-4o-2024-08-06"


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
                "agent": {"entrypoint": "agents.current:create_agent"},
                "answer": {"provider": "openai", "model": "gpt-4.1-2025-04-14"},
                "selection": {"strategy": "canary-2"},
            }
        )


def test_fingerprint_is_stable() -> None:
    data = {
        "name": "stable",
        "mode": "oracle",
        "agent": {"entrypoint": "agents.current:create_agent"},
        "answer": {"provider": "gemini", "model": "gemini-3.1-pro-preview"},
    }
    assert (
        RunConfig.model_validate(data).fingerprint() == RunConfig.model_validate(data).fingerprint()
    )
