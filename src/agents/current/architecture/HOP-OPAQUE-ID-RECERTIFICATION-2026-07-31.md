# Hop v1 opaque-ID recertification — 2026-07-31

## Decision

The prior Luna-low H=6 answerable135 result of **123/135** is retained only as
a historical, label-leaked measurement. It is not a valid retrieval baseline.

The recertified operating baseline is:

| Stratum | Raw-ID historical | Opaque-ID recertified | Delta |
|---|---:|---:|---:|
| Hard | 19/28 | 17/28 | -2 |
| Mid | 10/12 | 10/12 | 0 |
| Easy | 94/95 | 93/95 | -1 |
| All | 123/135 | **120/135** | **-3** |

Strict mean gold recall changed from 0.9680 to 0.9551. Answer-bearing full
coverage changed from 127/135 to 125/135.

This is an observed single-run delta, not a causal estimate of label leakage:
the controller is stochastic, five cases changed pass/fail state, and one
historical failure became a success.

## Correction

`hopRetrieveGate.ts` now defaults to deterministic per-question opaque handles
such as `memory_017`.

- The notes index, BM25 hits, grep hits, bag, and tool arguments use opaque
  handles.
- Handle assignment is a question-namespaced hash permutation that does not use
  oracle labels or preserve raw-ID ordering.
- Raw IDs are restored only after the controller finishes, for scoring and the
  downstream-compatible `bag` field.
- Every API turn refuses to run if any raw per-case ID appears in model input.
- The legacy behavior is available only when explicitly requested with
  `--opaque-session-ids false`.

The data-level audit checked all 6,443 candidate documents in answerable135 and
found zero raw-ID leaks. The one-case live smoke trace contained no `answer_`
string in any model-visible step. All 59 tests pass.

## Measured cost and time

- Model: `gpt-5.6-luna`, reasoning `low`
- Prompt: `hop-retrieve-v1`
- Hop budget: 6; bag maximum: 12
- Input tokens: 1,561,040
- Output tokens: 93,855
- Configured price: $1.00/M input, $6.00/M output
- Estimated API cost: **$2.12417**
- Wall time: **156.3 seconds**
- Execution-only rate settings: concurrency 24, 2,000,000-token/60-second gate
- API/case errors: 0

Canonical artifact:
`runs/local-archive/backbone/hop-gate-luna-h6-v1-answerable135-opaque.json`

## Remaining certification boundary

This recertifies the hop retriever. The previously measured downstream Arm-3
answer scores are still historical because their model-visible catalogs and
contexts contain raw session IDs. Downstream masking and replay are a separate
recertification step; the corrected hop score does not validate those answer
scores.
