from agents.current.config import CurrentArchitectureConfig
from agents.current.prompt import answer_prompt
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
