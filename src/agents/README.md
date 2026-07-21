# Agents: start here

This is the user-owned side of the repository. For architecture experiments, work only inside
`current/`.

```text
agents/
├── README.md
└── current/
    ├── __init__.py             # Dynamic factory export
    ├── system.py               # reset / ingest / answer: primary implementation
    ├── prompt.py               # Answer prompt owned by this architecture
    ├── config.py               # Architecture-specific option schema
    ├── configs/                # Gemini/OpenAI smoke, canary, and full runs
    ├── MODEL_ROLES.md          # Named generation/embedding API and configuration
    └── architecture/           # Markdown + Excalidraw architecture history
```

## Your primary entrypoint

Start with [`current/system.py`](current/system.py). `CurrentAgent` receives a stable
`AgentRuntime` containing an instrumented, named model gateway. LongMemEval then drives it as:

1. `reset(case)` starts an isolated benchmark case.
2. `ingest(session)` delivers one sanitized, timestamped session at a time.
3. `answer(question, question_date)` returns an `AnswerResult`.

Gold answers, answer-session IDs, and `has_answer` labels never reach the agent.

The final answerer is always available as `runtime.answer_role`. Extra generation and embedding
roles are declared under `agent.models` in the architecture-owned YAML:

```python
draft = await self.runtime.models.generate("memory_writer", extraction_prompt)
vectors = await self.runtime.models.embed("memory_embedder", memory_texts)
answer = await self.runtime.models.generate(self.runtime.answer_role, answer_prompt)
```

Read [`current/MODEL_ROLES.md`](current/MODEL_ROLES.md) before adding a multi-stage architecture.

Import public contracts only from `longmemeval.api`:

```python
from longmemeval.api import AgentRuntime, AnswerResult, CaseMetadata, TimestampedSession
```

Do not import `longmemeval.data`, `longmemeval.runner`, or evaluator internals into an architecture.

## Dynamic loading

Each YAML under [`current/configs/`](current/configs/) contains:

```yaml
agent:
  entrypoint: agents.current:create_agent
  models: {}
  options: {}
```

`current/__init__.py` exports `create_agent`. The harness imports it dynamically, so architecture
changes never require a benchmark registry edit. Architecture-specific settings belong under
`agent.options` and are validated in `current/config.py`. Provider-backed model declarations belong
under `agent.models`; the harness validates and instruments them without exposing the judge.

## Architecture history

The active design is summarized in [`current/ARCHITECTURE.md`](current/ARCHITECTURE.md). Versioned
records live in [`current/architecture/`](current/architecture/), beginning with
`0001-full-context.md` and `0001-full-context.excalidraw`.

For each meaningful architecture revision:

1. Add the next numbered Markdown and Excalidraw pair.
2. Add one row to `architecture/LOG.md`.
3. Update `current/ARCHITECTURE.md` to point at the latest pair.
4. Keep old records immutable so benchmark results can name an exact architecture ID.
