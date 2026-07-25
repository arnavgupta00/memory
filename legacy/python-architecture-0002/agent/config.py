from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class CurrentArchitectureConfig(BaseModel):
    """Architecture 0002 knobs. B=3/B=9 configs differ only in batch_size and run name."""

    model_config = ConfigDict(extra="forbid")

    batch_size: int = Field(default=3, ge=1, le=32)
    batch_role: str = "memory_consolidator"
    planner_role: str = "query_planner"
    reranker_role: str = "evidence_reranker"
    answer_role: str = "answer"
    prompt_directory: str = "prompts"
    candidate_limit: int = Field(default=30, ge=1, le=100)
    evidence_limit: int = Field(default=12, ge=1, le=30)
    historical_session_limit: int = Field(default=8, ge=1, le=30)
    latest_session_count: int = Field(default=9, ge=1, le=30)
    context_character_budget: int = Field(default=70_000, ge=5_000, le=500_000)
    rrf_k: int = Field(default=60, ge=1, le=500)
