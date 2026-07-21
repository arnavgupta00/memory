from __future__ import annotations

import copy
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx

from longmemeval.constants import (
    CACHE_DIR,
    DATA_DIR,
    EVALUATOR_FILE,
    EXPECTED_ABSTENTIONS,
    EXPECTED_CASES,
    LOCK_PATH,
    LONGMEMEVAL_ORACLE_FILE,
    LONGMEMEVAL_S_FILE,
    QUESTION_TYPES,
)
from longmemeval.models import BenchmarkCase, TimestampedSession, Turn
from longmemeval.utils import read_json, sha256_file, write_json


class DataValidationError(ValueError):
    pass


def _lock() -> dict[str, Any]:
    value = read_json(LOCK_PATH)
    if not isinstance(value, dict):
        raise DataValidationError("benchmark lock must be an object")
    return value


def _download(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".partial")
    with httpx.stream("GET", url, follow_redirects=True, timeout=300.0) as response:
        response.raise_for_status()
        with temporary.open("wb") as handle:
            for chunk in response.iter_bytes():
                handle.write(chunk)
    temporary.replace(destination)


def fetch_data(*, refresh_checksums: bool = False) -> dict[str, str]:
    lock = _lock()
    files: list[tuple[dict[str, Any], Path]] = []
    dataset_files = lock["dataset"]["files"]
    for filename, metadata in dataset_files.items():
        files.append((metadata, DATA_DIR / filename))
    files.append((lock["longmemeval"]["evaluator"], CACHE_DIR / EVALUATOR_FILE))

    hashes: dict[str, str] = {}
    for metadata, destination in files:
        expected = metadata.get("sha256")
        if not destination.exists() or (expected and sha256_file(destination) != expected):
            _download(metadata["url"], destination)
        actual = sha256_file(destination)
        if expected and actual != expected:
            raise DataValidationError(f"checksum mismatch after download: {destination.name}")
        if not expected:
            if not refresh_checksums:
                raise DataValidationError(
                    f"lock has no checksum for {destination.name}; rerun with --refresh-checksums"
                )
            metadata["sha256"] = actual
        hashes[destination.name] = actual

    # Validate the candidate downloads before persisting newly learned hashes.
    for filename in dataset_files:
        validate_cases(load_cases(DATA_DIR / filename))
    if not (CACHE_DIR / EVALUATOR_FILE).is_file():
        raise DataValidationError("canonical evaluator download is missing")
    if refresh_checksums:
        write_json(LOCK_PATH, lock)
    verify_data()
    return hashes


def load_cases(path: Path) -> list[BenchmarkCase]:
    raw = json.loads(path.read_text())
    if not isinstance(raw, list):
        raise DataValidationError(f"dataset must be a list: {path}")
    try:
        return [BenchmarkCase.model_validate(item) for item in raw]
    except Exception as exc:
        raise DataValidationError(f"invalid dataset schema in {path.name}: {exc}") from exc


def validate_cases(cases: list[BenchmarkCase], *, expected_count: int = EXPECTED_CASES) -> None:
    errors: list[str] = []
    if len(cases) != expected_count:
        errors.append(f"expected {expected_count} cases, found {len(cases)}")
    ids = [case.question_id for case in cases]
    if len(ids) != len(set(ids)):
        errors.append("question IDs are not unique")
    unknown_types = {case.question_type for case in cases} - QUESTION_TYPES
    if unknown_types:
        errors.append(f"unknown question types: {sorted(unknown_types)}")
    abstentions = sum(case.question_id.endswith("_abs") for case in cases)
    if expected_count == EXPECTED_CASES and abstentions != EXPECTED_ABSTENTIONS:
        errors.append(f"expected {EXPECTED_ABSTENTIONS} abstentions, found {abstentions}")
    for case in cases:
        lengths = (
            len(case.haystack_session_ids),
            len(case.haystack_dates),
            len(case.haystack_sessions),
        )
        if len(set(lengths)) != 1:
            errors.append(f"{case.question_id}: misaligned session IDs, dates, and contents")
        if not case.question.strip() or not case.answer.strip() or not case.question_date.strip():
            errors.append(f"{case.question_id}: blank question, answer, or question date")
        for session in case.haystack_sessions:
            for turn in session:
                if turn.get("role") not in {"user", "assistant"} or not isinstance(
                    turn.get("content"), str
                ):
                    errors.append(f"{case.question_id}: malformed turn")
                    break
    if errors:
        preview = "; ".join(errors[:20])
        raise DataValidationError(preview + ("; ..." if len(errors) > 20 else ""))


def verify_data() -> dict[str, str]:
    lock = _lock()
    checked: dict[str, str] = {}
    datasets: dict[str, list[BenchmarkCase]] = {}
    for filename, metadata in lock["dataset"]["files"].items():
        path = DATA_DIR / filename
        if not path.exists():
            raise DataValidationError(f"missing dataset file: {path}")
        expected = metadata.get("sha256")
        if not expected:
            raise DataValidationError(f"missing pinned checksum for {filename}")
        actual = sha256_file(path)
        if actual != expected:
            raise DataValidationError(f"checksum mismatch: {filename}")
        cases = load_cases(path)
        validate_cases(cases)
        datasets[filename] = cases
        checked[filename] = actual

    evaluator = CACHE_DIR / EVALUATOR_FILE
    expected_evaluator = lock["longmemeval"]["evaluator"].get("sha256")
    if not evaluator.exists() or not expected_evaluator:
        raise DataValidationError("canonical evaluator is missing or unpinned")
    actual_evaluator = sha256_file(evaluator)
    if actual_evaluator != expected_evaluator:
        raise DataValidationError("canonical evaluator checksum mismatch")
    checked[EVALUATOR_FILE] = actual_evaluator

    # Imported lazily to keep selection validation downstream of core dataset parsing.
    from longmemeval.selection import load_slice

    benchmark_cases = datasets[LONGMEMEVAL_S_FILE]
    dataset_sha256 = checked[LONGMEMEVAL_S_FILE]
    for name in ("canary-1", "canary-2"):
        _, manifest_sha256 = load_slice(
            name,
            benchmark_cases,
            dataset_sha256=dataset_sha256,
        )
        checked[f"{name}.json"] = manifest_sha256
    return checked


def dataset_path(mode: str) -> Path:
    if mode == "oracle":
        return DATA_DIR / LONGMEMEVAL_ORACLE_FILE
    if mode == "full-context":
        return DATA_DIR / LONGMEMEVAL_S_FILE
    raise ValueError(f"unsupported mode: {mode}")


def sanitized_sessions(case: BenchmarkCase) -> list[TimestampedSession]:
    result: list[TimestampedSession] = []
    for session_id, date, raw_turns in zip(
        case.haystack_session_ids,
        case.haystack_dates,
        case.haystack_sessions,
        strict=True,
    ):
        copied = copy.deepcopy(raw_turns)
        turns: list[Turn] = []
        for raw in copied:
            raw.pop("has_answer", None)
            turns.append(Turn.model_validate(raw))
        result.append(TimestampedSession(session_id=session_id, date=date, turns=turns))
    return result


SmokePredicate = Callable[[BenchmarkCase], bool]

SMOKE_BRANCHES: tuple[tuple[str, SmokePredicate], ...] = (
    (
        "default",
        lambda case: case.question_type == "single-session-user" and "_abs" not in case.question_id,
    ),
    (
        "preference",
        lambda case: (
            case.question_type == "single-session-preference" and "_abs" not in case.question_id
        ),
    ),
    (
        "knowledge-update",
        lambda case: case.question_type == "knowledge-update" and "_abs" not in case.question_id,
    ),
    (
        "temporal",
        lambda case: case.question_type == "temporal-reasoning" and "_abs" not in case.question_id,
    ),
    ("abstention", lambda case: case.question_id.endswith("_abs")),
)


def canonical_smoke_ids(cases: list[BenchmarkCase]) -> list[str]:
    ordered = sorted(cases, key=lambda case: case.question_id)
    selected: list[str] = []
    for name, predicate in SMOKE_BRANCHES:
        match = next((case.question_id for case in ordered if predicate(case)), None)
        if match is None:
            raise DataValidationError(f"no smoke case found for branch {name}")
        selected.append(match)
    return selected
