from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def test_architecture_0003_excalidraw_is_native_and_internally_linked() -> None:
    root = Path(__file__).parents[1] / "src" / "agents" / "current" / "architecture"
    path = root / "0003-contexto-shino-langgraph.excalidraw"
    drawing: dict[str, Any] = json.loads(path.read_text())
    assert drawing["type"] == "excalidraw"
    assert drawing["version"] == 2
    elements = drawing["elements"]
    ids = [element["id"] for element in elements]
    assert len(ids) == len(set(ids))
    for arrow in (element for element in elements if element["type"] == "arrow"):
        assert arrow["startBinding"]["elementId"] in ids
        assert arrow["endBinding"]["elementId"] in ids

    text = "\n".join(element["text"] for element in elements if element["type"] == "text")
    for phrase in (
        "Architecture 0003.1",
        "floor(N / B)",
        "floor(N / C)",
        "LLM-1 Mr. Contexto",
        "LLM-2 Mr. Shino",
        "LLM-3 Final Answerer",
        "zero additional LLM calls",
        "partial tail never flushed",
        "Personal Signal Index",
        "Question Evidence Projection",
        "Provenance Deduplicator",
        "Replay Guard",
        "query-blind",
        "Only this lane sees the question",
        "Signal · evidence · replay = 0 LLM calls",
    ):
        assert phrase in text


def test_prior_architecture_records_and_user_draft_are_preserved() -> None:
    root = Path(__file__).parents[1] / "src" / "agents" / "current" / "architecture"
    for name in (
        "0001-full-context.excalidraw",
        "0002-hierarchical-temporal-context-graph.excalidraw",
        "0002.excalidraw",
    ):
        assert (root / name).is_file()
