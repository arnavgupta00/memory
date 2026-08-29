# BEAM-1M retrieval advancement gate — 2026-08-08

## Locked decision

Do not run another downstream BEAM-1M architecture comparison or promote a
new retrieval design until the retriever preserves the **complete gold story
for at least 85% of questions**.

Retrieval-only development and recall measurement may continue. Expensive
extraction, final-answer, and official-judge runs remain blocked until this
gate passes.

## Locked work order

1. **Phase 1 — session retrieval only.** Improve the path from query planning
   and multi-retriever discovery through deterministic fusion into the final
   K=81 session reservoir. The only advancement target is at least 67/78
   complete gold stories.
2. **Phase 2 — context extraction/compression.** Only after Phase 1 passes,
   investigate why GPT-5.4 Nano-low claim extraction drops or weakens evidence
   relative to passing the raw sessions directly to Luna-high.
3. **Phase 3 — downstream scoring.** Re-run final answering and the official
   judge only after the retrieval and packaging gates have been settled.

During Phase 1, keep the downstream comparison frozen. Do not tune Nano claim
extraction, the Luna-high answerer, or the official judge, and do not use their
scores to choose retrieval variants.

## Metric contract

- **Population:** the frozen 78 focused, answerable questions from BEAM-1M
  Canary A.
- **Success for one question:** every oracle gold session for that question is
  present in the final retrieval output handed to the downstream pipeline.
- **Gate metric:** successful questions divided by all 78 questions. Partial
  session recall does not count as success.
- **Pass threshold:** at least **67/78 (85.90%)** complete-gold-story cases.
  The mathematically nearest lower count, 66/78, is only 84.62% and does not
  pass.
- **Current baseline:** **58/78 (74.36%)** after K=81 fusion. Passing therefore
  requires recovering at least nine additional complete stories without
  regressing the currently complete cases.

## Measurement-integrity alert — 2026-08-08

The 85% target remains locked, but the current 58/78 baseline is **provisional
and must not be used for tuning** until the evidence oracle is recertified.
Direct inspection found multiple official BEAM `source_chat_ids` that point to
messages unrelated to the evidence described by their probes. The local
adapter maps those IDs faithfully; the upstream IDs are incorrect.

This affects only the local gold-session preservation metric. The official
answer score remains valid because the official evaluator judges answer
content rather than this session mapping. See
`BEAM-1M-PHASE1-RETRIEVAL-DIAGNOSIS-2026-08-08.md` for verified examples and
the layer-by-layer diagnosis.

The 86.75% macro gold-session recall and 71.47% micro gold-session recall are
useful diagnostics, but neither is the advancement criterion. The gate is
strictly case-level complete-gold-story preservation.

## Frozen downstream reference

Both measured downstream arms started from the exact same K=81 retrieval
reservoir. The 71.47% figure belongs to that shared reservoir: it retained 238
of 333 individual gold sessions. It is not a context-packing or final-answer
score.

| Arm | Context handed to final answerer | Official 100-question score | Paired-control score |
|---|---|---:|---:|
| K=81 raw | All raw turns from the K=81 sessions | **74.10%** | **72.69%** |
| K=81 claims | GPT-5.4 Nano-low claims compressed from the K=81 sessions | 69.60% | 69.25% |

Raw packing preserved 100% of the K=81 sessions and represented 76.13 sessions
per question on average. Claim compression mapped the same reservoir but its
final package represented only 55.40 sessions on average. It reduced estimated
final context from 110,458 to 11,873 tokens per question, but lost 4.50
percentage points in the separate official reruns and 3.44 points in the
cleaner paired comparison.

GPT-5.6 Luna-high generated the answers in both arms; it did not assign these
scores. The pinned official BEAM evaluator used GPT-4.1-mini for judged
abilities and normalized Kendall tau for event ordering. The paired-control
score is preferred for arm-to-arm attribution because it holds the 22 unchanged
questions' earlier judge scores fixed, avoiding judge rerun variation.

## Integrity rules

- Keep the 78-question cohort and oracle definition frozen while comparing
  retrieval variants.
- Keep session identifiers opaque to models and never expose oracle metadata
  at runtime.
- Report both the numerator and denominator; do not describe macro recall,
  micro recall, or candidate discovery coverage as this gate.
- A variant below 67/78 is research-only, regardless of improvements in other
  retrieval metrics.
- Do not optimize or promote against the current oracle until every source ID
  in the frozen cohort has been checked against the source chat and all
  corrections have been versioned.

## Evidence source

The current measurement is recorded in
`runs/beam-1m-k81-downstream-20260806/layer-diagnostic.json`.
The downstream comparison is recorded in
`runs/beam-1m-k81-downstream-20260806/RESULTS.md`.
