# Frozen hop-bag downstream gate — answerable135

Date: 2026-07-30

## Decision

**Arm 3 (parallel per-session map/reduce) is the only qualifying candidate.**
It scored **118/135 (87.4%)**, versus **113/135 (83.7%)** for Architecture
0005.4.4: **+5 cases / +3.7 percentage points**.

This is a promising gate win, not yet a statistically secure ship decision.
The paired result versus the historical 0005.4.4 run was 11 wins / 6 losses
(two-sided exact sign-test p=0.332). Confirm Arm 3 in one frozen rerun before
choosing it as the production downstream reader.

## Frozen protocol

- Questions: all 135 answerable Phase-1 cases.
- Retriever input: frozen v1 / `gpt-5.6-luna` / low / H=6 bags from
  `hop-gate-luna-h6-v1-answerable135.json`.
- No oracle, gold IDs, new retrieval, or question-type routing was available to
  a downstream arm.
- Answerer for every arm: `answer-v8-preference`,
  `gpt-5.4-nano-2026-03-17`, medium reasoning.
- Package cap: 40 turns / 40,000 characters.
- Canonical judge: `gpt-4o-2024-08-06`, temperature 0.
- Arm/case tasks were interleaved; request concurrency 128 under a 2,000,000
  token / 60-second shared dispatch budget.
- Protocol run: 540/540 generation tasks completed, zero failures, in 473
  seconds. All 540 predictions passed the benchmark schema and package/citation
  integrity checks.

The first full pass under `hop-bag-downstream-answerable135-v1-*` is a retained
pilot, not the scored protocol run. It exposed one long-session edge where the
deterministic arms could exhaust 40k before representing every bag session. The
protocol run reserves one bounded verbatim excerpt per session before
adjacency/breadth; Arms 2 and 3 consequently covered all 363/363 hydrated
candidate sessions.

## Primary scores

| Reader | Correct | Accuracy | Delta vs 0005.4.4 | Paired wins / losses | Nano tokens | Est. nano cost |
|---|---:|---:|---:|---:|---:|---:|
| Architecture 0005.4.4 | 113/135 | 83.7% | — | — | — | — |
| Arm 1A — unchanged selector | 115/135 | 85.2% | +2 | 10 / 8 | 1,841,526 | $0.488 |
| Arm 1B — hop-aware guarded selector | 112/135 | 83.0% | -1 | 8 / 9 | 1,578,914 | $0.446 |
| Arm 2 — deterministic balanced package | 113/135 | 83.7% | 0 | 10 / 10 | 1,210,644 | $0.336 |
| **Arm 3 — per-session map/reduce** | **118/135** | **87.4%** | **+5** | **11 / 6** | **2,159,456** | **$0.632** |

Arm 3 also beat Arm 1A by 6 wins / 3 losses, Arm 1B by 8 / 2, and Arm 2 by
7 / 2. These paired differences are directionally useful but small-sample:
their exact p-values are 0.508, 0.109, and 0.180 respectively.

## Accuracy by question type

| Question type | N | 0005.4.4 | Arm 1A | Arm 1B | Arm 2 | **Arm 3** |
|---|---:|---:|---:|---:|---:|---:|
| knowledge-update | 20 | 18 | 18 | 17 | 19 | **18** |
| multi-session | 33 | 24 | 23 | 22 | 22 | **24** |
| single-session-assistant | 15 | 14 | 14 | 15 | 15 | **15** |
| single-session-preference | 15 | 12 | 13 | 13 | 11 | **13** |
| single-session-user | 17 | 15 | 15 | 14 | 15 | **16** |
| temporal-reasoning | 35 | 30 | 32 | 31 | 31 | **32** |

Arm 3 has no question-type regression versus Architecture 0005.4.4. Its gain
comes from assistant (+1), preference (+1), user-fact (+1), and temporal (+2),
while holding knowledge-update and multi-session.

## Retrieval-stratum and reachability view

| Reader | Hard (28) | Mid (12) | Easy (95) | Full-gold bag (123) | Incomplete-gold bag (12) |
|---|---:|---:|---:|---:|---:|
| Architecture 0005.4.4 | 20 | 7 | 86 | 104 | 9 |
| Arm 1A | 18 | 9 | 88 | 109 | 6 |
| Arm 1B | 19 | 8 | 85 | 106 | 6 |
| Arm 2 | 18 | 7 | 88 | 108 | 5 |
| **Arm 3** | **19** | **9** | **90** | **113** | **5** |

This split is important. Arm 3 improves the 123 cases whose frozen bag contains
all gold sessions from 104 to 113 correct, but falls from 9 to 5 on the 12
incomplete-bag cases. The reader is stronger when retrieval succeeds; remaining
end-to-end risk is concentrated in retriever misses. Arm 3 is one case below
0005.4.4 on the hard stratum, offset by +2 mid and +4 easy.

## Package and execution characteristics

| Arm | Mean items | Mean chars | Bag-session coverage | Model calls |
|---|---:|---:|---:|---:|
| 1A | 13.65 | 6,049 | 293/363 | 270 |
| 1B | 17.38 | 12,711 | 314/363 | 270 |
| 2 | 23.94 | 28,183 | 363/363 | 135 |
| 3 | 12.00 | 14,989 | 363/363 | 498 |

Interpretation:

- The unchanged selector is a useful low-complexity control and gains two cases.
- The notes-aware guarded selector increases coverage but does not improve
  accuracy; more selected context alone is not the missing mechanism.
- Deterministic breadth is cheapest and fully covers the bag, but its extra
  context does not beat 0005.4.4.
- Per-session extraction gives the best evidence compression and answer score,
  at the highest token/call cost.

## Next gate

Run **Arm 3 only** once more on the exact same frozen bags and unchanged
prompts/config. Predeclare confirmation as:

1. score at least 116/135;
2. paired net at least +3 versus Architecture 0005.4.4;
3. no question-type regression greater than one case;
4. all 135 cases complete with package/citation validation passing.

If confirmed, use the map/reduce reader as the leading downstream design and
separately improve the 12 incomplete-gold bags. Do not tune Arm 3 on individual
question IDs before that confirmation run.

## Judgeable run IDs

- `hop-bag-downstream-answerable135-protocol1-1a`
- `hop-bag-downstream-answerable135-protocol1-1b`
- `hop-bag-downstream-answerable135-protocol1-2`
- `hop-bag-downstream-answerable135-protocol1-3`
