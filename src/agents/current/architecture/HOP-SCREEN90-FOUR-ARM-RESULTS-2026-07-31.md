# Hop retriever four-arm screen90 results — 2026-07-31

## Decision

The opaque-ID v1 control wins the 90-question stress screen. None of the three
candidate architectures qualifies for the fresh verification run.

| Arm | Strict full gold | Answer-bearing full | Candidate full gold | Mean bag | Cost | Wall time |
|---|---:|---:|---:|---:|---:|---:|
| **Opaque v1 H=6 control** | **76/90** | **80/90** | — | 2.83 | **$1.473** | 103.5s |
| Stateful sequential | 54/90 | 62/90 | 87/90 | 1.84 | $5.725 | 259.6s |
| Parallel multi-view | 48/90 | 53/90 | **88/90** | 1.47 | $1.923 | **99.3s** |
| Temporal claim ledger | 39/90 | 43/90 | 85/90 | 1.34 | **$1.219** | 345.6s |

The candidates did not lose primarily at search exposure. Their candidate pools
contained full strict gold for 87, 88, and 85 cases respectively. They lost at
verification/admission and complementary-coverage selection: their final bags
were much smaller than the control and omitted independently useful evidence.

Therefore the predeclared stopping rule applies: do not spend the fresh
192-question holdout on any current candidate.

## Configuration

- Slice: `hop-screen90-v1` (28 hard, 12 mid, 50 easy)
- The screen deliberately contains all 15 misses from the prior opaque v1 run.
- Model for all query-time reasoning: `gpt-5.6-luna`, low reasoning
- Bag maximum: 12
- Session handles: deterministic opaque `memory_*` handles
- Control: v1, H=6
- Candidate global execution target: 72 concurrent API calls and 1.8M TPM
- API/case errors: 0 in every arm
- Raw `answer_*` strings in candidate model-visible traces: 0

The slice is a development stress screen, not a population estimate.

## Paired strict outcomes versus control

| Candidate | Wins | Losses | Ties |
|---|---:|---:|---:|
| Stateful sequential | 3 | 25 | 62 |
| Parallel multi-view | 2 | 30 | 58 |
| Temporal claim ledger | 1 | 38 | 51 |

## Cost and behavior

| Arm | Input tokens | Output tokens | API calls | Oracle share of bag |
|---|---:|---:|---:|---:|
| Control | 1,070,932 | 66,977 | 857 | 76.1% |
| Stateful sequential | 4,839,107 | 147,598 | 1,103 | 94.6% |
| Parallel multi-view | 943,764 | 163,191 | 180 | 96.2% |
| Temporal claim ledger | 457,757 | 126,858 | 180 | 92.6% |

The high oracle shares show that the candidates were conservative rather than
randomly noisy. Conservatism became a recall failure: the stateful, parallel,
and ledger bags averaged only 1.84, 1.47, and 1.34 sessions, versus 2.83 for
the control. The stateful arm was also substantially more expensive because
the complete evidence ledger was repeated through many sequential calls.

## Canonical artifacts

- `runs/local-archive/backbone/hop-screen90-control-v1.json`
- `runs/local-archive/backbone/hop-screen90-stateful-v1.json`
- `runs/local-archive/backbone/hop-screen90-parallel-v1.json`
- `runs/local-archive/backbone/hop-screen90-ledger-v1.json`
- `src/agents/current/eval-slices/hop-screen90-v1.json`

## Adaptive follow-up: parallel discovery + v1 admission

After diagnosing Test 2's candidate-to-bag collapse, a focused hybrid retained
the parallel arm's facet planner and four-view candidate discovery, but removed
its verifier and minimal set-cover selector. The complete 24-session candidate
catalog was instead passed to the actual `hop-retrieve-v1` prompt for one
permissive `add_sessions` decision.

| Arm | Strict full gold | Candidate full gold | Hard | Mid | Easy | Mean bag | Cost | Wall time |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Opaque v1 H=6 control | 76/90 | 82/90 retrospective seen-hit union | 18/28 | 10/12 | 48/50 | 2.83 | $1.473 | 103.5s |
| Parallel Test 2 | 48/90 | 88/90 | 6/28 | 3/12 | 39/50 | 1.47 | $1.923 | 99.3s |
| **Parallel + v1 admission hybrid** | **79/90** | **89/90** | **20/28** | **11/12** | **48/50** | 2.42 | **$1.310** | **18.8s** |

Paired against the control, the hybrid won 6 cases, lost 3, and tied 81. Its
remaining 11 misses split into 1 discovery failure and 10 admission failures.
The bag contained 198 oracle entries out of 218 total entries (90.8%), so the
gain did not come from indiscriminate bag stuffing.

This is a promising adaptive result, not a final certification: the
architecture was chosen after inspecting failures on this development screen,
and facet planning is stochastic. It should be replicated on untouched cases
before replacing the control.

Hybrid artifact:
`runs/local-archive/backbone/hop-screen90-hybrid-v1.json`
