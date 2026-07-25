from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Annotated, Any, Literal

import yaml
from pydantic import BaseModel, Field, field_validator, model_validator


class ProviderConfig(BaseModel):
    provider: Literal["openai", "gemini"]
    model: str = Field(min_length=1)
    temperature: float = Field(default=0.0, ge=0.0, le=2.0)
    reasoning_effort: Literal["none", "minimal", "low", "medium", "high", "xhigh", "max"] | None = (
        None
    )
    max_output_tokens: int = Field(default=800, gt=0)
    timeout_seconds: float = Field(default=120.0, gt=0)
    concurrency: int = Field(default=1, ge=1, le=64)
    max_retries: int = Field(default=5, ge=0, le=20)
    min_request_interval_seconds: float = Field(default=0.0, ge=0.0, le=600.0)
    input_price_per_million: float | None = Field(default=None, ge=0)
    output_price_per_million: float | None = Field(default=None, ge=0)

    @field_validator("model")
    @classmethod
    def reject_alias_placeholders(cls, value: str) -> str:
        if value.strip().lower() in {"latest", "default", "model-name"}:
            raise ValueError("use an explicit provider model ID")
        return value.strip()

    @model_validator(mode="after")
    def provider_options_match(self) -> ProviderConfig:
        if self.provider == "gemini" and self.reasoning_effort is not None:
            raise ValueError("reasoning_effort is supported only by OpenAI generation roles")
        return self


class GenerationModelConfig(ProviderConfig):
    """A named text-generation role available to an agent."""

    kind: Literal["generation"] = "generation"


class EmbeddingModelConfig(BaseModel):
    """A named text-embedding role available to an agent."""

    kind: Literal["embedding"] = "embedding"
    provider: Literal["openai", "gemini"]
    model: str = Field(min_length=1)
    dimensions: int | None = Field(default=None, gt=0)
    task_type: str | None = Field(default=None, min_length=1)
    timeout_seconds: float = Field(default=120.0, gt=0)
    concurrency: int = Field(default=1, ge=1, le=64)
    max_retries: int = Field(default=5, ge=0, le=20)
    min_request_interval_seconds: float = Field(default=0.0, ge=0.0, le=600.0)
    input_price_per_million: float | None = Field(default=None, ge=0)

    @field_validator("model")
    @classmethod
    def reject_alias_placeholders(cls, value: str) -> str:
        return ProviderConfig.reject_alias_placeholders(value)

    @model_validator(mode="after")
    def provider_options_match(self) -> EmbeddingModelConfig:
        if self.provider == "openai" and self.task_type is not None:
            raise ValueError("task_type is supported only by Gemini embedding roles")
        return self


ModelRoleConfig = Annotated[
    GenerationModelConfig | EmbeddingModelConfig,
    Field(discriminator="kind"),
]


class JudgeConfig(BaseModel):
    provider: Literal["openai"] = "openai"
    model: Literal["gpt-4o-2024-08-06"] = "gpt-4o-2024-08-06"
    temperature: Literal[0] = 0


class ProviderModelLimitConfig(BaseModel):
    provider: Literal["openai", "gemini"]
    model: str = Field(min_length=1)
    max_concurrency: int = Field(ge=1, le=64)
    token_budget: int = Field(ge=1)
    window_seconds: int = Field(ge=1, le=3600)

    @field_validator("model")
    @classmethod
    def normalize_model(cls, value: str) -> str:
        return ProviderConfig.reject_alias_placeholders(value)


class AgentConfig(BaseModel):
    backend: Literal["python", "node"] = "python"
    entrypoint: str = Field(min_length=3)
    models: dict[str, ModelRoleConfig] = Field(default_factory=dict)
    options: dict[str, Any] = Field(default_factory=dict)
    provider_model_limits: list[ProviderModelLimitConfig] = Field(default_factory=list)

    @field_validator("models")
    @classmethod
    def validate_model_role_names(
        cls, value: dict[str, ModelRoleConfig]
    ) -> dict[str, ModelRoleConfig]:
        reserved = {"answer", "judge", "canonical-judge", "canonical_judge"}
        for role in value:
            if (
                not role
                or not role[0].isalpha()
                or any(
                    character not in "abcdefghijklmnopqrstuvwxyz0123456789_-" for character in role
                )
            ):
                raise ValueError(
                    "model role names must start with a letter and use lowercase letters, "
                    "numbers, underscores, or dashes"
                )
            if role in reserved:
                raise ValueError(f"model role name is reserved: {role}")
        return value

    @model_validator(mode="after")
    def entrypoint_matches_backend(self) -> AgentConfig:
        python_entrypoint = re.fullmatch(
            r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*:[A-Za-z_]\w*", self.entrypoint
        )
        node_entrypoint = re.fullmatch(r"[A-Za-z0-9_.\-/]+\.js", self.entrypoint)
        if self.backend == "python" and python_entrypoint is None:
            raise ValueError("Python agent entrypoint must use module:factory")
        if self.backend == "node" and (
            node_entrypoint is None or ".." in Path(self.entrypoint).parts
        ):
            raise ValueError("Node agent entrypoint must be a safe project-relative .js path")
        if self.backend == "node" and any(
            not isinstance(role, GenerationModelConfig) for role in self.models.values()
        ):
            raise ValueError("Node agent backends support generation roles only")
        limit_keys = {(limit.provider, limit.model) for limit in self.provider_model_limits}
        if len(limit_keys) != len(self.provider_model_limits):
            raise ValueError("provider/model rate limits must use unique provider and model pairs")
        if self.backend == "node":
            missing = {
                (role.provider, role.model)
                for role in self.models.values()
                if (role.provider, role.model) not in limit_keys
            }
            if missing:
                formatted = ", ".join(f"{provider}/{model}" for provider, model in sorted(missing))
                raise ValueError(
                    f"Node agent roles are missing provider/model rate limits: {formatted}"
                )
        return self


class SelectionConfig(BaseModel):
    strategy: Literal["all", "canonical-smoke", "canary-1", "canary-2"] = "all"


class ExecutionConfig(BaseModel):
    case_concurrency: int = Field(default=1, ge=1, le=32)
    capture_model_io: bool = False
    auto_export_final_svg: bool = False


class RunConfig(BaseModel):
    name: str = Field(min_length=1, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
    mode: Literal["oracle", "full-context"]
    agent: AgentConfig
    answer: ProviderConfig
    judge: JudgeConfig = Field(default_factory=JudgeConfig)
    selection: SelectionConfig = Field(default_factory=SelectionConfig)
    execution: ExecutionConfig = Field(default_factory=ExecutionConfig)

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
