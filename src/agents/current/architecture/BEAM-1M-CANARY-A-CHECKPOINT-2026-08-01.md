# BEAM-1M Canary A checkpoint — 2026-08-01

## Decision

Keep Architecture 0008 as the shared LongMemEval/BEAM pipeline. For BEAM questions
that explicitly request a timeline, chronological order, or events "in order", use
the question-only wide-history retrieval profile. Keep summarization and all other
questions on the focused profile.

The defensible controlled Canary A score for the selected routing is **64.69%**.
The fully rejudged exploratory run scored **65.55%**, but it also widened
summarization (which regressed) and rejudged unchanged answers (which exhibited
judge drift). It is evidence, not the selected score.

## Canary A results

| Measurement | Score |
|---|---:|
| Frozen Architecture 0008 baseline | 62.92% |
| Exploratory event + summarization wide run, full rejudge | 65.55% |
| Selected event-only wide route, controlled macro | **64.69%** |

The selected route raises event ordering from **34.02% to 51.70%** in the original
official runs. A contemporaneous event-only rejudge measured **35.02% to 51.70%**;
the conclusion is unchanged.

## Selected BEAM routing

- Router input: question text only; no ability label, oracle, or gold metadata.
- Broad trigger: explicit timeline/chronological/"in order" requests.
- Broad discovery: four local BM25 views, top 50 per query, fused pool up to 192.
- Broad admission: retain the discovered pool for independent Nano-low reading;
  do not force it through the focused maximum-12 admission bag.
- Reduction: discard per-session reads with no claims, then build the unchanged
  deterministic 40-turn/40,000-character package.
- Final answer: GPT-5.6 Luna, high reasoning.
- Focused route remains unchanged for every other question.

The router selects 10/10 Canary A event-ordering questions, 0/10 summarization,
0/80 other BEAM questions, and 0/500 LongMemEval questions.

## Architecture 0005.4 rejection gate

The preserved Architecture 0005.4 workflow was run on the same ten event-ordering
questions: BM25 top-48, Nano-low selector, full-session package, Nano-medium answer.

| Arm | Contemporaneous official event score |
|---|---:|
| Architecture 0008 focused baseline | 35.02% |
| Selected wide event route | **51.70%** |
| Architecture 0005.4 | 26.33% |

Architecture 0005.4 retrieved only **8.75%** of gold sessions on average and had
zero full-gold cases. Its context package retained the same mean gold recall and
never reached the 40-turn cap, so candidate discovery—not package capacity—was the
primary failure. It cost approximately **$0.079** and completed in **25.4 seconds**.

## Evaluation integrity

Official results use the pinned BEAM source commit
`3e12035532eb85768f1a7cd779832b650c4b2ef9`, `gpt-4.1-mini`, and temperature 0.
Event ordering is reported by the upstream `tau_norm` convention. Because its
semantic alignment is LLM-assisted, all three event arms were also rescored
contemporaneously.

The upstream client stalled indefinitely in SSL reads. The harness now supports an
event-ordering-only mode and an optional transport timeout/retry installed solely
in the ephemeral evaluator copy. Model, prompts, rubrics, alignment, and scoring
logic remain pinned and unchanged.

## Validation

- TypeScript: 17 files, 75 tests passed.
- Python BEAM harness: 6 tests passed.
- Typecheck and targeted lint passed.
- Architecture 0005.4 gate: 10/10 completed, zero failures.
