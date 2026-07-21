from __future__ import annotations

from typing import Any

import pytest

from longmemeval.models import BenchmarkCase


def make_case(
    question_id: str = "q1",
    question_type: str = "single-session-user",
    *,
    has_answer: bool = True,
) -> BenchmarkCase:
    turn: dict[str, Any] = {"role": "user", "content": "I moved to Pune."}
    if has_answer:
        turn["has_answer"] = True
    return BenchmarkCase(
        question_id=question_id,
        question_type=question_type,
        question="Where did I move?",
        answer="Pune",
        question_date="2025/01/02",
        haystack_session_ids=["session-1"],
        haystack_dates=["2025/01/01"],
        haystack_sessions=[[turn, {"role": "assistant", "content": "Noted."}]],
        answer_session_ids=["session-1"],
    )


@pytest.fixture
def case() -> BenchmarkCase:
    return make_case()
