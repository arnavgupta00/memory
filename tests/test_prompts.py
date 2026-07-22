from pathlib import Path

import pytest

from agents.current.config import CurrentArchitectureConfig
from agents.current.prompt import answer_prompt, load_prompt_template
from longmemeval.data import sanitized_sessions


def test_prompt_contains_dates_and_no_answer_marker(case) -> None:  # type: ignore[no-untyped-def]
    prompt = answer_prompt(
        sanitized_sessions(case),
        case.question,
        case.question_date,
        CurrentArchitectureConfig(chain_of_note=True, history_format="json"),
    )
    assert "2025/01/01" in prompt
    assert "2025/01/02" in prompt
    assert "first extract all the relevant information" in prompt
    assert "has_answer" not in prompt


def test_direct_text_prompt(case) -> None:  # type: ignore[no-untyped-def]
    prompt = answer_prompt(
        sanitized_sessions(case),
        case.question,
        case.question_date,
        CurrentArchitectureConfig(chain_of_note=False, history_format="text"),
    )
    assert "user: I moved to Pune." in prompt
    assert prompt.endswith("Answer:")


def test_prompt_structure_and_variables_are_owned_by_yaml() -> None:
    prompt_path = Path("src/agents/current/prompts/full_history.yaml")
    source = prompt_path.read_text(encoding="utf-8")
    template = load_prompt_template(str(prompt_path.resolve()))

    assert "{history}" in source
    assert "{question_date}" in source
    assert "{question}" in source
    assert "{answer_instruction}" in source
    assert "{answer_cue}" in source
    assert template.id == "full-history-answer-v1"


def test_prompt_loader_rejects_undeclared_placeholder(tmp_path: Path) -> None:
    prompt_path = tmp_path / "bad-prompt.yaml"
    prompt_path.write_text(
        """
schema_version: 1
id: invalid
description: invalid test prompt
required_variables: [question]
template: "Question: {question} {undeclared}"
variants: {}
""".lstrip(),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="contract mismatch"):
        load_prompt_template(str(prompt_path))
