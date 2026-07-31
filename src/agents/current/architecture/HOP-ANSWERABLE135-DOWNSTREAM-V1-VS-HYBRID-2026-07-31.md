# Answerable135: opaque v1 vs parallel-discovery hybrid

Date: 2026-07-31

## Decision

The hybrid retriever is a real retrieval improvement, but the current
single-run end-to-end answer comparison is inconclusive because stochastic Arm
3 extraction and Nano answering erased the gain.

| Pipeline | Full-gold bag | Final answers | Hard | Mid | Easy |
|---|---:|---:|---:|---:|---:|
| Opaque v1 H=6 → Arm 3 → Nano | 120/135 | **117/135** | 18/28 | 8/12 | **91/95** |
| Opaque parallel + v1 hybrid → Arm 3 → Nano | **126/135** | 116/135 | **20/28** | 8/12 | 88/95 |
| Delta | **+6** | -1 | +2 | 0 | -3 |

The retrieval comparison is 9 paired hybrid wins, 3 losses, and 123 ties.
The final-answer comparison is 6 paired wins, 7 losses, and 122 ties.

## Retrieval result

| Metric | v1 | Hybrid |
|---|---:|---:|
| Full gold | 120/135 | **126/135** |
| Mean gold recall | 0.9551 | **0.9731** |
| Hard full gold | 17/28 | **22/28** |
| Mid full gold | 10/12 | 10/12 |
| Easy full gold | 93/95 | **94/95** |
| Mean bag size | 2.41 | **2.27** |
| Candidate-pool full gold | retrospective only | 133/135 |

The hybrid used opaque per-question handles, completed 135/135 cases with zero
errors, and had no raw-ID strings in model-visible traces.

## Final-answer result

Both cells used the same leak-free downstream protocol:

1. Opaque session hydration.
2. One `gpt-5.4-nano-2026-03-17` low-reasoning extraction per bag session.
3. Deterministic Arm 3 balanced package construction.
4. `answer-v8-preference` with Nano medium reasoning.
5. Pinned `gpt-4o-2024-08-06` canonical judging.

| Question type | N | v1 | Hybrid | Delta |
|---|---:|---:|---:|---:|
| knowledge-update | 20 | 20 | 18 | -2 |
| multi-session | 33 | 24 | 22 | -2 |
| single-session-assistant | 15 | 14 | 14 | 0 |
| single-session-preference | 15 | 12 | 13 | +1 |
| single-session-user | 17 | 17 | 16 | -1 |
| temporal-reasoning | 35 | 30 | 33 | +3 |

Retrieval-conditioned answers:

| Pipeline | Full-gold bags | Correct | Incomplete bags | Correct |
|---|---:|---:|---:|---:|
| v1 | 120 | 110 (91.7%) | 15 | 7 (46.7%) |
| Hybrid | 126 | 110 (87.3%) | 9 | 6 (66.7%) |

## Variance audit

The hybrid changed an incomplete v1 bag into a full-gold bag for nine
questions. Those questions improved from 3/9 correct with v1 to 8/9 with the
hybrid, a strong +5 translation from retrieval coverage to answers.

However, 90 questions had exactly the same complete session bag in both cells.
Despite identical retrieval input, the independently generated downstream
runs scored 83/90 for v1 and 78/90 for the hybrid: zero hybrid wins and five
losses. Those losses arose after retrieval, through stochastic per-session
extraction and/or Nano answering, and are sufficient to explain the observed
overall -1.

The earlier screen90 experiment scored 68/90 versus 77/90. In the later
answerable135 rerun, the same screen90 IDs scored 75/90 versus 75/90. Therefore
the initial +9 downstream gain did not replicate.

The proper conclusion is:

- Ship the hybrid forward as the stronger retrieval candidate.
- Do not claim an end-to-end accuracy improvement yet.
- A clean causal downstream comparison must reuse identical extraction outputs
  for shared question-session pairs and use repeated or otherwise variance-
  controlled final answer calls.

## Cost and time

Canonical judge cost is excluded because both cells made 135 judge calls.

| Query-time component | v1 | Hybrid | Delta |
|---|---:|---:|---:|
| Retrieval cost | $2.124 | $1.915 | -$0.209 |
| Downstream cost | $0.557 | $0.551 | -$0.006 |
| **Total inference cost** | **$2.681** | **$2.466** | **-$0.215 (-8.0%)** |
| Retrieval wall time | 156.3s | 67.5s | -88.8s |
| Downstream wall time | 319s | 318s | -1s |
| **Approx. serial wall time** | **475.3s** | **385.5s** | **-89.8s (-18.9%)** |

The hybrid downstream used 442 calls and 1,856,544 Nano tokens, versus 461
calls and 1,894,551 tokens for v1.

## Artifacts

- v1 retrieval:
  `runs/local-archive/backbone/hop-gate-luna-h6-v1-answerable135-opaque.json`
- hybrid retrieval:
  `runs/local-archive/backbone/hop-answerable135-hybrid-v1-opaque.json`
- v1 full pipeline:
  `runs/hop-answerable135-opaque-v1-arm3-20260731-3`
- hybrid full pipeline:
  `runs/hop-answerable135-opaque-hybrid-arm3-20260731-3`

## Frozen-package final answer replay: GPT-5.6 Luna high

The hybrid retrieval bags and Arm 3 context packages were frozen. Only the
final `answer-v8-preference` call changed from GPT-5.4 Nano medium to GPT-5.6
Luna high.

| Final answerer | Correct | Accuracy | Hard | Mid | Easy |
|---|---:|---:|---:|---:|---:|
| GPT-5.4 Nano medium | 116/135 | 85.93% | 20/28 | 8/12 | 88/95 |
| **GPT-5.6 Luna high** | **123/135** | **91.11%** | **21/28** | **11/12** | **91/95** |
| Delta | **+7** | **+5.19 pp** | +1 | +3 | +3 |

The paired comparison was 10 Luna wins, 3 losses, and 122 ties. Luna improved
both the original screen90 subset (75/90 to 79/90) and the remaining 45 easy
questions (41/45 to 44/45).

Retrieval-conditioned Luna-high accuracy was 116/126 (92.06%) on full-gold
bags and 7/9 (77.78%) on incomplete bags. This is direct evidence that the
final answer call was a material weak link after retrieval and Arm 3 package
construction.

The answer replay completed 135/135 calls in 47 seconds at concurrency 128,
used 610,658 input and 101,179 output tokens, and averaged 8.17 seconds of
provider latency per answer. Using the same run-date Luna prices as retrieval
($1/M input, $6/M output), the answer stage is estimated at $1.218, versus
$0.228 for Nano. The complete hybrid query-time stack is therefore estimated
at $3.455 before canonical judging.

Replay artifact:
`runs/hop-answerable135-opaque-hybrid-arm3-luna-20260731-high`

## Arm 3 extraction replay: GPT-5.6 Luna high

To isolate whether Nano-low session extraction was the remaining weak link,
the same frozen hybrid bags were rerun with Luna-high for every Arm 3
per-session extraction and Luna-high for the final answer. Package construction,
limits, opaque IDs, prompts, and judging remained unchanged.

| Extractor | Final answerer | Correct | Accuracy | Hard | Mid | Easy |
|---|---|---:|---:|---:|---:|---:|
| **Nano low** | **Luna high** | **123/135** | **91.11%** | 21/28 | **11/12** | **91/95** |
| Luna high | Luna high | 123/135 | 91.11% | **24/28** | 9/12 | 90/95 |

The paired result was exactly balanced: 6 Luna-extractor wins, 6 losses, and
123 ties. The screen90 subset improved by three, while the remaining 45
regressed by three. Luna extraction shifted errors rather than reducing them.

Cost changed materially:

- Nano-low extraction: approximately $0.323.
- Luna-high extraction: $1.928, about 5.97× higher.
- Nano extraction + Luna answer downstream: approximately $1.541.
- Luna extraction + Luna answer downstream: $3.075, about 2× higher.
- Complete pipeline including hybrid retrieval: approximately $3.455 versus
  $4.990.

Decision: keep Nano-low for Arm 3 extraction and Luna-high for the final
answer. This test provides no aggregate evidence that the stronger extractor
improves accuracy.

Luna-extraction artifact:
`runs/hop-answerable135-opaque-hybrid-arm3-lunahigh-20260731-3`
