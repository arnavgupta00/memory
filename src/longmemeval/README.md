# LongMemEval harness

This package is the benchmark-owned side of MemoryBench. Do not edit it for ordinary memory-agent
experiments.

It owns:

- pinned dataset downloads, checksums, all-500 validation, and 30 abstentions;
- removal of `answer`, `answer_session_ids`, and `has_answer` before agent ingestion;
- Python factory and versioned Node NDJSON agent backends;
- one isolated state/artifact namespace per case and run-level case concurrency;
- manifest, prediction, failure, judgment, report, resume, and publication behavior;
- generic Python provider/model roles retained for frozen Python baselines;
- the pinned `gpt-4o-2024-08-06` canonical evaluator.

## Internal map

| File | Responsibility |
|---|---|
| `api.py` | Stable contracts for Python baselines |
| `agent_loader.py` | Selects Python factory or Node proxy |
| `node_agent.py` | One host per run; concurrent versioned NDJSON RPC |
| `artifacts.py` | Case-scoped redacting Python artifact store |
| `config.py` | Run, backend, provider, judge, selection, execution schema |
| `data.py` | Fetching, pins, validation, sanitization |
| `runner.py` | Isolation, concurrency, checkpointing, prefix-aware resume |
| `evaluation.py` | Canonical judge and role/phase/cost reporting |
| `ui.py` | Hono/React observer build and process lifecycle |
| `selection.py` | Frozen canary loading and validation |
| `publication.py` | Complete 500-case freeze and secret guards |

The active direction is:

```text
LongMemEval runner → NodeAgentHost → <active agent package>/dist/host.js
```

The harness sends only reset, sanitized timestamped sessions, question text/date, configuration,
and isolated artifact paths. The Node agent returns the stable `AnswerResult` plus normalized model
call records. Architecture logic and prompt prose remain entirely under `src/agents/`.
