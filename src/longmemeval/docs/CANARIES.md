# Canary benchmarks

MemoryBench has two frozen, nested LongMemEval-S canaries. They are regression tools, not
substitutes for the official 500-case result.

| Slice | Cases | Intended use | Full-context cost estimate |
|---|---:|---|---:|
| Canary 2 | 60 | Small architecture, retrieval, and prompt changes | about $14 |
| Canary 1 | 150 | Major architecture or model changes | about $35 |
| Full benchmark | 500 | Release candidates and public results | about $115 |

Costs use July 2026 standard pricing for Gemini 3.1 Pro or GPT-4.1 answers and the canonical
GPT-4o judge. Actual memory architectures should cost less when they retrieve a compact context.

## Canary 2 design

Canary 2 is coverage-first rather than a simple random sample. Its 60 cases contain exactly ten
cases from each official question type:

| Question type | Cases | Abstentions |
|---|---:|---:|
| Knowledge update | 10 | 2 |
| Multi-session | 10 | 4 |
| Single-session assistant | 10 | 0 |
| Single-session preference | 10 | 0 |
| Single-session user | 10 | 2 |
| Temporal reasoning | 10 | 2 |

The ten abstentions preserve the full benchmark's 2/4/2/2 type ratio. The selection covers every
evidence-count shape present in each task type, all four evidence-position quartiles, and diversity
in history size, turn count, evidence span, question length, and answer length.

Ten cases per type makes each raw category score move in understandable ten-point increments.
Because rare tasks and abstentions are intentionally oversampled, reports also provide a
post-stratified estimate using the full 500-case question-type and abstention weights.

## Canary 1 design

Canary 1 contains 150 cases. It preserves 15 preference questions and 15 abstentions while keeping
the other strata close to their full-benchmark proportions. Canary 2 is a strict subset of Canary
1, so results from the smaller gate remain directly comparable when a change advances to the major
gate.

## Commands

```bash
# Small changes
uv run memorybench run --config src/agents/current/configs/canary-2-gemini.yaml
uv run memorybench judge --run RUN_ID
uv run memorybench report --run RUN_ID

# Major changes
uv run memorybench run --config src/agents/current/configs/canary-1-gemini.yaml

# OpenAI answerer variants
uv run memorybench run --config src/agents/current/configs/canary-2-openai.yaml
uv run memorybench run --config src/agents/current/configs/canary-1-openai.yaml
```

Use the raw canary score to detect exact regressions against earlier runs on the same frozen IDs.
Use `canary_estimate.population_weighted_accuracy` as the rough projection of overall 500-case
accuracy. Neither value should be published as an official LongMemEval-S score.

## Reproducibility

The tracked manifests in `src/longmemeval/slices/` contain the frozen IDs, dataset checksum, selection
seed, strata, and coverage record. `memorybench data verify` rejects a run if a manifest no longer
matches the pinned dataset or its declared counts. To inspect or intentionally regenerate the
selection algorithm:

```bash
uv run python -m longmemeval.tools.build_canaries
uv run memorybench data verify
```
