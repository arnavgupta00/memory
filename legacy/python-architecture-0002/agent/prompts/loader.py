from __future__ import annotations

from pathlib import Path
from string import Formatter

import yaml
from pydantic import BaseModel, ConfigDict, Field

from longmemeval.api import JsonObject, JsonValue, PromptEnvelope, PromptMessage


class PromptDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: int
    id: str
    description: str
    output_contract: str
    required_variables: list[str]
    messages: list[PromptMessage] = Field(min_length=1)


def _placeholders(text: str) -> set[str]:
    names: set[str] = set()
    for _, field_name, format_spec, conversion in Formatter().parse(text):
        if field_name is None:
            continue
        if not field_name.isidentifier() or format_spec or conversion:
            raise ValueError(f"unsupported prompt placeholder: {field_name!r}")
        names.add(field_name)
    return names


def load_prompt(path: Path) -> PromptDefinition:
    raw: JsonValue = yaml.safe_load(path.read_text(encoding="utf-8"))
    definition = PromptDefinition.model_validate(raw)
    if definition.schema_version != 1:
        raise ValueError(f"unsupported prompt schema version: {definition.schema_version}")
    if len(set(definition.required_variables)) != len(definition.required_variables):
        raise ValueError("required_variables contains duplicates")
    actual: set[str] = set()
    for message in definition.messages:
        actual.update(_placeholders(message.content))
    expected = set(definition.required_variables)
    if actual != expected:
        raise ValueError(
            f"prompt variable contract mismatch; missing={sorted(expected - actual)}, "
            f"undeclared={sorted(actual - expected)}"
        )
    return definition


def render_prompt(
    path: Path,
    variables: JsonObject,
    *,
    output_contract: str,
) -> PromptEnvelope:
    definition = load_prompt(path)
    if definition.output_contract != output_contract:
        raise ValueError(f"prompt expects {definition.output_contract!r}, not {output_contract!r}")
    expected = set(definition.required_variables)
    actual = set(variables)
    if expected != actual:
        raise ValueError(
            f"render variables mismatch; missing={sorted(expected - actual)}, "
            f"extra={sorted(actual - expected)}"
        )
    text_variables = {key: _as_text(value) for key, value in variables.items()}
    return PromptEnvelope(
        prompt_id=definition.id,
        messages=[
            PromptMessage(role=message.role, content=message.content.format_map(text_variables))
            for message in definition.messages
        ],
    )


def _as_text(value: JsonValue) -> str:
    if isinstance(value, str):
        return value
    import json

    return json.dumps(value, ensure_ascii=False, sort_keys=True)
