from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from longmemeval.constants import (
    EXPECTED_CASES,
    QUESTION_TYPES,
    SLICES_DIR,
)
from longmemeval.data import DataValidationError, canonical_smoke_ids
from longmemeval.models import BenchmarkCase
from longmemeval.utils import sha256_file


class SelectionStratum(BaseModel):
    question_type: str
    abstention: bool
    population_count: int = Field(gt=0)
    sample_count: int = Field(gt=0)

    @model_validator(mode="after")
    def sample_fits_population(self) -> SelectionStratum:
        if self.sample_count > self.population_count:
            raise ValueError("sample count cannot exceed population count")
        return self


class SliceManifest(BaseModel):
    schema_version: Literal[1] = 1
    name: Literal["canary-1", "canary-2", "dev-9-v1", "dev-60-v1"]
    purpose: str
    dataset_file: Literal["longmemeval_s_cleaned.json"] = "longmemeval_s_cleaned.json"
    dataset_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    seed: int
    subset_of: str | None = None
    question_ids: list[str]
    question_type_counts: dict[str, int]
    abstention_count: int
    abstention_by_type: dict[str, int]
    strata: list[SelectionStratum]
    coverage: dict[str, object]


class ResolvedSelection(BaseModel):
    question_ids: list[str]
    metadata: dict[str, object]


def _is_abstention(case: BenchmarkCase) -> bool:
    return case.question_id.endswith("_abs")


def _slice_path(name: str) -> Path:
    if name not in {"canary-1", "canary-2", "dev-9-v1", "dev-60-v1"}:
        raise ValueError(f"unsupported benchmark slice: {name}")
    return SLICES_DIR / f"{name}.json"


def load_slice(
    name: str,
    cases: list[BenchmarkCase],
    *,
    dataset_sha256: str,
) -> tuple[SliceManifest, str]:
    path = _slice_path(name)
    if not path.is_file():
        raise DataValidationError(f"missing benchmark slice: {path}")
    try:
        raw = json.loads(path.read_text())
        manifest = SliceManifest.model_validate(raw)
    except Exception as exc:
        raise DataValidationError(f"invalid benchmark slice {path.name}: {exc}") from exc
    if manifest.name != name:
        raise DataValidationError(f"slice name mismatch in {path.name}")
    if manifest.dataset_sha256 != dataset_sha256:
        raise DataValidationError(f"slice dataset checksum mismatch: {path.name}")
    _validate_slice_cases(manifest, cases)
    return manifest, sha256_file(path)


def _validate_slice_cases(manifest: SliceManifest, cases: list[BenchmarkCase]) -> None:
    if len(manifest.question_ids) != len(set(manifest.question_ids)):
        raise DataValidationError(f"{manifest.name}: duplicate question IDs")
    by_id = {case.question_id: case for case in cases}
    unknown = set(manifest.question_ids) - set(by_id)
    if unknown:
        raise DataValidationError(f"{manifest.name}: unknown IDs: {sorted(unknown)[:10]}")
    selected = [by_id[question_id] for question_id in manifest.question_ids]
    type_counts = {
        question_type: sum(case.question_type == question_type for case in selected)
        for question_type in sorted(QUESTION_TYPES)
    }
    type_counts = {name: count for name, count in type_counts.items() if count}
    if type_counts != manifest.question_type_counts:
        raise DataValidationError(f"{manifest.name}: question-type counts do not match")
    abstentions = [case for case in selected if _is_abstention(case)]
    if len(abstentions) != manifest.abstention_count:
        raise DataValidationError(f"{manifest.name}: abstention count does not match")
    abstention_by_type = {
        question_type: sum(case.question_type == question_type for case in abstentions)
        for question_type in sorted(QUESTION_TYPES)
    }
    abstention_by_type = {name: count for name, count in abstention_by_type.items() if count}
    if abstention_by_type != manifest.abstention_by_type:
        raise DataValidationError(f"{manifest.name}: abstention-type counts do not match")
    population_strata = _stratum_counts(cases)
    sample_strata = _stratum_counts(selected)
    declared = {
        (item.question_type, item.abstention): (item.population_count, item.sample_count)
        for item in manifest.strata
    }
    expected = {
        key: (population_strata[key], sample_count) for key, sample_count in sample_strata.items()
    }
    if declared != expected:
        raise DataValidationError(f"{manifest.name}: stratum counts do not match")


def _stratum_counts(cases: list[BenchmarkCase]) -> dict[tuple[str, bool], int]:
    result: dict[tuple[str, bool], int] = {}
    for case in cases:
        key = (case.question_type, _is_abstention(case))
        result[key] = result.get(key, 0) + 1
    return result


def resolve_selection(
    strategy: str,
    cases: list[BenchmarkCase],
    *,
    dataset_sha256: str,
) -> ResolvedSelection:
    if strategy == "all":
        return ResolvedSelection(
            question_ids=[case.question_id for case in cases],
            metadata={
                "strategy": "all",
                "population_count": EXPECTED_CASES,
                "sample_count": len(cases),
                "is_canary": False,
            },
        )
    if strategy == "canonical-smoke":
        question_ids = canonical_smoke_ids(cases)
        return ResolvedSelection(
            question_ids=question_ids,
            metadata={
                "strategy": "canonical-smoke",
                "population_count": EXPECTED_CASES,
                "sample_count": len(question_ids),
                "is_canary": False,
            },
        )
    manifest, manifest_sha256 = load_slice(
        strategy,
        cases,
        dataset_sha256=dataset_sha256,
    )
    metadata = manifest.model_dump(mode="json")
    metadata.update(
        {
            "strategy": strategy,
            "population_count": EXPECTED_CASES,
            "sample_count": len(manifest.question_ids),
            "is_canary": manifest.name.startswith("canary-"),
            "manifest_sha256": manifest_sha256,
        }
    )
    return ResolvedSelection(question_ids=manifest.question_ids, metadata=metadata)
