# Current architecture

**Architecture ID:** `0003.2-hybrid-graph-reader`

Architecture 0003 is a strict TypeScript package. LangGraph owns orchestration; Zod owns runtime
contracts; Python owns only the stable LongMemEval harness and the NDJSON process bridge.

Start with these files:

1. [`src/workflow.ts`](src/workflow.ts) — graph topology and deterministic routes only.
2. [`src/state.ts`](src/state.ts) — the complete LangGraph state schema.
3. [`src/nodes/`](src/nodes/) — one small operation per file.
4. [`src/services/graphMutations.ts`](src/services/graphMutations.ts) — deterministic materialization,
   history, provenance, and per-update validation for Contexto semantic memories.
5. [`src/retrieval/hybridRetrieval.ts`](src/retrieval/hybridRetrieval.ts) — lossless local retrieval
   over complete sessions, graph cells, summaries, coverage fallbacks, and the raw tail.
6. [`prompts/`](prompts/) — every model instruction; there is no hidden prompt prose in TypeScript.

Sessions arrive one at a time. Every complete `B` sessions invoke Mr. Contexto to extract typed
semantic updates. Local code owns graph paths and mutation mechanics. Every complete `C` sessions
invoke Mr. Shino using only the graph snapshot and the target session IDs. Question arrival never
flushes a partial B/C window: deterministic retrieval indexes the tail directly.

```text
per session       ingestSession (local)
every B sessions  contexto (LLM) → validate/apply each semantic update (local) → mark tracked
every C sessions  shino (LLM) → attach window metadata (local) → mark tracked
per question      assembleRetrieval (local) → readMemory (LLM) → assembleContext (local)
                  → finalAnswer (LLM) → mapAnswerResult (local)
```

`assembleRetrieval` uses local BM25 and deterministic channel fusion—never embeddings—to search
complete role-tagged sessions, graph cells, Shino summaries, uncovered Contexto signals, and the
partial tail. `readMemory` converts those bounded candidates into a grounded evidence plan.
`assembleContext` then gives the Answer role only the selected raw turns, graph cells, summaries,
conflicts, and provenance. The complete graph and diagnostic ledgers remain durable artifacts but
are not dumped into the final model prompt.

Resume is hash-checked. Semantic replay applies only originally accepted update indices; every
final graph can be independently verified with `pnpm --filter @memorybench/contexto-shino-agent
verify:replay --run <run-path>`.

For `N` sessions, calls are exactly `floor(N/B) + floor(N/C) + 2`. The controlled repair uses B3/C9
with `gpt-5-nano-2025-08-07` for Contexto, Shino, Reader, and Answer.

The full design record, generated topology, and editable diagram are:

- [`architecture/0003-contexto-shino-langgraph.md`](architecture/0003-contexto-shino-langgraph.md)
- [`architecture/0003.1-contexto-semantic-memory-study.md`](architecture/0003.1-contexto-semantic-memory-study.md)
- [`architecture/0003.2-hybrid-graph-reader.md`](architecture/0003.2-hybrid-graph-reader.md)
- [`architecture/generated-workflow.mmd`](architecture/generated-workflow.mmd)
- [`architecture/0003.2-hybrid-graph-reader.excalidraw`](architecture/0003.2-hybrid-graph-reader.excalidraw)

Architecture 0002 and its tests are archived under
[`../../../legacy/python-architecture-0002/`](../../../legacy/python-architecture-0002/). Architecture
0001 remains runnable under [`../baselines/full_context/`](../baselines/full_context/).
