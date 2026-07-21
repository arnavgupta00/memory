from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, Field, field_validator, model_validator


class ProviderConfig(BaseModel):
    provider: Literal["openai", "gemini"]
    model: str = Field(min_length=1)
    temperature: float = Field(default=0.0, ge=0.0, le=2.0)
    max_output_tokens: int = Field(default=800, gt=0)
    timeout_seconds: float = Field(default=120.0, gt=0)
    concurrency: int = Field(default=1, ge=1, le=64)
    max_retries: int = Field(default=5, ge=0, le=20)
    input_price_per_million: float | None = Field(default=None, ge=0)
    output_price_per_million: float | None = Field(default=None, ge=0)

    @field_validator("model")
    @classmethod
    def reject_alias_placeholders(cls, value: str) -> str:
        if value.strip().lower() in {"latest", "default", "model-name"}:
            raise ValueError("use an explicit provider model ID")
        return value.strip()


class JudgeConfig(BaseModel):
    provider: Literal["openai"] = "openai"
    model: Literal["gpt-4o-2024-08-06"] = "gpt-4o-2024-08-06"
    temperature: Literal[0] = 0


class AgentConfig(BaseModel):
    entrypoint: str = Field(
        min_length=3,
        pattern=r"^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*:[A-Za-z_]\w*$",
    )
    options: dict[str, Any] = Field(default_factory=dict)


class SelectionConfig(BaseModel):
    strategy: Literal["all", "canonical-smoke", "canary-1", "canary-2"] = "all"


class RunConfig(BaseModel):
    name: str = Field(min_length=1, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
    mode: Literal["oracle", "full-context"]
    agent: AgentConfig
    answer: ProviderConfig
    judge: JudgeConfig = Field(default_factory=JudgeConfig)
    selection: SelectionConfig = Field(default_factory=SelectionConfig)

    @model_validator(mode="after")
    def selection_matches_dataset(self) -> RunConfig:
        if self.mode == "oracle" and self.selection.strategy.startswith("canary-"):
            raise ValueError("canary selections require full-context mode")
        return self

    def canonical_dict(self) -> dict[str, object]:
        return self.model_dump(mode="json", exclude_none=True)

    def fingerprint(self) -> str:
        encoded = json.dumps(self.canonical_dict(), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(encoded.encode()).hexdigest()


def load_config(path: Path) -> RunConfig:
    raw = yaml.safe_load(path.read_text())
    if not isinstance(raw, dict):
        raise ValueError(f"configuration must be a YAML object: {path}")
    return RunConfig.model_validate(raw)
