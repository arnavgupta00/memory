from __future__ import annotations

from pathlib import Path

import pytest

from longmemeval.artifacts import FileArtifactStore, redact_json


@pytest.mark.asyncio
async def test_harness_artifacts_redact_secrets(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-secret-value-123456")
    store = FileArtifactStore(tmp_path)
    await store.append(
        "model-calls/calls",
        {
            "authorization": "Bearer private-token-123456",
            "prompt": "contains sk-test-secret-value-123456",
            "usage": {"input_tokens": 12, "output_tokens": 3, "total_tokens": 15},
            "access_token": "also-private",
        },
    )
    source = (tmp_path / "model-calls" / "calls.jsonl").read_text()
    assert "private-token" not in source
    assert "sk-test" not in source
    assert source.count("[REDACTED]") == 3
    assert '"input_tokens": 12' in source


@pytest.mark.asyncio
async def test_write_once_refuses_snapshot_overwrite(tmp_path: Path) -> None:
    store = FileArtifactStore(tmp_path)
    await store.write_once("final-graph.json", {"schema_version": 1})
    with pytest.raises(FileExistsError):
        await store.write_once("final-graph.json", {"schema_version": 2})


def test_redaction_preserves_json_pointer_provenance_and_hash_shape(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "configured-value-without-key-shape")
    graph = {
        "schemaVersion": 1,
        "revision": 1,
        "context": {
            "recipes": {
                "grandfathers_secret_dry_rub": "paprika and brown sugar",
            }
        },
        "provenanceByPointer": {
            "/context/recipes/grandfathers_secret_dry_rub": [
                {
                    "sessionId": "session-1",
                    "turnIndex": 0,
                    "sessionDate": "2026-07-24",
                    "batchId": "b0001",
                    "excerpt": "Grandfather's dry rub uses paprika and brown sugar.",
                }
            ]
        },
    }

    assert redact_json(graph) == graph


def test_redaction_keeps_secret_fields_and_values_secure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "configured-value-without-key-shape")

    assert redact_json(
        {
            "authorization": "weak auth value",
            "clientSecret": "weak client value",
            "service_api_key": "weak api value",
            "nested": {
                "accessToken": "weak access value",
                "prompt": "configured-value-without-key-shape",
                "response": "Bearer recognizable-token-12345",
            },
        }
    ) == {
        "authorization": "[REDACTED]",
        "clientSecret": "[REDACTED]",
        "service_api_key": "[REDACTED]",
        "nested": {
            "accessToken": "[REDACTED]",
            "prompt": "[REDACTED]",
            "response": "[REDACTED]",
        },
    }
