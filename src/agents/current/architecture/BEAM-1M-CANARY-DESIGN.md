# BEAM-1M canary design

**Status:** frozen / Canary A measured / structurally validated / dual-benchmark runner implemented
**Source:** BEAM commit `3e12035532eb85768f1a7cd779832b650c4b2ef9`
**Selection seed:** `20260731`

**Measured checkpoint:** [BEAM-1M Canary A — 2026-08-01](BEAM-1M-CANARY-A-CHECKPOINT-2026-08-01.md)

## Decision

BEAM-1M is partitioned at the complete-conversation boundary. Questions from
one conversation never cross development and certification partitions.

| Partition | Conversations | Questions | Intended use |
|---|---:|---:|---|
| Canary A | 5 | 100 | Development, debugging, and permitted tuning |
| Canary B | 13 | 260 | Sealed score prediction after architecture freeze |
| Blind reserve | 17 | 340 | Variance-only expansion and final confirmation |

Every conversation has exactly two questions for each of the ten BEAM
abilities, so both canaries are exactly ability-balanced.

## Frozen conversation partition

- Canary A: `3, 8, 18, 25, 29`
- Canary B: `1, 2, 9, 10, 12, 14, 17, 22, 24, 26, 27, 30, 35`
- Expansion to 15: `16, 21`
- Expansion to 17: `7, 34`
- Final blind confirmation: `4, 5, 6, 11, 13, 15, 19, 20, 23, 28, 31, 32, 33`

The expansion order is fixed before model inference. Expansion is allowed only
when the conversation-level finite-population 95% confidence interval has a
half-width above five percentage points. The observed point score must never
influence expansion.

## Selection isolation

The optimizer used:

- topic category;
- message, pair, turn-group, character, and time-anchor counts;
- difficulty labels;
- anonymous source-ID counts and normalized source positions;
- event-ordering, summarization, and multi-session evidence breadth.

It did not use question text, ideal answers, rubric content, model outputs, or
Architecture 0008 results. Session/message IDs remain host-only evaluation
metadata.

Canary A deliberately emphasizes diagnostic diversity and may be inspected.
Canary B and the reserve must stay sealed until the architecture, prompts,
models, caps, and scorer are frozen. Tuning after Canary B is unsealed retires
that certification result.

## Structural fit of Canary B

| Statistic | Full 700 | Canary B 260 |
|---|---:|---:|
| Mean source pairs | 6.7071 | 6.7962 |
| Median source pairs | 3 | 3 |
| P90 source pairs | 25 | 25 |
| Maximum source pairs | 48 | 48 |
| Exceeds bag-12 | 107 (15.29%) | 39 (15.00%) |
| Exceeds 20 pairs | 82 (11.71%) | 30 (11.54%) |
| Exceeds pool-24 | 71 (10.14%) | 27 (10.38%) |

Across the normalized selection features, Canary B has RMS standardized mean
difference `0.0792` and maximum absolute difference `0.1768`. Its two omitted
rare categories—Education & Learning and Relationship & Family—each represent
only one of the 35 conversations; keeping proportional Coding and Math coverage
produced the lower aggregate imbalance.

## Reliability contract

Primary metric: official BEAM macro score across the ten abilities.

- Target uncertainty: conversation-level 95% interval half-width at most `0.05`.
- Published reference points: RAG `0.302`; LIGHT `0.336`.
- Green: lower confidence bound exceeds `0.336`.
- Promising: point estimate exceeds `0.302`, but the interval overlaps `0.336`.
- Red: upper confidence bound is below `0.302`.

Canary A is measured; Canary B remains sealed. The canary design is still
**empirically provisional** for full-700 score prediction.
The upstream repository does not contain published per-conversation baseline
outputs, so retrospective score-prediction backtesting is unavailable. Canary B
becomes empirically certified only after its prediction is compared with one
paired, unchanged full-700 run.

## Canonical artifacts

- `eval-slices/beam-1m/beam-1m-canary-a-development-v1.json`
- `eval-slices/beam-1m/beam-1m-canary-b-certification-v1.json`
- `eval-slices/beam-1m/beam-1m-blind-reserve-v1.json`
- `eval-slices/beam-1m/beam-1m-canary-design-v1.json`
- `eval-slices/beam-1m/CHECKSUMS.sha256`
- `src/scripts/buildBeam1mCanaries.ts`

## Dual-benchmark execution contract

BEAM is an adapter around Architecture 0008, not a replacement for the
LongMemEval path. The original LongMemEval JSON array remains the default input
to ingestion, hybrid retrieval, and downstream Arm 3. The BEAM adapter writes a
compact shared-conversation bundle that those same stages can load only when an
explicit `--dataset` is supplied.

The BEAM memory unit is one official `turns` group: the main question and all
of its user/assistant follow-ups. Raw BEAM message IDs and `source_chat_ids`
remain host-only. Source message IDs are mapped to these memory units solely in
the separate oracle file used for post-run recall measurement.

Canary execution is orchestrated by `src/scripts/beam1mCanary.ts`. A fresh full
run performs, in order:

1. pinned-source and Python-dependency preflight;
2. checksum-verified BEAM input preparation;
3. fresh USER-turn session annotation;
4. unchanged Architecture 0008 hybrid retrieval;
5. unchanged Nano-low Arm 3 extraction and Luna-high answer generation;
6. export into the official per-conversation BEAM answer schema;
7. the upstream evaluator at the pinned source commit;
8. official-score aggregation and conversation-level uncertainty reporting.

The judge wrapper copies the pinned upstream evaluator to an ephemeral runtime
directory, injects the API key into runtime configuration only, and invokes
`src.evaluation.run_evaluation` unchanged. It refuses a modified evaluator or a
different commit. The official judge remains `gpt-4.1-mini` at temperature
zero; event ordering is reported by `tau_norm`, while the other nine abilities
use `llm_judge_score`, matching the upstream reporting convention.

`pnpm --dir src/agents/current setup:beam-judge` creates an ignored Python
3.12 environment containing the evaluator-only subset of the upstream pinned
requirements. The orchestrator discovers that environment automatically; an
alternative interpreter can be supplied explicitly. It likewise discovers a
pinned evaluator checkout at `runs/.beam-official-source`, while still
accepting an explicit source checkout.

Every inference stage writes full prompts, parsed outputs, usage, latency,
request IDs, retries, search traces, pools, bags, context packages, predictions,
and errors under the run directory. Gold provenance and rubrics are excluded
from all inference artifacts.

Additional implementation artifacts:

- `src/benchmarks/architectureDataset.ts`
- `src/benchmarks/beam1m.ts`
- `src/scripts/prepareBeam1m.ts`
- `src/scripts/exportBeam1mAnswers.ts`
- `src/scripts/runBeamOfficialEvaluation.py`
- `src/scripts/summarizeBeam1mEvaluation.ts`
- `src/scripts/beam1mCanary.ts`
