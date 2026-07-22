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

The active answer prompt is
[`src/agents/current/prompts/full_history.yaml`](src/agents/current/prompts/full_history.yaml). Its
dynamic inputs are explicit `{variable}` placeholders; Python only validates and fills them.

You should not need to change `src/longmemeval/` while building retrieval, graph, consolidation,
temporal, or reasoning systems. That package owns dataset validation, case isolation, annotation
stripping, named provider calls, resumable runs, official judging, reporting, and publication checks.

## How the boundary works

Every architecture-owned YAML names a Python factory:

```yaml
agent:
  entrypoint: agents.current:create_agent
  models:
    memory_writer:
      kind: generation
      provider: openai
      model: gpt-4.1-mini-2025-04-14
    memory_embedder:
      kind: embedding
      provider: openai
      model: text-embedding-3-small
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

Inside agent code, model access is role-based:

```python
memory = await self.runtime.models.generate("memory_writer", prompt)
vectors = await self.runtime.models.embed("memory_embedder", texts)
answer = await self.runtime.models.generate(self.runtime.answer_role, final_prompt)
```

The canonical judge is never present in this gateway. Successful calls are automatically recorded
by role without serializing their prompt or input text. See
[`src/agents/current/MODEL_ROLES.md`](src/agents/current/MODEL_ROLES.md) and the
[`complex-agent.yaml`](src/agents/current/configs/examples/complex-agent.yaml) template.

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

# 60-case cost-efficient OpenAI baseline with pinned GPT-5 nano
uv run memorybench run \
  --config src/agents/current/configs/canary-2-gpt-5-nano.yaml

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

## Established baseline

The first preserved Canary-2 baseline uses `gpt-5-nano-2025-08-07` for answers and the canonical
`gpt-4o-2024-08-06` judge. It scored **37/60 (61.67%)**, including **8/10 abstention cases**.

The complete predictions, judgments, manifests, provider-error records, reports, and stabilization
runs are tracked under [`runs/`](runs/README.md). The definitive result is
[`baseline-canary-2-gpt-5-nano-20260722-v3`](runs/baseline-canary-2-gpt-5-nano-20260722-v3/report.json).

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
| `runs/` | Ignored mutable runs plus explicitly tracked verified baseline logs | Generated |
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
