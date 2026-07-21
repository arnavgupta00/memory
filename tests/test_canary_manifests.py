from __future__ import annotations

import json

from longmemeval.constants import QUESTION_TYPES, SLICES_DIR
from longmemeval.selection import SliceManifest


def _manifest(name: str) -> SliceManifest:
    raw = json.loads((SLICES_DIR / f"{name}.json").read_text())
    return SliceManifest.model_validate(raw)


def test_canary_sizes_coverage_and_nesting() -> None:
    canary_1 = _manifest("canary-1")
    canary_2 = _manifest("canary-2")

    assert len(canary_1.question_ids) == 150
    assert len(canary_2.question_ids) == 60
    assert set(canary_2.question_ids) < set(canary_1.question_ids)
    assert canary_2.subset_of == "canary-1"
    assert canary_2.question_type_counts == {name: 10 for name in sorted(QUESTION_TYPES)}
    assert canary_2.abstention_count == 10
    assert canary_2.abstention_by_type == {
        "knowledge-update": 2,
        "multi-session": 4,
        "single-session-user": 2,
        "temporal-reasoning": 2,
    }
    assert all(
        quartiles == [0, 1, 2, 3]
        for quartiles in canary_2.coverage["evidence_position_quartiles_by_type"].values()
    )
