# Architecture log

| ID | Status | Design | Diagram | Notes |
|---|---|---|---|---|
| `0001-full-context` | Frozen baseline | [Markdown](0001-full-context.md) | [Excalidraw](0001-full-context.excalidraw) | Complete raw history in one answer call; runnable from `agents.baselines.full_context` |
| `0002-temporal-context-graph` | Current | [Markdown](0002-hierarchical-temporal-context-graph.md) | [Excalidraw](0002-hierarchical-temporal-context-graph.excalidraw) | B=3/B=9 single-tier graph consolidation; deterministic retrieval; no embeddings |

Keep previous rows and files immutable so every benchmark result can name the exact architecture
that produced it. The untracked `0002.excalidraw` file is an early user draft and is intentionally
not the canonical diagram.
