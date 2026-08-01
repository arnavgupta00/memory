from __future__ import annotations

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SLICE_DIR = ROOT / "src/agents/current/eval-slices/beam-1m"
SOURCE_COMMIT = "3e12035532eb85768f1a7cd779832b650c4b2ef9"
ABILITIES = {
    "abstention",
    "contradiction_resolution",
    "event_ordering",
    "information_extraction",
    "instruction_following",
    "knowledge_update",
    "multi_session_reasoning",
    "preference_following",
    "summarization",
    "temporal_reasoning",
}


def _load(name: str) -> dict[str, object]:
    return json.loads((SLICE_DIR / name).read_text())


def test_beam_1m_canary_partition_and_ability_balance() -> None:
    development = _load("beam-1m-canary-a-development-v1.json")
    certification = _load("beam-1m-canary-b-certification-v1.json")
    reserve = _load("beam-1m-blind-reserve-v1.json")

    development_ids = set(development["conversation_ids"])
    certification_ids = set(certification["conversation_ids"])
    reserve_ids = set(reserve["conversation_ids"])

    assert len(development_ids) == 5
    assert len(certification_ids) == 13
    assert len(reserve_ids) == 17
    assert not development_ids & certification_ids
    assert not development_ids & reserve_ids
    assert not certification_ids & reserve_ids
    assert development_ids | certification_ids | reserve_ids == set(range(1, 36))

    assert len(development["question_keys"]) == 100
    assert len(certification["question_keys"]) == 260
    assert len(reserve["question_keys"]) == 340

    for manifest, expected_per_ability in ((development, 10), (certification, 26)):
        counts = manifest["counts"]
        assert set(counts["by_ability"]) == ABILITIES
        assert set(counts["by_ability"].values()) == {expected_per_ability}


def test_beam_1m_expansion_order_and_reliability_contract() -> None:
    certification = _load("beam-1m-canary-b-certification-v1.json")
    reserve = _load("beam-1m-blind-reserve-v1.json")

    expansion_15 = set(certification["expansion_to_15_conversation_ids"])
    expansion_17 = set(certification["expansion_to_17_conversation_ids"])
    reserve_ids = set(reserve["conversation_ids"])

    assert len(expansion_15) == 2
    assert len(expansion_17) == 2
    assert not expansion_15 & expansion_17
    assert expansion_15 | expansion_17 < reserve_ids

    contract = certification["reliability_contract"]
    assert contract["target_half_width"] == 0.05
    assert contract["confidence_level"] == 0.95
    assert contract["unit_for_uncertainty"] == "conversation-level score"
    assert contract["reliability_status"] == "provisional_structural"
    assert certification["source"]["commit"] == SOURCE_COMMIT


def test_beam_1m_manifest_checksums() -> None:
    checksum_lines = (SLICE_DIR / "CHECKSUMS.sha256").read_text().splitlines()
    assert len(checksum_lines) == 4
    for line in checksum_lines:
        expected, filename = line.split("  ", maxsplit=1)
        actual = hashlib.sha256((SLICE_DIR / filename).read_bytes()).hexdigest()
        assert actual == expected
