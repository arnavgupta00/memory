from __future__ import annotations

import json
from pathlib import Path
from string import Formatter
from typing import Any

import yaml
from pydantic import BaseModel, ConfigDict

from agents.current.config import CurrentArchitectureConfig
from longmemeval.api import TimestampedSession


class PromptTemplate(BaseModel):
    """Validated, architecture-owned prompt definition loaded from YAML."""

    model_config = ConfigDict(extra="forbid")

    schema_version: int
    id: str
    description: str
    required_variables: list[str]
    template: str
    variants: dict[str, dict[str, str]]


def _prompt_path(configured_path: str) -> Path:
    path = Path(configured_path)
    if not path.is_absolute():
        path = Path(__file__).resolve().parent / path
    return path.resolve()


def load_prompt_template(configured_path: str) -> PromptTemplate:
    """Load a prompt and reject ambiguous or undeclared placeholders."""

    path = _prompt_path(configured_path)
    try:
        raw: Any = yaml.safe_load(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValueError(f"prompt template not found: {path}") from exc
    template = PromptTemplate.model_validate(raw)
    if template.schema_version != 1:
        raise ValueError(f"unsupported prompt schema version: {template.schema_version}")

    placeholders: set[str] = set()
    for _, field_name, format_spec, conversion in Formatter().parse(template.template):
        if field_name is None:
            continue
        if not field_name.isidentifier() or format_spec or conversion:
            raise ValueError(f"unsupported prompt placeholder: {field_name!r}")
        placeholders.add(field_name)

    declared = set(template.required_variables)
    if len(declared) != len(template.required_variables):
        raise ValueError("required_variables contains duplicates")
    if placeholders != declared:
        missing = sorted(declared - placeholders)
        undeclared = sorted(placeholders - declared)
        raise ValueError(
            f"prompt variable contract mismatch; missing={missing}, undeclared={undeclared}"
        )
    return template


def format_sessions(sessions: list[TimestampedSession], history_format: str) -> str:
    blocks: list[str] = []
    for index, session in enumerate(sessions, start=1):
        if history_format == "json":
            content = json.dumps([turn.model_dump() for turn in session.turns], ensure_ascii=False)
        elif history_format == "text":
            content = "\n".join(f"{turn.role}: {turn.content}" for turn in session.turns)
        else:
            raise ValueError(f"unsupported history format: {history_format}")
        blocks.append(
            f"### Session {index}:\nSession Date: {session.date}\nSession Content:\n{content}"
        )
    return "\n\n".join(blocks)


def answer_prompt(
    sessions: list[TimestampedSession],
    question: str,
    question_date: str,
    config: CurrentArchitectureConfig,
) -> str:
    history = format_sessions(sessions, config.history_format)
    prompt_template = load_prompt_template(config.prompt_template)
    variant_name = "chain_of_note" if config.chain_of_note else "direct"
    try:
        variant = prompt_template.variants[variant_name]
    except KeyError as exc:
        raise ValueError(f"prompt variant not found: {variant_name}") from exc

    variables = {
        "history": history,
        "question_date": question_date,
        "question": question,
        **variant,
    }
    required = set(prompt_template.required_variables)
    missing = required - variables.keys()
    extra = variables.keys() - required
    if missing or extra:
        raise ValueError(
            f"prompt render variables do not match contract; "
            f"missing={sorted(missing)}, extra={sorted(extra)}"
        )
    return prompt_template.template.format_map(variables)
