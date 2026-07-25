# Agents: build here

```text
agents/
├── current/                                  # Active architecture — build here
├── architecture-0003.2-hybrid-graph-reader/  # Preserved, still runnable
│   ├── src/
│   │   ├── host.ts               # Versioned Python↔Node NDJSON host
│   │   ├── workflow.ts           # LangGraph topology and routes only
│   │   ├── state.ts              # Zod StateSchema
│   │   ├── types.ts              # Shared runtime/domain contracts
│   │   ├── nodes/                # Small workflow nodes
│   │   └── services/             # Providers, prompts, graph gates, artifacts
│   ├── prompts/                  # Complete YAML instructions
│   ├── configs/                  # B3/C9, B9/C9, OpenAI, Gemini, mixed
│   ├── inspector/                # Hono SSE server + React/Cytoscape UI
│   ├── architecture/             # Versioned design and editable diagrams
│   └── tests/                    # Offline architecture tests
└── baselines/full_context/                   # Frozen runnable Architecture 0001
```

## Why `current/` restarted

Architecture 0003.2 combined query-blind graph construction, window summaries, multi-channel BM25,
and a dedicated Reader. Its fresh blind 18-case run scored 11/18. The full-context baseline scores
about 62% with the same answer model, and at 18 cases a single answer moves the score by 5.6 points,
so the elaborate stack never demonstrated a real gain over the simple one.

Two things the run diagnostics established, which now govern the new line of work:

- BM25 over raw sessions found the reference session in 17 of 18 blind cases, while the constructed
  graph missed references that BM25 found. Raw sessions are the memory; structure is an accelerator.
- Six of seven answerable losses happened after retrieval had already succeeded, in selection and
  answering rather than in recall.

`current/` therefore starts from the smallest system that can answer at all, and each additional
layer must earn its place with a measured delta on a sample large enough to distinguish signal from
sampling noise.

## Rules for the active architecture

Architecture code never imports the dataset, evaluator, runner, or publication internals. LongMemEval
calls `reset`, `ingest`, and `answer` across the process boundary and nothing else crosses it.

What you should normally leave alone: `src/longmemeval/`. It sanitizes benchmark cases, runs the
agent, owns manifests/predictions, and invokes the pinned canonical judge.

## Preserved work

Architecture 0003.2 remains buildable and runnable in place; its configs point at its own
`dist/host.js`. The complete pre-restart state is also tagged in git as
`architecture-0003.2-hybrid-graph-reader`.

Architecture 0002 is retained under [`../../legacy/python-architecture-0002/`](../../legacy/python-architecture-0002/)
for audit and reference, not imported at runtime.
