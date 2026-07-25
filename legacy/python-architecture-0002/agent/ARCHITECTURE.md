# Current architecture

**Architecture ID:** `0002-temporal-context-graph`

This is the active experimental agent. It converts configurable batches of sanitized sessions into
an append-only temporal property graph, retrieves evidence without embeddings, and answers from a
budgeted context package. The controlled experiment compares `batch_size: 3` with `batch_size: 9`;
there is no separate nine-session reflection stage.

Start in [`system.py`](system.py). Its three benchmark entrypoints delegate to two readable flows:

- [`workflows/construction.py`](workflows/construction.py): archive → buffer → consolidate → validate
  → resolve identities → reduce temporal operations;
- [`workflows/answering.py`](workflows/answering.py): plan → deterministic retrieval → rank fusion →
  rerank → compile context → answer.

All four model instructions live under [`prompts/`](prompts/). Python validates their declared
`{variables}` and structured output contract before any request. Graph records and LLM draft
operations are strict Pydantic models under [`contracts/`](contracts/); dynamic graph values use the
recursive `JsonValue` type rather than `Any`.

The canonical graph is the machine source of truth. The nested context tree is a projection for
people. Prior facts are retained as `superseded` or `contradicted`, stable entity IDs are assigned
locally, and every accepted fact carries session/turn/date/batch provenance.

The exact design record is maintained as a pair:

- [`architecture/0002-hierarchical-temporal-context-graph.md`](architecture/0002-hierarchical-temporal-context-graph.md)
- [`architecture/0002-hierarchical-temporal-context-graph.excalidraw`](architecture/0002-hierarchical-temporal-context-graph.excalidraw)

Architecture `0001` remains runnable under [`../baselines/full_context/`](../baselines/full_context/).
