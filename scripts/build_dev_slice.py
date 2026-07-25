#!/usr/bin/env python3
"""Build a reproducible LongMemEval development slice from the unused case pool."""

from __future__ import annotations

import argparse
import hashlib
import json
import random
from collections import Counter, defaultdict
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = PROJECT_ROOT / "data" / "raw" / "longmemeval_s_cleaned.json"
SLICES_DIR = PROJECT_ROOT / "src" / "longmemeval" / "slices"
RUNS_DIR = PROJECT_ROOT / "runs"

DEFAULT_ALLOCATION = {
    "single-session-preference": 6,
    "multi-session": 14,
    "temporal-reasoning": 14,
    "knowledge-update": 12,
    "single-session-user": 10,
    "single-session-assistant": 4,
}


def _load_json(path: Path) -> object:
    return json.loads(path.read_text())


def _dataset_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _ids_from_slice(name: str) -> set[str]:
    raw = _load_json(SLICES_DIR / f"{name}.json")
    assert isinstance(raw, dict)
    ids = raw["question_ids"]
    assert isinstance(ids, list)
    return set(ids)


def _ids_from_runs() -> set[str]:
    used: set[str] = set()
    if not RUNS_DIR.is_dir():
        return used
    for path in RUNS_DIR.rglob("predictions.jsonl"):
        for line in path.read_text().splitlines():
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            question_id = row.get("question_id")
            if isinstance(question_id, str):
                used.add(question_id)
    return used


def _is_abstention(question_id: str) -> bool:
    return question_id.endswith("_abs")


def build_manifest(
    *,
    name: str,
    seed: int,
    allocation: dict[str, int],
) -> dict[str, object]:
    cases = _load_json(DATA_PATH)
    assert isinstance(cases, list)
    by_id = {case["question_id"]: case for case in cases}
    dataset_sha = _dataset_sha256(DATA_PATH)

    excluded = {
        "canary-1": _ids_from_slice("canary-1"),
        "canary-2": _ids_from_slice("canary-2"),
        "dev-9-v1": _ids_from_slice("dev-9-v1"),
        "all prior run question_ids": _ids_from_runs(),
    }
    blocked = set().union(*excluded.values())
    pool_ids = sorted(set(by_id) - blocked)
    unused_pool_size = len(pool_ids)

    pools: dict[str, list[str]] = defaultdict(list)
    abstention_pools: dict[str, list[str]] = defaultdict(list)
    for question_id in pool_ids:
        question_type = by_id[question_id]["question_type"]
        if _is_abstention(question_id):
            abstention_pools[question_type].append(question_id)
        else:
            pools[question_type].append(question_id)

    rng = random.Random(seed)
    selected: list[str] = []

    # Prefer including every available abstention, then fill type quotas.
    for question_type, count in allocation.items():
        available_abs = sorted(abstention_pools.get(question_type, []))
        available_ans = sorted(pools.get(question_type, []))
        rng.shuffle(available_abs)
        rng.shuffle(available_ans)
        take_abs = min(len(available_abs), count)
        chosen = available_abs[:take_abs]
        remaining = count - len(chosen)
        if remaining > len(available_ans):
            raise ValueError(
                f"not enough unused {question_type} cases: need {count}, "
                f"have {len(available_abs)} abstention + {len(available_ans)} answerable"
            )
        chosen.extend(available_ans[:remaining])
        selected.extend(chosen)

    if len(selected) != sum(allocation.values()):
        raise ValueError("selected count does not match allocation")

    selected_cases = [by_id[question_id] for question_id in selected]
    type_counts = Counter(case["question_type"] for case in selected_cases)
    abstentions = [case for case in selected_cases if _is_abstention(case["question_id"])]
    abstention_by_type = Counter(case["question_type"] for case in abstentions)

    population = Counter(
        (case["question_type"], _is_abstention(case["question_id"])) for case in cases
    )
    sample = Counter(
        (case["question_type"], _is_abstention(case["question_id"])) for case in selected_cases
    )
    strata = [
        {
            "question_type": question_type,
            "abstention": abstention,
            "population_count": population[(question_type, abstention)],
            "sample_count": count,
        }
        for (question_type, abstention), count in sorted(sample.items())
    ]

    evidence_counts: dict[str, list[int]] = defaultdict(list)
    for case in selected_cases:
        if _is_abstention(case["question_id"]):
            continue
        session_ids = case.get("answer_session_ids") or []
        evidence_counts[case["question_type"]].append(len(session_ids))

    return {
        "schema_version": 1,
        "name": name,
        "purpose": (
            "Sixty-case development set for prompt A/B on Architecture 0004. "
            "Drawn from the unused pool after excluding canary-1, canary-2, "
            "dev-9-v1, and every question_id already present under runs/. "
            "Contaminated by design; never report as a blind result."
        ),
        "dataset_file": "longmemeval_s_cleaned.json",
        "dataset_sha256": dataset_sha,
        "seed": seed,
        "subset_of": None,
        "question_ids": sorted(selected),
        "question_type_counts": {
            question_type: type_counts[question_type]
            for question_type in sorted(type_counts)
        },
        "abstention_count": len(abstentions),
        "abstention_by_type": {
            question_type: abstention_by_type[question_type]
            for question_type in sorted(abstention_by_type)
        },
        "strata": strata,
        "coverage": {
            "allocation": allocation,
            "evidence_counts_by_type": {
                question_type: sorted(set(values))
                for question_type, values in sorted(evidence_counts.items())
            },
            "excluded_pools": sorted(excluded),
            "excluded_pool_sizes": {
                name: len(ids) for name, ids in sorted(excluded.items())
            },
            "unused_pool_size_at_selection": unused_pool_size,
            "remaining_unused_after_selection": unused_pool_size - len(selected),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", default="dev-60-v1")
    parser.add_argument("--seed", type=int, default=20260726)
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Output path (default: src/longmemeval/slices/<name>.json)",
    )
    args = parser.parse_args()
    out = args.out or (SLICES_DIR / f"{args.name}.json")
    manifest = build_manifest(name=args.name, seed=args.seed, allocation=DEFAULT_ALLOCATION)
    out.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    print(
        json.dumps(
            {
                "path": str(out),
                "count": len(manifest["question_ids"]),
                "question_type_counts": manifest["question_type_counts"],
                "abstention_count": manifest["abstention_count"],
                "abstention_by_type": manifest["abstention_by_type"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
