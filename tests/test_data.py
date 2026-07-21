from __future__ import annotations

import pytest
from conftest import make_case

from longmemeval.data import DataValidationError, sanitized_sessions, validate_cases


def test_strips_answer_annotations_without_mutating_source() -> None:
    case = make_case()
    sessions = sanitized_sessions(case)
    assert "has_answer" not in sessions[0].turns[0].model_dump()
    assert case.haystack_sessions[0][0]["has_answer"] is True


def test_validates_alignment() -> None:
    case = make_case()
    case.haystack_dates = []
    with pytest.raises(DataValidationError, match="misaligned"):
        validate_cases([case], expected_count=1)


def test_validates_unique_question_ids() -> None:
    case = make_case()
    with pytest.raises(DataValidationError, match="not unique"):
        validate_cases([case, case], expected_count=2)
