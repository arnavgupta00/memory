from __future__ import annotations

import json
from pathlib import Path
from string import Formatter

import yaml
from pydantic import BaseModel, ConfigDict

from agents.baselines.full_context.config import FullContextConfig
from longmemeval.api import JsonValue, TimestampedSession


class PromptTemplate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: int
    id: str
    description: str
    required_variables: list[str]
    template: str
    variants: dict[str, dict[str, str]]


def load_prompt_template(configured_path: str) -> PromptTemplate:
    path = Path(configured_path)
    if not path.is_absolute():
        path = Path(__file__).resolve().parent / path
    raw: JsonValue = yaml.safe_load(path.read_text(encoding="utf-8"))
    template = PromptTemplate.model_validate(raw)
    placeholders = {
        field_name
        for _, field_name, format_spec, conversion in Formatter().parse(template.template)
        if field_name is not None and not format_spec and not conversion
    }
    if placeholders != set(template.required_variables):
        raise ValueError("full-context prompt variable contract mismatch")
    return template


def _format_sessions(sessions: list[TimestampedSession], history_format: str) -> str:
    blocks: list[str] = []
    for index, session in enumerate(sessions, start=1):
        if history_format == "json":
            content = json.dumps([turn.model_dump() for turn in session.turns], ensure_ascii=False)
        else:
            content = "\n".join(f"{turn.role}: {turn.content}" for turn in session.turns)
        blocks.append(
            f"### Session {index}:\nSession Date: {session.date}\nSession Content:\n{content}"
        )
    return "\n\n".join(blocks)


def answer_prompt(
    sessions: list[TimestampedSession],
    question: str,
    question_date: str,
    config: FullContextConfig,
) -> str:
    template = load_prompt_template(config.prompt_template)
    variant = template.variants["chain_of_note" if config.chain_of_note else "direct"]
    variables = {
        "history": _format_sessions(sessions, config.history_format),
        "question_date": question_date,
        "question": question,
        **variant,
    }
    return template.template.format_map(variables)
