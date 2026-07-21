from __future__ import annotations

import os
from pathlib import Path

import pytest

from longmemeval.config import load_config
from longmemeval.evaluation import build_report, judge_run
from longmemeval.runner import execute_run

pytestmark = [
    pytest.mark.paid,
    pytest.mark.skipif(
        os.getenv("MEMORYBENCH_RUN_PAID") != "1",
        reason="set MEMORYBENCH_RUN_PAID=1 to authorize paid provider calls",
    ),
]


@pytest.mark.parametrize(
    "config_name",
    ["oracle-smoke-gemini.yaml", "oracle-smoke-openai.yaml"],
)
@pytest.mark.asyncio
async def test_real_provider_oracle_smoke(config_name: str) -> None:
    root = Path(__file__).parents[2]
    config_path = root / "src" / "agents" / "current" / "configs" / config_name
    run_path = await execute_run(load_config(config_path), config_path)
    judge_run(run_path.name)
    report = build_report(run_path.name)
    assert report["completed_count"] == 5
    assert report["judged_count"] == 5
