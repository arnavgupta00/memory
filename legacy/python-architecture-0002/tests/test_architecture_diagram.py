from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def test_architecture_0002_excalidraw_is_native_and_internally_linked() -> None:
    path = (
        Path(__file__).parents[1]
        / "src"
        / "agents"
        / "current"
        / "architecture"
        / "0002-hierarchical-temporal-context-graph.excalidraw"
    )
    drawing: dict[str, Any] = json.loads(path.read_text())
    assert drawing["type"] == "excalidraw"
    assert drawing["version"] == 2
    elements = drawing["elements"]
    ids = [element["id"] for element in elements]
    assert len(ids) == len(set(ids))
    for arrow in (element for element in elements if element["type"] == "arrow"):
        for binding_name in ("startBinding", "endBinding"):
            binding = arrow.get(binding_name)
            if binding is not None:
                assert binding["elementId"] in ids

    text = "\n".join(element["text"] for element in elements if element["type"] == "text")
    assert "ceil(N / B) + 3" in text
    assert "Embedding model API calls: 0" in text
    assert "B = 9 replaces the B = 3 cadence" in text
    assert "passive observer · zero additional LLM calls" in text
    assert "No model API" in text
