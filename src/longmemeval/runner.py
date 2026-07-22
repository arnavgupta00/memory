from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from longmemeval.agent_loader import load_agent
from longmemeval.config import RunConfig
from longmemeval.constants import PROJECT_ROOT, RUNS_DIR
from longmemeval.data import (
    dataset_path,
    load_cases,
    sanitized_sessions,
    verify_data,
)
from longmemeval.model_gateway import create_model_gateway
from longmemeval.models import FailureRecord, PredictionRecord
from longmemeval.providers import ProviderError
from longmemeval.selection import ResolvedSelection, resolve_selection
from longmemeval.utils import (
    append_jsonl,
    git_state,
    read_json,
    read_jsonl,
    utc_now,
    write_json,
)


def _slug(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-.")
    if not normalized:
        raise ValueError("run name cannot be normalized to an empty value")
    return normalized


def _new_run_id(config: RunConfig) -> str:
    timestamp = utc_now().replace(":", "").replace("-", "").replace("+00:00", "Z")
    return f"{timestamp}-{_slug(config.name)}"


def _latest_matching_run(config: RunConfig, selected_ids: list[str]) -> Path | None:
    if not RUNS_DIR.exists():
        return None
    matching: list[Path] = []
    for path in RUNS_DIR.iterdir():
        manifest_path = path / "manifest.json"
        if not manifest_path.exists():
            continue
        manifest = read_json(manifest_path)
        if (
            manifest.get("config_fingerprint") == config.fingerprint()
            and manifest.get("selected_question_ids") == selected_ids
        ):
            matching.append(path)
    return max(matching, key=lambda item: item.name) if matching else None


def resolve_run_path(run_id: str) -> Path:
    if _slug(run_id) != run_id:
        raise ValueError("run ID may contain only letters, numbers, dots, underscores, and dashes")
    path = RUNS_DIR / run_id
    if not path.is_dir():
        raise FileNotFoundError(f"run does not exist: {run_id}")
    return path


def _selected_ids(
    config: RunConfig,
    cases: list[Any],
    requested_ids: list[str] | None,
    *,
    dataset_sha256: str,
) -> ResolvedSelection:
    available = {case.question_id for case in cases}
    if requested_ids:
        unknown = set(requested_ids) - available
        if unknown:
            raise ValueError(f"unknown question IDs: {sorted(unknown)}")
        question_ids = list(dict.fromkeys(requested_ids))
        return ResolvedSelection(
            question_ids=question_ids,
            metadata={
                "strategy": "question-ids",
                "population_count": len(cases),
                "sample_count": len(question_ids),
                "is_canary": False,
            },
        )
    return resolve_selection(
        config.selection.strategy,
        cases,
        dataset_sha256=dataset_sha256,
    )


async def execute_run(
    config: RunConfig,
    config_path: Path,
    *,
    requested_ids: list[str] | None = None,
    resume: bool = False,
    run_id: str | None = None,
) -> Path:
    verified_hashes = verify_data()
    selected_dataset = dataset_path(config.mode)
    cases = load_cases(selected_dataset)
    resolved_selection = _selected_ids(
        config,
        cases,
        requested_ids,
        dataset_sha256=verified_hashes[selected_dataset.name],
    )
    selected_ids = resolved_selection.question_ids
    selected_set = set(selected_ids)
    selected = [case for case in cases if case.question_id in selected_set]
    selected.sort(key=lambda case: selected_ids.index(case.question_id))

    if run_id:
        run_path = RUNS_DIR / _slug(run_id)
    elif resume:
        existing = _latest_matching_run(config, selected_ids)
        if existing is None:
            raise FileNotFoundError("no previous run matches this configuration")
        run_path = existing
    else:
        run_path = RUNS_DIR / _new_run_id(config)

    manifest_path = run_path / "manifest.json"
    predictions_path = run_path / "predictions.jsonl"
    errors_path = run_path / "errors.jsonl"
    run_path.mkdir(parents=True, exist_ok=True)

    if manifest_path.exists():
        manifest = read_json(manifest_path)
        if manifest.get("config_fingerprint") != config.fingerprint():
            raise ValueError("run ID already exists with a different configuration")
        if manifest.get("selected_question_ids") != selected_ids:
            raise ValueError("run ID already exists with a different question selection")
        if not resume:
            raise FileExistsError(f"run already exists; pass --resume: {run_path.name}")
    else:
        manifest = {
            "schema_version": 2,
            "run_id": run_path.name,
            "status": "running",
            "created_at": utc_now(),
            "updated_at": utc_now(),
            "config_source": _display_path(config_path),
            "config": config.canonical_dict(),
            "config_fingerprint": config.fingerprint(),
            "git": git_state(PROJECT_ROOT),
            "dataset_hashes": verified_hashes,
            "dataset_mode": config.mode,
            "selected_question_ids": selected_ids,
            "selected_count": len(selected_ids),
            "selection": resolved_selection.metadata,
            "completed_count": 0,
            "failure_count": 0,
        }
        write_json(manifest_path, manifest)
        (run_path / "config.yaml").write_text(config_path.read_text())

    completed_records = read_jsonl(predictions_path)
    completed_ids = {item["question_id"] for item in completed_records}
    if len(completed_ids) != len(completed_records):
        raise ValueError("predictions contain duplicate question IDs")

    models = create_model_gateway(config.answer, config.agent.models)
    agent = load_agent(config.agent, models)

    for case in selected:
        if case.question_id in completed_ids:
            continue
        models.begin_case()
        try:
            await agent.reset(case.metadata())
            for session in sanitized_sessions(case):
                await agent.ingest(session)
            result = await agent.answer(case.question, case.question_date)
            model_calls = models.finish_case()
            record = PredictionRecord(
                question_id=case.question_id,
                question_type=case.question_type,
                hypothesis=result.hypothesis,
                evidence=result.evidence,
                trace=result.trace,
                generation=result.generation,
                model_calls=model_calls,
            )
            append_jsonl(predictions_path, record.model_dump(mode="json", exclude_none=True))
            completed_ids.add(case.question_id)
        except Exception as exc:
            models.finish_case()
            retryable = isinstance(exc, ProviderError) and exc.retryable
            failure = FailureRecord(
                question_id=case.question_id,
                error_type=type(exc).__name__,
                message=str(exc),
                retryable=retryable,
                status_code=exc.status_code if isinstance(exc, ProviderError) else None,
                provider_code=exc.provider_code if isinstance(exc, ProviderError) else None,
                request_id=exc.request_id if isinstance(exc, ProviderError) else None,
            )
            append_jsonl(errors_path, failure.model_dump(mode="json", exclude_none=True))

        unresolved = _unresolved_failures(errors_path, completed_ids)
        manifest.update(
            {
                "updated_at": utc_now(),
                "completed_count": len(completed_ids & selected_set),
                "failure_count": len(unresolved),
                "status": "running",
            }
        )
        write_json(manifest_path, manifest)

    unresolved = _unresolved_failures(errors_path, completed_ids)
    complete = len(completed_ids & selected_set) == len(selected_ids)
    manifest.update(
        {
            "updated_at": utc_now(),
            "completed_at": utc_now() if complete else None,
            "completed_count": len(completed_ids & selected_set),
            "failure_count": len(unresolved),
            "status": "completed" if complete else "partial",
        }
    )
    write_json(manifest_path, manifest)
    return run_path


def _display_path(path: Path) -> str:
    resolved = path.resolve()
    try:
        return str(resolved.relative_to(PROJECT_ROOT))
    except ValueError:
        return str(resolved)


def _unresolved_failures(errors_path: Path, completed_ids: set[str]) -> set[str]:
    return {
        item["question_id"]
        for item in read_jsonl(errors_path)
        if item.get("question_id") not in completed_ids
    }


def prediction_payload(path: Path) -> list[dict[str, str]]:
    return [
        {"question_id": item["question_id"], "hypothesis": item["hypothesis"]}
        for item in read_jsonl(path)
    ]


def write_official_predictions(run_path: Path) -> Path:
    output = run_path / "official-predictions.jsonl"
    records = prediction_payload(run_path / "predictions.jsonl")
    with output.open("w") as handle:
        for record in records:
            handle.write(json.dumps(record, sort_keys=True) + "\n")
    return output
