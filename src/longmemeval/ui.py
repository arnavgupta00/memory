from __future__ import annotations

import json
import os
import signal
import subprocess
import time
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

from longmemeval.constants import PROJECT_ROOT, RUNS_DIR
from longmemeval.models import JsonValue
from longmemeval.utils import read_json

_CACHE = PROJECT_ROOT / ".cache"
_STATE = _CACHE / "memorybench-ui.json"
_LOG = _CACHE / "memorybench-ui.log"
_AGENT = PROJECT_ROOT / "src" / "agents" / "current"
_WEB = _AGENT / "inspector" / "web"


def build_ui() -> Path:
    """Build the TypeScript host/server and React observer from the root lockfile."""

    subprocess.run(["pnpm", "install", "--frozen-lockfile"], cwd=PROJECT_ROOT, check=True)
    subprocess.run(["pnpm", "--dir", str(_AGENT), "run", "build"], cwd=PROJECT_ROOT, check=True)
    subprocess.run(["pnpm", "--dir", str(_WEB), "run", "build"], cwd=PROJECT_ROOT, check=True)
    return _WEB / "dist"


def _state() -> dict[str, JsonValue]:
    if not _STATE.exists():
        return {}
    value: JsonValue = read_json(_STATE)
    return value if isinstance(value, dict) else {}


def _owns_process(pid: int) -> bool:
    result = subprocess.run(
        ["ps", "-p", str(pid), "-o", "command="],
        check=False,
        capture_output=True,
        text=True,
    )
    command = result.stdout.strip()
    return "tsx" in command and "inspector/server/index.ts" in command


def status_ui() -> dict[str, JsonValue]:
    state = _state()
    pid = state.get("pid")
    running = False
    if isinstance(pid, int) and _owns_process(pid):
        try:
            os.kill(pid, 0)
            running = True
        except OSError:
            running = False
    url = state.get("url")
    healthy = False
    if running and isinstance(url, str):
        try:
            with urllib.request.urlopen(f"{url}/api/runs", timeout=0.7) as response:
                healthy = response.status == 200
        except OSError:
            healthy = False
    return {**state, "running": running, "healthy": healthy}


def start_ui(*, open_browser: bool = True, port: int = 8765) -> dict[str, JsonValue]:
    current = status_ui()
    if current.get("running") is True and current.get("healthy") is True:
        if open_browser and isinstance(current.get("url"), str):
            webbrowser.open(str(current["url"]))
        return current
    if current.get("running") is True:
        stop_ui()
    if not (_WEB / "dist" / "index.html").exists():
        build_ui()
    _CACHE.mkdir(parents=True, exist_ok=True)
    log_handle = _LOG.open("ab")
    environment = {
        **os.environ,
        "MEMORYBENCH_RUNS_DIR": str(RUNS_DIR),
        "MEMORYBENCH_UI_PORT": str(port),
        "MEMORYBENCH_WEB_DIST": str(_WEB / "dist"),
    }
    process = subprocess.Popen(
        [
            "node",
            "--import",
            "tsx",
            "inspector/server/index.ts",
        ],
        cwd=_AGENT,
        env=environment,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    log_handle.close()
    state: dict[str, JsonValue] = {
        "pid": process.pid,
        "url": f"http://127.0.0.1:{port}",
        "log": str(_LOG),
    }
    _STATE.write_text(json.dumps(state, indent=2) + "\n")
    healthy = False
    for _ in range(30):
        if process.poll() is not None:
            _STATE.unlink(missing_ok=True)
            raise RuntimeError(f"Memory Observatory failed to start; inspect {_LOG}")
        try:
            with urllib.request.urlopen(f"{state['url']}/api/runs", timeout=0.7) as response:
                healthy = response.status == 200
        except OSError:
            time.sleep(0.1)
            continue
        if healthy:
            break
    if not healthy:
        process.terminate()
        _STATE.unlink(missing_ok=True)
        raise RuntimeError(f"Memory Observatory did not become healthy; inspect {_LOG}")
    if open_browser:
        webbrowser.open(str(state["url"]))
    return {**state, "running": True, "healthy": True}


def open_ui(run_id: str | None = None) -> str:
    state = start_ui(open_browser=False)
    base = str(state["url"])
    url = f"{base}/?run={urllib.parse.quote(run_id)}" if run_id else base
    webbrowser.open(url)
    return url


def stop_ui() -> bool:
    state = status_ui()
    pid = state.get("pid")
    if not isinstance(pid, int) or state.get("running") is not True or not _owns_process(pid):
        return False
    os.kill(pid, signal.SIGTERM)
    for _ in range(20):
        if not _owns_process(pid):
            break
        time.sleep(0.1)
    if _owns_process(pid):
        os.kill(pid, signal.SIGKILL)
    _STATE.unlink(missing_ok=True)
    return True


def export_graph(run_id: str, question_id: str, batch: int | None = None) -> Path:
    candidates = list(RUNS_DIR.rglob(f"{run_id}/agent-artifacts/cases/{question_id}"))
    if len(candidates) != 1:
        raise FileNotFoundError("run/case artifact path is missing or ambiguous")
    case = candidates[0]
    if batch is None and (case / "final.svg").exists():
        return case / "final.svg"
    state = start_ui(open_browser=False)
    base = str(state["url"])
    query = "" if batch is None else f"?batch={batch}"
    url = (
        f"{base}/api/runs/{urllib.parse.quote(run_id, safe='')}"
        f"/cases/{urllib.parse.quote(question_id, safe='')}/export.svg{query}"
    )
    output = case / (f"batch-{batch:04d}.svg" if batch is not None else "final.svg")
    for _ in range(30):
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                output.write_bytes(response.read())
            return output
        except OSError:
            time.sleep(0.1)
    raise RuntimeError("Memory Observatory did not become ready for export")
