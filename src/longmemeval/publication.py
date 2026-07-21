from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any

from longmemeval.constants import EXPECTED_CASES, LOCK_PATH, PROJECT_ROOT, SUBMISSIONS_DIR
from longmemeval.data import verify_data
from longmemeval.runner import resolve_run_path
from longmemeval.utils import (
    contains_secret,
    git_state,
    read_json,
    read_jsonl,
    sha256_file,
    utc_now,
    write_json,
)

PUBLISH_FILES = (
    "manifest.json",
    "config.yaml",
    "predictions.jsonl",
    "judgments.jsonl",
    "report.json",
)


def _validate_unique(path: Path, expected: int) -> None:
    entries = read_jsonl(path)
    ids = [item.get("question_id") for item in entries]
    if len(entries) != expected or len(set(ids)) != expected:
        raise ValueError(f"{path.name} must contain {expected} unique question IDs")


def freeze_run(run_id: str, name: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", name):
        raise ValueError(
            "submission name may contain only letters, numbers, dots, underscores, and dashes"
        )
    current_hashes = verify_data()
    run_path = resolve_run_path(run_id)
    manifest = read_json(run_path / "manifest.json")
    report_path = run_path / "report.json"
    if manifest.get("dataset_mode") == "oracle":
        raise ValueError("oracle runs are pipeline checks and cannot be published")
    if manifest.get("status") != "completed":
        raise ValueError("only completed runs can be published")
    if manifest.get("selected_count") != EXPECTED_CASES:
        raise ValueError(f"publishable runs must include all {EXPECTED_CASES} questions")
    if manifest.get("failure_count"):
        raise ValueError("run has unresolved failures")
    if manifest.get("dataset_hashes") != current_hashes:
        raise ValueError("run dataset hashes differ from the current pinned data")
    current_git = git_state(PROJECT_ROOT)
    if current_git["dirty"] or not current_git["commit"]:
        raise ValueError("repository must have a clean committed state before freezing")
    if manifest.get("git") != current_git:
        raise ValueError("run was not produced from the current clean commit")
    if not report_path.exists():
        raise ValueError("generate a report before freezing")

    _validate_unique(run_path / "predictions.jsonl", EXPECTED_CASES)
    _validate_unique(run_path / "judgments.jsonl", EXPECTED_CASES)

    destination = SUBMISSIONS_DIR / name
    if destination.exists():
        raise FileExistsError(f"submission already exists: {destination}")
    validated_sources: list[tuple[Path, str]] = []
    for filename in PUBLISH_FILES:
        source = run_path / filename
        if not source.exists():
            raise FileNotFoundError(f"missing required publication artifact: {filename}")
        text = source.read_text()
        if contains_secret(text):
            raise ValueError(f"possible secret detected in {filename}")
        validated_sources.append((source, filename))

    destination.mkdir(parents=True)
    for source, filename in validated_sources:
        shutil.copyfile(source, destination / filename)
    shutil.copyfile(LOCK_PATH, destination / LOCK_PATH.name)

    files = {
        path.name: sha256_file(path) for path in sorted(destination.iterdir()) if path.is_file()
    }
    publication: dict[str, Any] = {
        "schema_version": 1,
        "name": name,
        "run_id": run_id,
        "frozen_at": utc_now(),
        "git": current_git,
        "files": files,
    }
    serialized = json.dumps(publication, indent=2, sort_keys=True) + "\n"
    if contains_secret(serialized):
        raise ValueError("possible secret detected in publication manifest")
    write_json(destination / "publication.json", publication)
    return destination
