from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path
from typing import Final

from longmemeval.models import ArtifactReceipt, JsonObject, JsonValue
from longmemeval.utils import read_jsonl

_SAFE_NAME: Final[re.Pattern[str]] = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.\-/]*$")
_CAMEL_BOUNDARY: Final[re.Pattern[str]] = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")
_FIELD_SEPARATOR: Final[re.Pattern[str]] = re.compile(r"[- ]+")
_SECRET_FIELD_SUFFIXES: Final[tuple[str, ...]] = (
    "api_key",
    "authorization",
    "authorization_header",
    "auth_header",
    "bearer",
    "secret",
    "password",
    "access_token",
    "refresh_token",
    "id_token",
)
_VALUE_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"(?i)(sk-[a-z0-9_-]{12,}|AIza[a-z0-9_-]{12,}|Bearer\s+[a-z0-9._-]{12,})"
)


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _safe_relative(name: str) -> Path:
    if not _SAFE_NAME.fullmatch(name) or ".." in Path(name).parts:
        raise ValueError(f"unsafe artifact name: {name!r}")
    return Path(name)


def _known_secret_values() -> tuple[str, ...]:
    names = ("OPENAI_API_KEY", "GEMINI_API_KEY")
    return tuple(value for name in names if (value := os.getenv(name)))


def _is_json_pointer(key: str) -> bool:
    if key == "":
        return True
    if not key.startswith("/"):
        return False
    index = 0
    while index < len(key):
        if key[index] == "~":
            if index + 1 >= len(key) or key[index + 1] not in {"0", "1"}:
                return False
            index += 2
            continue
        index += 1
    return True


def _is_secret_field(key: str) -> bool:
    normalized = _FIELD_SEPARATOR.sub(
        "_", _CAMEL_BOUNDARY.sub("_", key)
    ).lower()
    return any(
        normalized == suffix or normalized.endswith(f"_{suffix}")
        for suffix in _SECRET_FIELD_SUFFIXES
    )


def redact_json(value: JsonValue) -> JsonValue:
    if isinstance(value, dict):
        return {
            key: (
                "[REDACTED]"
                if not _is_json_pointer(key) and _is_secret_field(key)
                else redact_json(item)
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact_json(item) for item in value]
    if isinstance(value, str):
        redacted = value
        for secret in _known_secret_values():
            redacted = redacted.replace(secret, "[REDACTED]")
        return _VALUE_PATTERN.sub("[REDACTED]", redacted)
    return value


class FileArtifactStore:
    """Append-only, case-scoped artifact store used by architecture implementations."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    async def append(self, stream: str, record: JsonObject) -> ArtifactReceipt:
        relative = _safe_relative(stream)
        if relative.suffix != ".jsonl":
            relative = relative.with_suffix(".jsonl")
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        sanitized = redact_json(record)
        sequence = len(read_jsonl(path)) + 1
        if isinstance(sanitized, dict) and "sequence" not in sanitized:
            sanitized = {"sequence": sequence, **sanitized}
        payload = (json.dumps(sanitized, sort_keys=True, ensure_ascii=False) + "\n").encode()
        with path.open("ab") as handle:
            handle.write(payload)
        return ArtifactReceipt(
            relative_path=str(relative), sequence=sequence, sha256=_sha256(payload)
        )

    async def write_once(self, name: str, value: JsonValue | str) -> ArtifactReceipt:
        relative = _safe_relative(name)
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            raise FileExistsError(f"artifact already exists: {relative}")
        sanitized = redact_json(value)
        if isinstance(sanitized, str):
            payload = sanitized.encode()
        else:
            payload = (json.dumps(sanitized, indent=2, sort_keys=True) + "\n").encode()
        path.write_bytes(payload)
        return ArtifactReceipt(relative_path=str(relative), sha256=_sha256(payload))

    async def replace(self, name: str, value: JsonValue | str) -> ArtifactReceipt:
        """Replace a derived snapshot; append-only streams remain the source of truth."""

        relative = _safe_relative(name)
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        sanitized = redact_json(value)
        payload = (
            sanitized.encode()
            if isinstance(sanitized, str)
            else (json.dumps(sanitized, indent=2, sort_keys=True) + "\n").encode()
        )
        path.write_bytes(payload)
        return ArtifactReceipt(relative_path=str(relative), sha256=_sha256(payload))

    def read_stream(self, stream: str) -> list[JsonObject]:
        relative = _safe_relative(stream)
        if relative.suffix != ".jsonl":
            relative = relative.with_suffix(".jsonl")
        return [dict(record) for record in read_jsonl(self.root / relative)]


class NullArtifactStore:
    """No-op store for tests and architecture 0001 outside a benchmark run."""

    async def append(self, stream: str, record: JsonObject) -> ArtifactReceipt:
        payload = json.dumps(redact_json(record), sort_keys=True).encode()
        return ArtifactReceipt(relative_path=stream, sha256=_sha256(payload))

    async def write_once(self, name: str, value: JsonValue | str) -> ArtifactReceipt:
        sanitized = redact_json(value)
        payload = (
            sanitized.encode()
            if isinstance(sanitized, str)
            else json.dumps(sanitized, sort_keys=True).encode()
        )
        return ArtifactReceipt(relative_path=name, sha256=_sha256(payload))

    def read_stream(self, stream: str) -> list[JsonObject]:
        return []
