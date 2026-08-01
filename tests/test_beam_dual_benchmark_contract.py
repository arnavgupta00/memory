from __future__ import annotations

import ast
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CURRENT = ROOT / "src/agents/current"
PINNED_BEAM_COMMIT = "3e12035532eb85768f1a7cd779832b650c4b2ef9"


def test_longmemeval_defaults_remain_available() -> None:
    retrieval = (CURRENT / "src/scripts/hopArchitectureScreen.ts").read_text()
    downstream = (CURRENT / "src/scripts/hopBagDownstreamGate.ts").read_text()
    annotation = (CURRENT / "src/scripts/sessionAnnotate.ts").read_text()

    for source in (retrieval, downstream, annotation):
        assert 'data/raw/longmemeval_s_cleaned.json' in source
    assert 'args.dataset ?? DEFAULT_DATASET' in downstream
    assert 'args.annotations ?? DEFAULT_ANNOTATIONS' in downstream


def test_beam_runner_is_separate_and_captures_complete_model_io() -> None:
    package = json.loads((CURRENT / "package.json").read_text())
    scripts = package["scripts"]
    assert "run:beam-1m" in scripts
    assert "prepare:beam-1m" in scripts

    runner = (CURRENT / "src/scripts/beam1mCanary.ts").read_text()
    assert '"--capture-model-io", "true"' in runner
    assert '"--benchmark", "BEAM-1M"' in runner
    assert '"--arms", "3"' in runner
    assert 'answer_reasoning: "high"' in runner


def test_official_beam_judge_contract_is_pinned() -> None:
    path = CURRENT / "src/scripts/runBeamOfficialEvaluation.py"
    source = path.read_text()
    ast.parse(source)
    assert f'SOURCE_COMMIT = "{PINNED_BEAM_COMMIT}"' in source
    assert 'JUDGE_MODEL = "gpt-4.1-mini"' in source
    assert '"temperature=0"' in source
    assert 'src.evaluation.run_evaluation' in source
    assert "official BEAM evaluator sources or requirements are modified" in source
