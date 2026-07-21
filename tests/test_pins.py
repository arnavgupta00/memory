import json
from pathlib import Path


def test_upstream_revisions_and_judge_are_pinned() -> None:
    root = Path(__file__).parents[1]
    lock = json.loads((root / "benchmark.lock.json").read_text())
    assert lock["longmemeval"]["revision"] == "9e0b455f4ef0e2ab8f2e582289761153549043fc"
    assert lock["dataset"]["revision"] == "98d7416c24c778c2fee6e6f3006e7a073259d48f"
    assert lock["canonical_judge"] == {
        "provider": "openai",
        "model": "gpt-4o-2024-08-06",
        "temperature": 0,
    }
    assert lock["longmemeval"]["evaluator"]["sha256"]
    assert all(item["sha256"] for item in lock["dataset"]["files"].values())
