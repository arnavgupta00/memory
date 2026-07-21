# MemoryBench

MemoryBench is a reproducible LongMemEval-S harness with one deliberate source-code boundary:

```text
src/
├── agents/          ← BUILD YOUR MEMORY ARCHITECTURE HERE
└── longmemeval/     ← BENCHMARK HARNESS; DO NOT EDIT FOR AGENT EXPERIMENTS
```

## Start here

Open [`src/agents/README.md`](src/agents/README.md), then work inside
[`src/agents/current/`](src/agents/current/). The active implementation, answer prompt, model/run
configurations, architecture explanation, and versioned Excalidraw diagrams all live there.

You should not need to change `src/longmemeval/` while building retrieval, graph, consolidation,
temporal, or reasoning systems. That package owns dataset validation, case isolation, annotation
stripping, provider calls, resumable runs, official judging, reporting, and publication checks.

## How the boundary works

Every architecture-owned YAML names a Python factory:

```yaml
agent:
  entrypoint: agents.current:create_agent
  options:
    chain_of_note: true
    history_format: json
```

The harness imports that entrypoint dynamically and supplies an `AgentRuntime`. It then calls only
three methods:

```python
async def reset(case): ...
async def ingest(session): ...
async def answer(question, question_date): ...
```

There is no architecture registry and no harness file to update. The stable types are exported by
[`longmemeval.api`](src/longmemeval/api.py).

## Setup

Prerequisites: Git and [`uv`](https://docs.astral.sh/uv/).

```bash
uv sync --extra dev
cp environment.example .env
uv run memorybench data fetch
uv run memorybench doctor
```

Add `OPENAI_API_KEY` and/or `GEMINI_API_KEY` to `.env`. The official judge always requires the
OpenAI key. Secrets are never written into run artifacts.

## Running the current agent

All runnable configurations belong to the current architecture:

```bash
# Five-case oracle plumbing check; not a comparable benchmark score
uv run memorybench run \
  --config src/agents/current/configs/oracle-smoke-gemini.yaml

# 60-case gate for small architecture changes
uv run memorybench run \
  --config src/agents/current/configs/canary-2-gemini.yaml

# 150-case gate for major architecture changes
uv run memorybench run \
  --config src/agents/current/configs/canary-1-gemini.yaml

# Full 500-case run
uv run memorybench run \
  --config src/agents/current/configs/full-context-gemini.yaml
```

Replace `gemini` with `openai` in the filename for the OpenAI answerer. Then judge and report:

```bash
uv run memorybench judge --run RUN_ID
uv run memorybench report --run RUN_ID
```

Interrupted runs resume without repeating completed question IDs:

```bash
uv run memorybench run --config CONFIG_PATH --resume
```

## What is frozen

| Component | Pin |
|---|---|
| LongMemEval repository | `9e0b455f4ef0e2ab8f2e582289761153549043fc` |
| Cleaned dataset | `98d7416c24c778c2fee6e6f3006e7a073259d48f` |
| Canonical judge | `gpt-4o-2024-08-06`, temperature `0` |

The Gemini examples use `gemini-3.1-pro-preview` because HydraDB's original
`gemini-3-pro-preview` was retired. Those runs are not model-identical reproductions of HydraDB's
result.

## Repository map

| Path | Meaning | Should architecture work change it? |
|---|---|---|
| `src/agents/current/` | Active memory architecture and all its configs | **Yes** |
| `src/agents/current/architecture/` | Architecture log and Excalidraw records | **Yes** |
| `src/longmemeval/` | LongMemEval-specific harness | No |
| `benchmark.lock.json` | Upstream revisions and checksums | No |
| `data/raw/` | Downloaded ignored benchmark data | No |
| `runs/` | Ignored resumable run artifacts | Generated |
| `submissions/` | Frozen complete 500-case result bundles | Generated |
| `tests/` | Offline contract and harness tests | Only when behavior changes |

See [`src/longmemeval/README.md`](src/longmemeval/README.md) for the harness internals and
[`src/longmemeval/docs/CANARIES.md`](src/longmemeval/docs/CANARIES.md) for canary methodology.

## Validation

```bash
uv run ruff format --check .
uv run ruff check .
uv run mypy
uv run pytest
uv run memorybench data verify
```

Paid tests are opt-in and never run in CI.

## License

Apache-2.0. See [`LICENSE`](LICENSE).

## Benchmark sources

- [LongMemEval repository](https://github.com/xiaowu0162/LongMemEval)
- [Cleaned dataset](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned)
- [ICLR 2025 paper](https://arxiv.org/abs/2410.10813)
