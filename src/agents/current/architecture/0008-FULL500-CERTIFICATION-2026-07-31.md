# Architecture 0008 full-500 certification — 2026-07-31

## Result

Architecture 0008 scored **457/500 (91.40%)** on the complete LongMemEval-S
evaluation.

| Slice | Correct | Accuracy |
|---|---:|---:|
| All | **457/500** | **91.40%** |
| Answerable | 431/470 | 91.70% |
| Abstention | 26/30 | 86.67% |
| Knowledge update | 74/78 | 94.87% |
| Multi-session | 116/133 | 87.22% |
| Single-session assistant | 56/56 | 100.00% |
| Single-session preference | 27/30 | 90.00% |
| Single-session user | 68/70 | 97.14% |
| Temporal reasoning | 116/133 | 87.22% |

Task-averaged accuracy was 92.74%.

## Certified pipeline

> **Opaque parallel multi-view hybrid retrieval → GPT-5.4 Nano low Arm 3
> extraction → GPT-5.6 Luna high final answer**

| Stage | Model or mechanism |
|---|---|
| Session ingestion | `gpt-5.4-nano-2026-03-17`, USER turns only |
| Retrieval facet planning | `gpt-5.6-luna`, low reasoning |
| Candidate discovery | Local BM25 over notes, USER, ASSISTANT, and combined views |
| Candidate admission | `gpt-5.6-luna`, low reasoning |
| Session evidence extraction | `gpt-5.4-nano-2026-03-17`, low reasoning |
| Final answer | `gpt-5.6-luna`, high reasoning |
| Judge | `gpt-4o-2024-08-06`, temperature 0 |

The candidate pool is capped at 24 sessions. Admission receives opaque
`memory_###` handles and selects a complementary bag capped at 12 sessions.
Each selected session is independently mapped to exact raw turns before the
host constructs a balanced evidence package for the final answerer.

## Retrieval result

| Metric | Result |
|---|---:|
| Candidate-pool full gold | 494/500 (98.80%) |
| Selected-bag full gold | 471/500 (94.20%) |
| Mean candidate-pool gold recall | 99.43% |
| Mean selected-bag gold recall | 97.36% |
| Mean candidate-pool size | 23.89 |
| Mean selected-bag size | 2.09 |

The 43 wrong final answers divide into:

- 35 with every gold session already in the selected bag;
- 8 with one or more gold sessions absent from the selected bag.

This makes post-retrieval extraction and reasoning the dominant residual loss.
Multi-session and temporal-reasoning questions are the weakest categories at
87.22% each.

## Cost

The rounded end-to-end benchmark cost was approximately **$14.7–$15** for all
500 questions. This scope includes fresh session ingestion, retrieval,
per-session evidence extraction, final answering, and canonical judging.

The range is used because provider metering and generated-output length can
change the exact bill slightly. The figure excludes research experiments that
preceded selection of Architecture 0008. Session ingestion is a one-time,
reusable cost for later question runs over the same corpus.

## Certification controls

### Full-population evaluation

All 500 LongMemEval-S questions were included. The score is not an extrapolation
from the earlier 90- or 135-question development slices.

### Fresh model-dependent work

All 19,195 unique sessions were freshly annotated. The certification did not
read the previous answerable-135 annotation directory or reuse prior retrieval,
extraction, answer, or judge responses.

### Identity isolation

Raw dataset identifiers expose oracle membership through their naming pattern.
Architecture 0008 replaces them with deterministic opaque handles before any
model call.

The certification audited:

- 19,195 model-visible storer prompts;
- 500 retrieval prompt sets;
- 500 extraction/final-answer prompt sets.

No raw session identifier appeared in any audited model-visible prompt.

### Completeness and evaluator

- Storer: 19,195/19,195 sessions, zero unresolved failures
- Retrieval: 500/500 questions, zero unresolved failures
- Extraction and answer: 500/500 questions, zero unresolved failures
- Judge: 500/500 questions
- Evaluator: pinned canonical LongMemEval prompt with
  `gpt-4o-2024-08-06`, temperature 0

The evaluator source used for the run had SHA-256
`ecce9c4c79dc89d99534ac17b383a5cbb5b9f0c69ee98adaf0684742e3d95251`.

### Trace retention

The local certification bundle retains exact prompts, outputs, parsed
structures, request IDs, token usage, latency, retries, per-case retrieval
traces, context packages, predictions, judge calls, and SHA-256 checksums.
These paid-run artifacts remain outside Git; this document is their durable
tracked result record.

## Scope

This certification measures the complete Architecture 0008 benchmark pipeline.
It does not claim that the same accuracy transfers unchanged to unrelated
datasets or production traffic. Live-host integration remains a separate
engineering concern from the certified offline architecture.
