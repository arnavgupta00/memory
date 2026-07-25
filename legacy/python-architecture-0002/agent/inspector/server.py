from __future__ import annotations

import asyncio
import json
import os
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict

from agents.current.artifacts.svg import render_graph_svg
from agents.current.contracts.models import ConsolidationOutput, GraphState
from agents.current.memory.reducer import TemporalGraphReducer
from longmemeval.constants import RUNS_DIR
from longmemeval.models import JsonObject, JsonValue
from longmemeval.utils import read_json, read_jsonl


class RunSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    relative_path: str
    status: str
    architecture: str
    completed_count: int = 0
    selected_count: int = 0
    has_graph_artifacts: bool = False


class CaseSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    event_count: int
    batch_count: int
    has_final_graph: bool
    has_answer: bool


class CaseSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    run_id: str
    case_id: str
    graph: JsonObject
    events: list[JsonObject]
    sessions: list[JsonObject]
    model_calls: list[JsonObject]
    answer: JsonObject | None = None
    status: str


app = FastAPI(
    title="Memory Observatory API",
    version="1.0.0",
    description="Read-only LongMemEval temporal graph artifact inspector.",
)


def _runs_root() -> Path:
    configured = os.getenv("MEMORYBENCH_RUNS_DIR")
    return Path(configured).resolve() if configured else RUNS_DIR.resolve()


def _run_paths() -> dict[str, Path]:
    root = _runs_root()
    paths: dict[str, Path] = {}
    if not root.exists():
        return paths
    for manifest in root.rglob("manifest.json"):
        run = manifest.parent.resolve()
        if root not in run.parents and run != root:
            continue
        relative = str(run.relative_to(root))
        paths[relative] = run
    return paths


def _run_path(run_id: str) -> Path:
    path = _run_paths().get(run_id)
    if path is None:
        raise HTTPException(status_code=404, detail="run not found")
    return path


def _case_path(run_id: str, case_id: str) -> Path:
    run = _run_path(run_id)
    allowed = run / "agent-artifacts" / "cases"
    candidate = (allowed / case_id).resolve()
    if allowed.resolve() not in candidate.parents or not candidate.is_dir():
        raise HTTPException(status_code=404, detail="case artifacts not found")
    return candidate


def _json_object(path: Path) -> JsonObject:
    if not path.exists():
        return {}
    value: JsonValue = read_json(path)
    return value if isinstance(value, dict) else {}


def _integer(value: JsonValue, default: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return default
    try:
        return int(value)
    except ValueError:
        return default


@app.get("/api/runs", response_model=list[RunSummary])
async def list_runs() -> list[RunSummary]:
    unique = sorted(set(_run_paths().values()), key=lambda item: item.name, reverse=True)
    summaries: list[RunSummary] = []
    root = _runs_root()
    for path in unique:
        manifest = _json_object(path / "manifest.json")
        config = manifest.get("config")
        agent = config.get("agent") if isinstance(config, dict) else None
        entrypoint = agent.get("entrypoint") if isinstance(agent, dict) else "legacy"
        artifacts = path / "agent-artifacts" / "cases"
        relative = str(path.relative_to(root))
        summaries.append(
            RunSummary(
                id=relative,
                relative_path=relative,
                status=str(manifest.get("status", "legacy")),
                architecture=str(entrypoint),
                completed_count=_integer(manifest.get("completed_count")),
                selected_count=_integer(manifest.get("selected_count")),
                has_graph_artifacts=artifacts.is_dir(),
            )
        )
    return summaries


@app.get("/api/runs/{run_id}/cases", response_model=list[CaseSummary])
async def list_cases(run_id: str) -> list[CaseSummary]:
    root = _run_path(run_id) / "agent-artifacts" / "cases"
    if not root.exists():
        return []
    summaries: list[CaseSummary] = []
    for path in sorted(root.iterdir()):
        if not path.is_dir():
            continue
        events = read_jsonl(path / "events.jsonl")
        batch_files = (
            len(list((path / "batches").glob("*.json"))) if (path / "batches").is_dir() else 0
        )
        event_batches = sum(item.get("event_type") == "batch_applied" for item in events)
        summaries.append(
            CaseSummary(
                id=path.name,
                event_count=len(events),
                batch_count=max(batch_files, event_batches),
                has_final_graph=(path / "final-graph.json").exists(),
                has_answer=(path / "answer.json").exists(),
            )
        )
    return summaries


def _snapshot(run_id: str, case_id: str, batch: int | None) -> CaseSnapshot:
    path = _case_path(run_id, case_id)
    events = read_jsonl(path / "events.jsonl")
    if batch is not None:
        batch_events = [item for item in events if item.get("event_type") == "batch_applied"]
        if batch < 0 or batch > len(batch_events):
            raise HTTPException(status_code=400, detail="batch is outside replay range")
        allowed_sequence = int(batch_events[batch - 1]["sequence"]) if batch > 0 else 0
        events = [item for item in events if int(item.get("sequence", 0)) <= allowed_sequence]
    if batch is None and (path / "final-graph.json").exists():
        graph = _json_object(path / "final-graph.json")
    else:
        reducer = TemporalGraphReducer(case_id)
        for event in events:
            if event.get("event_type") != "batch_applied":
                continue
            payload = event.get("payload")
            if not isinstance(payload, dict):
                continue
            raw_batch_id = payload.get("batch_id")
            raw_session_ids = payload.get("session_ids")
            raw_output = payload.get("consolidation")
            if (
                isinstance(raw_batch_id, str)
                and isinstance(raw_session_ids, list)
                and all(isinstance(item, str) for item in raw_session_ids)
                and isinstance(raw_output, dict)
            ):
                reducer.apply(
                    raw_batch_id,
                    [item for item in raw_session_ids if isinstance(item, str)],
                    ConsolidationOutput.model_validate(raw_output),
                )
        graph = reducer.graph.model_dump(mode="json")
    answer = _json_object(path / "answer.json") or None
    return CaseSnapshot(
        run_id=run_id,
        case_id=case_id,
        graph=graph,
        events=[dict(item) for item in events],
        sessions=[dict(item) for item in read_jsonl(path / "sessions.jsonl")],
        model_calls=[dict(item) for item in read_jsonl(path / "model-calls" / "calls.jsonl")],
        answer=answer,
        status="completed" if answer else "live",
    )


@app.get("/api/runs/{run_id}/cases/{case_id}", response_model=CaseSnapshot)
async def get_case(
    run_id: str,
    case_id: str,
    batch: int | None = Query(default=None, ge=0),
) -> CaseSnapshot:
    return _snapshot(run_id, case_id, batch)


@app.get("/api/runs/{run_id}/cases/{case_id}/export.svg", response_class=Response)
async def export_case_svg(
    run_id: str,
    case_id: str,
    batch: int | None = Query(default=None, ge=0),
) -> Response:
    snapshot = _snapshot(run_id, case_id, batch)
    graph = GraphState.model_validate(snapshot.graph)
    return Response(content=render_graph_svg(graph), media_type="image/svg+xml")


@app.get("/api/runs/{run_id}/cases/{case_id}/events")
async def stream_case_events(
    run_id: str,
    case_id: str,
    after: int = Query(default=0, ge=0),
    last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
) -> StreamingResponse:
    path = _case_path(run_id, case_id) / "events.jsonl"
    if last_event_id is not None:
        try:
            after = max(after, int(last_event_id))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid Last-Event-ID") from exc

    async def stream() -> AsyncIterator[str]:
        last = after
        idle = 0
        while True:
            records = read_jsonl(path)
            fresh = [item for item in records if int(item.get("sequence", 0)) > last]
            for record in fresh:
                last = int(record.get("sequence", last))
                yield f"id: {last}\nevent: memory\ndata: {json.dumps(record)}\n\n"
                idle = 0
            if not fresh:
                idle += 1
                if idle % 15 == 0:
                    yield ": keep-alive\n\n"
            await asyncio.sleep(1)

    return StreamingResponse(stream(), media_type="text/event-stream")


WEB_ROOT = Path(__file__).resolve().parent / "web"
DIST_ROOT = WEB_ROOT / "dist"
if DIST_ROOT.exists():
    app.mount("/assets", StaticFiles(directory=DIST_ROOT / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def frontend(path: str) -> FileResponse:
        candidate = DIST_ROOT / path
        if path and candidate.is_file() and DIST_ROOT in candidate.resolve().parents:
            return FileResponse(candidate)
        return FileResponse(DIST_ROOT / "index.html")
