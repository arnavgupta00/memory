# MemoryBench

MemoryBench is a reproducible LongMemEval-S harness and a workspace for developing long-term-memory
agents. The active agent is Architecture 0003.2: a strict TypeScript LangGraph workflow combining
Contexto/Shino graph memory with lossless local retrieval and a dedicated Reader. The benchmark
lifecycle and canonical evaluator remain in stable Python.

```text
src/
├── agents/current/      ← BUILD MEMORY ARCHITECTURES HERE (TypeScript)
└── longmemeval/         ← STABLE BENCHMARK HARNESS (Python)
```

## Architecture 0003.2 at a glance

Sessions arrive one by one. Local code archives every session. Mr. Contexto extracts typed semantic
memories after every complete B-session window; deterministic code owns graph paths, provenance,
temporal history, and a coverage audit. Mr. Shino summarizes the graph after every complete
C-session window. At question time, local BM25 searches complete raw sessions, graph cells, Shino
summaries, uncovered signals, and the unprocessed tail. A dedicated Reader selects grounded
evidence before the compact final answer call.

```text
session → ingestSession
              └─ every B → Contexto → per-memory validation/materialization → mutation ledger
                              └─ every C → Shino → summary ledger

question → local hybrid retrieval → Reader → compact evidence → final answer → AnswerResult
```

There are no embeddings, vector database, query-planner call, reranker call, partial-tail
consolidation, or hidden repair calls. Retrieval and rank fusion are deterministic local
operations. For `N` sessions, the exact agent call count is:

```text
floor(N / B) Contexto + floor(N / C) Shino + 1 Reader + 1 answer
```

Read [`src/agents/README.md`](src/agents/README.md), then
[`src/agents/current/ARCHITECTURE.md`](src/agents/current/ARCHITECTURE.md). The complete design is in
[`0003-contexto-shino-langgraph.md`](src/agents/current/architecture/0003-contexto-shino-langgraph.md),
with the graph-construction revision in
[`0003.1-contexto-semantic-memory-study.md`](src/agents/current/architecture/0003.1-contexto-semantic-memory-study.md)
and the active repair in
[`0003.2-hybrid-graph-reader.md`](src/agents/current/architecture/0003.2-hybrid-graph-reader.md).

## Setup

Prerequisites: Python 3.12, [`uv`](https://docs.astral.sh/uv/), Node.js 22+, and pnpm 10.

```bash
uv sync --locked --extra dev
pnpm install --frozen-lockfile
pnpm agent:build
cp environment.example .env
uv run memorybench data fetch
uv run memorybench doctor
uv run memorybench ui build
```

Put credentials only in `.env` as `OPENAI_API_KEY` and/or `GEMINI_API_KEY`. The canonical judge
requires OpenAI. Keys are ignored, redacted from diagnostic artifacts, and never intentionally
serialized.

## Controlled B3/C9 and B9/C9 runs

The first pair uses `gpt-5-nano-2025-08-07` for Contexto, Shino, Reader, and Answer. The two OpenAI
files differ semantically only in run name and `graph_batch_size`.

```bash
uv run memorybench run \
  --config src/agents/current/configs/architecture-0003-openai-b3-c9.yaml \
  --ui

uv run memorybench run \
  --config src/agents/current/configs/architecture-0003-openai-b9-c9.yaml \
  --ui
```

Equivalent Gemini templates and a mixed-provider example sit beside them. Commands never start a
paid run unless invoked explicitly.

An interrupted case replays accepted graph mutations, skips its durable session prefix, and reuses
any validated provider response saved before a crash:

```bash
uv run memorybench run --config CONFIG_PATH --resume
```

Then run the pinned canonical evaluator and report:

```bash
uv run memorybench judge --run RUN_ID
uv run memorybench report --run RUN_ID
```

## Memory Observatory

The read-only observer is a Hono service on `127.0.0.1` with an SSE event stream and a
React/Cytoscape interface. Closing or crashing the browser/server never controls the benchmark host.

```bash
uv run memorybench ui start --open
uv run memorybench ui status
uv run memorybench ui open --run RUN_ID
uv run memorybench ui export --run RUN_ID --question-id QUESTION_ID --batch 1
uv run memorybench ui stop
```

It displays the live Contexto → retrieval → Reader → Answer funnel, the nested semantic context
graph, B-session coverage and memory updates, C-session Shino windows, ranked retrieval channels,
Reader facts/conflicts, provenance and raw source turns, prompts/responses/usage, final answers, and
historical Python runs.

## Historical architectures and results

- Architecture 0001 remains runnable in
  [`src/agents/baselines/full_context/`](src/agents/baselines/full_context/).
- Architecture 0002 and its tests are archived in
  [`legacy/python-architecture-0002/`](legacy/python-architecture-0002/).
- The definitive GPT-5 nano full-context Canary-2 baseline is preserved at
  [`runs/baseline-canary-2-gpt-5-nano-20260722-v3/`](runs/baseline-canary-2-gpt-5-nano-20260722-v3/)
  and scored 37/60 (61.67%), including 8/10 abstentions.

Existing run directories are not migrated or rewritten.

## Benchmark pins

| Component | Pin |
|---|---|
| LongMemEval repository | `9e0b455f4ef0e2ab8f2e582289761153549043fc` |
| Cleaned dataset | `98d7416c24c778c2fee6e6f3006e7a073259d48f` |
| Canonical judge | `gpt-4o-2024-08-06`, temperature `0` |

## Offline validation

```bash
uv run ruff format --check .
uv run ruff check .
uv run mypy
uv run pytest
pnpm agent:typecheck
pnpm agent:lint
pnpm agent:test
pnpm ui:test
pnpm ui:build
```

CI is offline and requires no API key or dataset download.

Apache-2.0. See [`LICENSE`](LICENSE).
