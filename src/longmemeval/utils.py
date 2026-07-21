from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text())


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def append_jsonl(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as handle:
        handle.write(json.dumps(value, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    result: list[dict[str, Any]] = []
    for number, line in enumerate(path.read_text().splitlines(), start=1):
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError(f"expected object at {path}:{number}")
        result.append(value)
    return result


def git_state(root: Path) -> dict[str, Any]:
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        status = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        return {"commit": commit, "dirty": bool(status.strip())}
    except (subprocess.CalledProcessError, FileNotFoundError):
        return {"commit": None, "dirty": True}


SECRET_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9_-]{12,}"),
    re.compile(r"\bAIza[A-Za-z0-9_-]{20,}"),
]


def contains_secret(text: str) -> bool:
    if any(pattern.search(text) for pattern in SECRET_PATTERNS):
        return True
    for env_name in ("OPENAI_API_KEY", "GEMINI_API_KEY"):
        value = os.getenv(env_name)
        if value and len(value) >= 8 and value in text:
            return True
    return False
