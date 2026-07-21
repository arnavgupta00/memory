from pathlib import Path

import pytest

from longmemeval.publication import freeze_run
from longmemeval.utils import contains_secret, write_json


def test_secret_detection() -> None:
    assert contains_secret("token=" + "sk-" + "abcdefghijklmnop")
    assert contains_secret("key=" + "AI" + "zaABCDEFGHIJKLMNOPQRSTUVWXYZ")
    assert not contains_secret("normal benchmark output")


def test_oracle_run_cannot_be_frozen(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    run_path = tmp_path / "run"
    run_path.mkdir()
    write_json(
        run_path / "manifest.json",
        {"dataset_mode": "oracle", "status": "completed", "selected_count": 500},
    )
    monkeypatch.setattr("longmemeval.publication.verify_data", lambda: {})
    monkeypatch.setattr("longmemeval.publication.resolve_run_path", lambda run_id: run_path)
    with pytest.raises(ValueError, match="oracle runs"):
        freeze_run("run", "invalid")


def test_submission_name_rejects_path_traversal() -> None:
    with pytest.raises(ValueError, match="submission name"):
        freeze_run("run", "../../outside")
