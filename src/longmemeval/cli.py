from __future__ import annotations

import asyncio
import json
import platform
import shutil
from pathlib import Path
from typing import Annotated

import typer

from longmemeval.config import load_config
from longmemeval.constants import PROJECT_ROOT
from longmemeval.data import DataValidationError, fetch_data, verify_data
from longmemeval.evaluation import build_report, judge_run
from longmemeval.publication import freeze_run
from longmemeval.runner import execute_run
from longmemeval.settings import credential_status, load_environment

app = typer.Typer(no_args_is_help=True, help="Reproducible LongMemEval-S benchmark harness.")
data_app = typer.Typer(no_args_is_help=True, help="Manage pinned benchmark data.")
ui_app = typer.Typer(no_args_is_help=True, help="Inspect live and historical memory graphs.")
app.add_typer(data_app, name="data")
app.add_typer(ui_app, name="ui")


def _emit(value: object) -> None:
    typer.echo(json.dumps(value, indent=2, sort_keys=True))


@app.callback()
def root() -> None:
    load_environment()


@app.command()
def doctor() -> None:
    """Check runtime, credentials, and benchmark data without exposing secrets."""

    checks: dict[str, object] = {
        "project_root": str(PROJECT_ROOT),
        "python": platform.python_version(),
        "python_3_12": platform.python_version_tuple()[:2] == ("3", "12"),
        "uv_available": shutil.which("uv") is not None,
        "credentials": credential_status(),
    }
    try:
        checks["data"] = {"valid": True, "hashes": verify_data()}
    except (DataValidationError, OSError, ValueError) as exc:
        checks["data"] = {"valid": False, "reason": str(exc)}
    _emit(checks)


@data_app.command("fetch")
def data_fetch(
    refresh_checksums: Annotated[
        bool,
        typer.Option(
            "--refresh-checksums",
            help="Populate missing checksums after intentionally reviewing a new lock revision.",
        ),
    ] = False,
) -> None:
    """Download pinned datasets and the canonical evaluator."""

    _emit(fetch_data(refresh_checksums=refresh_checksums))


@data_app.command("verify")
def data_verify() -> None:
    """Verify checksums and the complete 500-case schema."""

    _emit(verify_data())


@app.command("run")
def run_command(
    config: Annotated[Path, typer.Option("--config", exists=True, dir_okay=False)],
    question_id: Annotated[
        list[str] | None,
        typer.Option("--question-id", help="Run only this ID; repeat for multiple IDs."),
    ] = None,
    resume: Annotated[bool, typer.Option("--resume")] = False,
    run_id: Annotated[
        str | None, typer.Option("--run-id", help="Explicit run ID, especially for resume.")
    ] = None,
    ui: Annotated[bool, typer.Option("--ui", help="Start the passive graph inspector.")] = False,
) -> None:
    """Generate answers with immutable per-question checkpoints."""

    loaded = load_config(config)
    if ui:
        try:
            from longmemeval.ui import open_ui

            open_ui(run_id)
        except Exception as exc:
            typer.echo(f"Inspector warning: {exc}", err=True)
    path = asyncio.run(
        execute_run(
            loaded,
            config,
            requested_ids=question_id,
            resume=resume,
            run_id=run_id,
        )
    )
    _emit({"run_id": path.name, "path": str(path)})


@ui_app.command("build")
def ui_build() -> None:
    """Generate API contracts and build the inspector frontend."""

    from longmemeval.ui import build_ui

    _emit({"dist": str(build_ui())})


@ui_app.command("start")
def ui_start(
    open_browser: Annotated[bool, typer.Option("--open/--no-open")] = True,
    port: Annotated[int, typer.Option("--port", min=1024, max=65535)] = 8765,
) -> None:
    """Start or reuse the persistent localhost-only inspector."""

    from longmemeval.ui import start_ui

    _emit(start_ui(open_browser=open_browser, port=port))


@ui_app.command("status")
def ui_status() -> None:
    from longmemeval.ui import status_ui

    _emit(status_ui())


@ui_app.command("open")
def ui_open(
    run_id: Annotated[str | None, typer.Option("--run")] = None,
) -> None:
    from longmemeval.ui import open_ui

    _emit({"url": open_ui(run_id)})


@ui_app.command("stop")
def ui_stop() -> None:
    from longmemeval.ui import stop_ui

    _emit({"stopped": stop_ui()})


@ui_app.command("export")
def ui_export(
    run_id: Annotated[str, typer.Option("--run")],
    question_id: Annotated[str, typer.Option("--question-id")],
    batch: Annotated[int | None, typer.Option("--batch", min=0)] = None,
) -> None:
    from longmemeval.ui import export_graph

    _emit({"artifact": str(export_graph(run_id, question_id, batch))})


@app.command()
def judge(
    run_id: Annotated[str, typer.Option("--run", help="Run ID under runs/.")],
) -> None:
    """Judge a completed run with the pinned official evaluator."""

    path = judge_run(run_id)
    _emit({"run_id": run_id, "judgments": str(path)})


@app.command()
def report(
    run_id: Annotated[str, typer.Option("--run", help="Run ID under runs/.")],
) -> None:
    """Aggregate canonical accuracy, usage, latency, and publication metadata."""

    _emit(build_report(run_id))


@app.command()
def freeze(
    run_id: Annotated[str, typer.Option("--run", help="Run ID under runs/.")],
    name: Annotated[str, typer.Option("--name", help="Tracked submission directory name.")],
) -> None:
    """Freeze a complete clean full benchmark run into submissions/."""

    path = freeze_run(run_id, name)
    _emit({"run_id": run_id, "submission": str(path)})


if __name__ == "__main__":
    app()
