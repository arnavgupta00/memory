# Architecture log

| ID | Status | Design | Diagram | Notes |
|---|---|---|---|---|
| `0001-full-context` | Frozen baseline | [Markdown](0001-full-context.md) | [Excalidraw](0001-full-context.excalidraw) | Complete raw history in one answer call; runnable from `agents.baselines.full_context` |
| `0002-temporal-context-graph` | Archived | [Markdown](0002-hierarchical-temporal-context-graph.md) | [Excalidraw](0002-hierarchical-temporal-context-graph.excalidraw) | Python temporal property graph and deterministic retrieval |
| `0003-contexto-shino-langgraph` | Recorded baseline | [Markdown](0003-contexto-shino-langgraph.md) | [Excalidraw](0003-contexto-shino-langgraph.excalidraw) | Initial TypeScript run; model-authored JSON Patch accepted only 12/97 Contexto batches |
| `0003.1-contexto-semantic-memory` | Superseded | [Study and revision](0003.1-contexto-semantic-memory-study.md) | [0003 workflow](0003-contexto-shino-langgraph.excalidraw) | Typed semantic updates; deterministic paths, provenance, temporal history, and per-update salvage |
| `0003.2-hybrid-graph-reader` | Preserved, superseded | [Markdown](0003.2-hybrid-graph-reader.md) · [2026-07-24 checkpoint](0003.2-CHECKPOINT-2026-07-24.md) | [Excalidraw](0003.2-hybrid-graph-reader.excalidraw) | Gates 0–6 passed; sealed Gate 7 scored 14/18 and failed its per-type threshold; the fresh blind Gate 8 scored 11/18, indistinguishable from the full-context baseline |

Keep previous rows and files immutable so every benchmark result can name the exact architecture
that produced it. The `0002.excalidraw` file is an early user draft and is intentionally not the
canonical diagram or a source file for Architecture 0003.
