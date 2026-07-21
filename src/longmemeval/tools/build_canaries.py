from __future__ import annotations

import hashlib
import json
import math
from collections import Counter
from dataclasses import dataclass
from statistics import mean

from longmemeval.constants import DATA_DIR, LOCK_PATH, LONGMEMEVAL_S_FILE, SLICES_DIR
from longmemeval.data import load_cases
from longmemeval.models import BenchmarkCase

SEED = 20260722
OUTPUT_DIR = SLICES_DIR

CANARY_2_QUOTAS: dict[tuple[str, bool], int] = {
    ("knowledge-update", False): 8,
    ("knowledge-update", True): 2,
    ("multi-session", False): 6,
    ("multi-session", True): 4,
    ("single-session-assistant", False): 10,
    ("single-session-preference", False): 10,
    ("single-session-user", False): 8,
    ("single-session-user", True): 2,
    ("temporal-reasoning", False): 8,
    ("temporal-reasoning", True): 2,
}

CANARY_1_QUOTAS: dict[tuple[str, bool], int] = {
    ("knowledge-update", False): 20,
    ("knowledge-update", True): 3,
    ("multi-session", False): 33,
    ("multi-session", True): 6,
    ("single-session-assistant", False): 15,
    ("single-session-preference", False): 15,
    ("single-session-user", False): 17,
    ("single-session-user", True): 3,
    ("temporal-reasoning", False): 35,
    ("temporal-reasoning", True): 3,
}


@dataclass(frozen=True)
class Features:
    session_count: float
    context_chars: float
    turn_count: float
    evidence_count: float
    evidence_mean_position: float
    evidence_span: float
    question_chars: float
    answer_chars: float

    def values(self) -> tuple[float, ...]:
        return (
            self.session_count,
            self.context_chars,
            self.turn_count,
            self.evidence_count,
            self.evidence_mean_position,
            self.evidence_span,
            self.question_chars,
            self.answer_chars,
        )


def _is_abstention(case: BenchmarkCase) -> bool:
    return case.question_id.endswith("_abs")


def _features(case: BenchmarkCase) -> Features:
    index_by_id = {session_id: index for index, session_id in enumerate(case.haystack_session_ids)}
    denominator = max(len(case.haystack_session_ids) - 1, 1)
    positions = [index_by_id[session_id] / denominator for session_id in case.answer_session_ids]
    context_chars = sum(
        len(str(turn.get("content", ""))) for session in case.haystack_sessions for turn in session
    )
    turn_count = sum(len(session) for session in case.haystack_sessions)
    return Features(
        session_count=float(len(case.haystack_sessions)),
        context_chars=float(context_chars),
        turn_count=float(turn_count),
        evidence_count=float(len(case.answer_session_ids)),
        evidence_mean_position=mean(positions),
        evidence_span=max(positions) - min(positions),
        question_chars=float(len(case.question)),
        answer_chars=float(len(case.answer)),
    )


def _stable_tiebreak(question_id: str) -> int:
    value = hashlib.sha256(f"{SEED}:{question_id}".encode()).hexdigest()
    return int(value, 16)


def _normalized(pool: list[BenchmarkCase]) -> dict[str, tuple[float, ...]]:
    raw = {case.question_id: _features(case).values() for case in pool}
    columns = list(zip(*raw.values(), strict=True))
    bounds = [(min(column), max(column)) for column in columns]
    return {
        question_id: tuple(
            0.0 if high == low else (value - low) / (high - low)
            for value, (low, high) in zip(values, bounds, strict=True)
        )
        for question_id, values in raw.items()
    }


def _distance(left: tuple[float, ...], right: tuple[float, ...]) -> float:
    return math.sqrt(sum((a - b) ** 2 for a, b in zip(left, right, strict=True)))


def _medoid(cases: list[BenchmarkCase], vectors: dict[str, tuple[float, ...]]) -> BenchmarkCase:
    center = tuple(
        mean(values) for values in zip(*(vectors[c.question_id] for c in cases), strict=True)
    )
    return min(
        cases,
        key=lambda case: (
            _distance(vectors[case.question_id], center),
            _stable_tiebreak(case.question_id),
        ),
    )


def _balanced_sample(
    pool: list[BenchmarkCase],
    count: int,
    *,
    required_ids: set[str] | None = None,
) -> list[BenchmarkCase]:
    if count > len(pool):
        raise ValueError("sample quota exceeds stratum population")
    by_id = {case.question_id: case for case in pool}
    required_ids = required_ids or set()
    if not required_ids <= set(by_id):
        raise ValueError("required canary IDs are outside their stratum")
    vectors = _normalized(pool)
    selected = [by_id[question_id] for question_id in sorted(required_ids)]

    # Preserve every evidence-count shape when the quota makes that possible.
    evidence_groups: dict[int, list[BenchmarkCase]] = {}
    for case in pool:
        evidence_groups.setdefault(len(case.answer_session_ids), []).append(case)
    if count >= len(evidence_groups):
        for evidence_count in sorted(evidence_groups):
            group = evidence_groups[evidence_count]
            if any(item in selected for item in group):
                continue
            candidate = _medoid(group, vectors)
            if len(selected) < count:
                selected.append(candidate)

    if not selected:
        selected.append(_medoid(pool, vectors))
    while len(selected) < count:
        selected_ids = {case.question_id for case in selected}
        remaining = [case for case in pool if case.question_id not in selected_ids]
        candidate = max(
            remaining,
            key=lambda case: (
                min(
                    _distance(vectors[case.question_id], vectors[chosen.question_id])
                    for chosen in selected
                ),
                -_stable_tiebreak(case.question_id),
            ),
        )
        selected.append(candidate)
    return sorted(selected, key=lambda case: case.question_id)


def _select(
    cases: list[BenchmarkCase],
    quotas: dict[tuple[str, bool], int],
    *,
    required_ids: set[str] | None = None,
) -> list[BenchmarkCase]:
    selected: list[BenchmarkCase] = []
    required_ids = required_ids or set()
    for key, quota in sorted(quotas.items()):
        question_type, abstention = key
        pool = [
            case
            for case in cases
            if case.question_type == question_type and _is_abstention(case) == abstention
        ]
        required = {case.question_id for case in pool if case.question_id in required_ids}
        selected.extend(_balanced_sample(pool, quota, required_ids=required))
    if len(selected) != sum(quotas.values()):
        raise AssertionError("canary selection size mismatch")
    return _repair_position_coverage(cases, selected)


def _repair_position_coverage(
    population: list[BenchmarkCase], selected: list[BenchmarkCase]
) -> list[BenchmarkCase]:
    result = list(selected)
    for question_type in sorted({case.question_type for case in population}):
        full_type = [case for case in population if case.question_type == question_type]
        required_evidence_counts = {len(case.answer_session_ids) for case in full_type}
        required_quartiles = {_position_quartile(case) for case in full_type}
        while True:
            selected_type = [case for case in result if case.question_type == question_type]
            missing = required_quartiles - {_position_quartile(case) for case in selected_type}
            if not missing:
                break
            quartile = min(missing)
            selected_ids = {case.question_id for case in result}
            candidates = sorted(
                (
                    case
                    for case in full_type
                    if case.question_id not in selected_ids and _position_quartile(case) == quartile
                ),
                key=lambda case: _stable_tiebreak(case.question_id),
            )
            replacement: tuple[BenchmarkCase, BenchmarkCase] | None = None
            for candidate in candidates:
                removables = sorted(
                    (
                        case
                        for case in selected_type
                        if _is_abstention(case) == _is_abstention(candidate)
                    ),
                    key=lambda case: _stable_tiebreak(case.question_id),
                )
                for removable in removables:
                    proposed = [
                        case for case in selected_type if case.question_id != removable.question_id
                    ] + [candidate]
                    if {
                        len(case.answer_session_ids) for case in proposed
                    } != required_evidence_counts:
                        continue
                    if not (required_quartiles - {quartile}) <= {
                        _position_quartile(case) for case in proposed
                    }:
                        continue
                    replacement = (removable, candidate)
                    break
                if replacement:
                    break
            if replacement is None:
                raise AssertionError(
                    f"cannot cover evidence-position quartile {quartile} for {question_type}"
                )
            removable, candidate = replacement
            result = [case for case in result if case.question_id != removable.question_id] + [
                candidate
            ]
    return sorted(result, key=lambda case: case.question_id)


def _position_quartile(case: BenchmarkCase) -> int:
    index_by_id = {session_id: index for index, session_id in enumerate(case.haystack_session_ids)}
    denominator = max(len(case.haystack_session_ids) - 1, 1)
    positions = [index_by_id[session_id] / denominator for session_id in case.answer_session_ids]
    return min(3, int(mean(positions) * 4))


def _manifest(
    name: str,
    purpose: str,
    cases: list[BenchmarkCase],
    selected: list[BenchmarkCase],
    dataset_sha256: str,
    *,
    subset_of: str | None = None,
) -> dict[str, object]:
    type_counts = Counter(case.question_type for case in selected)
    abstentions = [case for case in selected if _is_abstention(case)]
    abstention_by_type = Counter(case.question_type for case in abstentions)
    strata = []
    for question_type, abstention in sorted(
        {(case.question_type, _is_abstention(case)) for case in selected}
    ):
        strata.append(
            {
                "question_type": question_type,
                "abstention": abstention,
                "population_count": sum(
                    case.question_type == question_type and _is_abstention(case) == abstention
                    for case in cases
                ),
                "sample_count": sum(
                    case.question_type == question_type and _is_abstention(case) == abstention
                    for case in selected
                ),
            }
        )
    evidence_counts = {
        question_type: sorted(
            {
                len(case.answer_session_ids)
                for case in selected
                if case.question_type == question_type
            }
        )
        for question_type in sorted(type_counts)
    }
    position_quartiles = {
        question_type: sorted(
            {_position_quartile(case) for case in selected if case.question_type == question_type}
        )
        for question_type in sorted(type_counts)
    }
    return {
        "schema_version": 1,
        "name": name,
        "purpose": purpose,
        "dataset_file": LONGMEMEVAL_S_FILE,
        "dataset_sha256": dataset_sha256,
        "seed": SEED,
        "subset_of": subset_of,
        "question_ids": [case.question_id for case in selected],
        "question_type_counts": dict(sorted(type_counts.items())),
        "abstention_count": len(abstentions),
        "abstention_by_type": dict(sorted(abstention_by_type.items())),
        "strata": strata,
        "coverage": {
            "evidence_counts_by_type": evidence_counts,
            "evidence_position_quartiles_by_type": position_quartiles,
            "selection_features": [
                "session_count",
                "context_chars",
                "turn_count",
                "evidence_count",
                "evidence_mean_position",
                "evidence_span",
                "question_chars",
                "answer_chars",
            ],
        },
    }


def main() -> None:
    lock = json.loads(LOCK_PATH.read_text())
    dataset_sha256 = lock["dataset"]["files"][LONGMEMEVAL_S_FILE]["sha256"]
    cases = load_cases(DATA_DIR / LONGMEMEVAL_S_FILE)
    canary_2 = _select(cases, CANARY_2_QUOTAS)
    canary_1 = _select(
        cases,
        CANARY_1_QUOTAS,
        required_ids={case.question_id for case in canary_2},
    )
    if not {case.question_id for case in canary_2} <= {case.question_id for case in canary_1}:
        raise AssertionError("Canary 2 must be nested inside Canary 1")

    manifests = [
        _manifest(
            "canary-1",
            "Major architecture changes; a 150-case estimate of full-benchmark behavior.",
            cases,
            canary_1,
            dataset_sha256,
        ),
        _manifest(
            "canary-2",
            "Small architecture changes; a 60-case coverage-first regression benchmark.",
            cases,
            canary_2,
            dataset_sha256,
            subset_of="canary-1",
        ),
    ]
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for manifest in manifests:
        path = OUTPUT_DIR / f"{manifest['name']}.json"
        path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        question_ids = manifest["question_ids"]
        if not isinstance(question_ids, list):
            raise TypeError("generated question IDs must be a list")
        print(f"{manifest['name']}: {len(question_ids)} cases -> {path}")


if __name__ == "__main__":
    main()
