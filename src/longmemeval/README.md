# LongMemEval harness

This package is the benchmark-owned side of MemoryBench. **Do not edit it when experimenting with
the memory architecture.**

It owns the stable execution boundary and LongMemEval-specific invariants:

- pinned dataset downloads and checksums;
- validation of all 500 cases and 30 abstentions;
- removal of gold-answer annotations before agent ingestion;
- one isolated agent instance state per question through `reset`;
- Gemini and OpenAI provider normalization;
- immutable JSONL checkpoints and resume behavior;
- frozen Canary 1 and Canary 2 selections;
- the pinned upstream `gpt-4o-2024-08-06` evaluator;
- weighted canary reports and complete-run publication guards.

## Internal map

| File | Responsibility |
|---|---|
| `api.py` | Stable types agents may import |
| `agent_loader.py` | Dynamically imports the factory named by agent YAML |
| `config.py` | Run/provider/judge/selection schema |
| `data.py` | Fetching, checksums, validation, and annotation stripping |
| `runner.py` | Case isolation, ingestion lifecycle, checkpointing, resume |
| `providers.py` | Gemini/OpenAI adapter normalization and retries |
| `evaluation.py` | Canonical judge execution and report aggregation |
| `selection.py` | Frozen canary loading and validation |
| `publication.py` | Complete 500-case result freezing and secret checks |
| `slices/` | Tracked Canary 1 and Canary 2 manifests |
| `tools/` | Benchmark-maintainer utilities such as canary generation |

The only intended dependency direction is:

```text
longmemeval runner ──loads──> agents.current:create_agent
agents.current ──imports───> longmemeval.api
```

The agent must not import harness internals, and the harness must not contain architecture-specific
branches.
