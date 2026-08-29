# BEAM-1M Phase-1 retrieval diagnosis — 2026-08-08

## Decision summary

There are two separate problems, and they must not be confused:

1. **The local retrieval oracle is not yet trustworthy.** Several official
   BEAM `source_chat_ids` name messages that do not contain the evidence
   described by the probe. The adapter maps those IDs correctly, but the IDs
   themselves are wrong. Therefore the current **58/78 (74.36%)** complete
   story score is provisional. The official answer-quality score is unaffected
   because the official judge grades the answer, not our local session oracle.
2. **A real retrieval failure remains visible even with that caveat.** The
   system is good at finding the central topic, but broad-history questions
   require every side event in a story. Rare one-off evidence receives weak
   retrieval support and is then disproportionately removed by K=81 fusion.

The correct next action is to recertify the 78-question evidence oracle, then
recompute this same funnel. Optimizing against the current labels risks
teaching the retriever to select irrelevant sessions.

## What the first part actually does

For each question, Phase 1 performs four operations:

1. The planner creates many lexical and semantic queries, including initial
   queries and follow-up queries.
2. BM25 and Voyage execute those queries over the session index. Their hits
   are combined into a large discovery union.
3. Deterministic fusion gives repeated, high-ranking, cross-retriever matches
   more support and applies diversity pressure.
4. The fusion stage keeps at most 81 sessions as the context reservoir.

In plain language, this is like asking two librarians roughly 50 variations of
the same question. They return about 196 books. A mechanical sorter then keeps
about 76. The failure is not usually that the main book is absent; it is that
one obscure but required chapter is either never suggested or looks too weak
to survive the sorter.

## Observed funnel on the frozen 78-case cohort

These figures use the current, unreconciled oracle and therefore diagnose
system behavior but must not be treated as a certified benchmark.

| Layer | Gold sessions retained | Session recall | Complete stories | Mean sessions/question |
|---|---:|---:|---:|---:|
| Oracle requirement | 333/333 | 100.00% | 78/78 | 4.27 gold |
| BM25 + Voyage discovery union | 304/333 | 91.29% | 66/78 (84.62%) | 195.58 candidates |
| K=81 fused reservoir | 238/333 | 71.47% | 58/78 (74.36%) | 76.13 selected |
| Raw-turn packaging | 238/333 | 71.47% | 58/78 (74.36%) | 76.13 represented |

The loss has two parts:

- **29 gold labels are never discovered.** No later selector can recover them.
- **66 discovered gold labels are removed by fusion.** Fusion retains 238 of
  the 304 discovered labels, or 78.29%.

K=81 is not intrinsically too small: the largest current oracle story needs 30
sessions. All required evidence can fit. The problem is distinguishing the
right sessions from hundreds of plausible ones.

## Where the missing story is concentrated

| Ability | Gold | Discovered | K=81 | Full after discovery | Full after K=81 | Never found | Dropped by K=81 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Information extraction | 12 | 12 | 12 | 10/10 | 10/10 | 0 | 0 |
| Temporal reasoning | 21 | 21 | 21 | 10/10 | 10/10 | 0 | 0 |
| Contradiction resolution | 30 | 29 | 28 | 9/10 | 8/10 | 1 | 1 |
| Instruction following | 11 | 11 | 9 | 10/10 | 8/10 | 0 | 2 |
| Knowledge update | 29 | 28 | 28 | 9/10 | 9/10 | 1 | 0 |
| Preference following | 23 | 22 | 22 | 8/9 | 8/9 | 1 | 0 |
| Multi-session reasoning | 52 | 49 | 40 | 7/10 | 5/10 | 3 | 9 |
| Summarization | 155 | 132 | 78 | 3/9 | 0/9 | 23 | 54 |

Summarization plus multi-session reasoning account for:

- 26 of 29 discovery misses (89.66%);
- 63 of 66 fusion removals (95.45%); and
- 14 of the 20 currently incomplete cases (70%).

This is the core shape of the problem. Point lookup works. Broad story
reconstruction does not.

## Why discovery does not produce a complete story

### 1. The planner can describe the answer shape, but not unknown story vocabulary

For a direct question, the question itself contains enough anchors: an entity,
date, value, event, or preference. BM25 and Voyage can find the relevant
session.

A broad question such as “summarize the progress” does not name every project,
side task, setback, or one-off decision that belongs in the answer. The planner
can generate generic terms such as `progress`, `roadmap`, `implemented`, and
`latest`, but it cannot know the hidden names of all workstreams before seeing
them. It repeatedly retrieves the center of the story rather than expanding
its boundary.

### 2. More queries mostly repeat the same evidence

The system averaged 50.21 query executions per question. Summarization used
about 73.6 queries and produced about 388 candidates per question, yet reached
0/9 complete stories after K=81. Temporal reasoning used fewer queries and
reached 10/10.

This means query count is not the bottleneck. Many queries are correlated:
they use similar concepts and reward the same central sessions. Follow-up is
also not behaving as a true exploration step. Only one discovered gold label
was follow-up-only, and no selected gold label was follow-up-only. Follow-up
mostly reinforces evidence already seen.

### 3. The raw pool is extremely noisy

The discovery union contains 15,255 session appearances across 78 questions:

- 304 are current gold labels;
- 14,951 are non-gold labels;
- the measured gold rate is 1.99%, about one gold label per 49 non-gold labels.

Some non-gold sessions can still be useful context, so “junk” here only means
“not named by the current oracle.” Even so, the sorter faces a severe ranking
problem: most candidates are topically plausible, while a required side event
may have appeared in only one weak result list.

## Why fusion removes required sessions

Fusion is not dropping gold at random. It is selecting candidates that look
strong under its available signals.

| Candidate group | Count | Mean query hits | Median query hits | Mean best rank | Found by both BM25 and Voyage |
|---|---:|---:|---:|---:|---:|
| Selected gold | 238 | 25.30 | 22 | 2.18 | 234 |
| Dropped gold | 66 | 3.00 | 2 | 9.67 | 28 |
| Selected non-gold | 5,700 | 11.03 | 8 | 7.00 | 3,531 |
| Dropped non-gold | 9,251 | 2.06 | 1 | 11.93 | — |

The selected gold sessions are repeatedly returned, rank near the top, and
almost always have agreement between BM25 and Voyage. The dropped gold
sessions look much more like weak candidates: few appearances, low ranks, and
often support from only one retriever.

That creates a mismatch between the ranking objective and the task objective:

- **Fusion rewards confidence:** repeated support, agreement, and textual
  diversity.
- **Complete-story retrieval rewards coverage:** retaining even a weak,
  one-time mention if it is the only evidence for a necessary story facet.

MMR-style textual diversity cannot tell whether two differently worded
sessions cover the same central milestone or whether a low-scoring session is
the only evidence for a missing side branch. There is no explicit story ledger
tracking which workstreams, events, updates, contradictions, or time periods
remain uncovered.

Chronology is not the main aggregate explanation: selected and dropped gold
sessions have essentially the same mean normalized timeline position (0.313).
The discriminating signal is strength and repetition, not age.

## Why full-story accuracy falls faster than session recall

Full-story scoring is an all-or-nothing product of many retrieval decisions.
A point question may need one or two sessions. A summarization case currently
requires 7–30. Missing one session fails the entire case even if the other 29
are present.

Among the 20 incomplete K=81 cases:

- 8 miss one gold label;
- 3 miss two;
- the remaining 9 miss between 3 and 22.

Recovering all eight one-miss cases would still be insufficient to move from
58 to the locked 67-case gate. At least one harder multi-miss case would also
have to become complete—after the oracle has been corrected.

## Measurement-integrity failure

The BEAM adapter is doing what it was written to do: it maps each official
`source_chat_id` to the session containing that exact message. The defect is in
some upstream probe annotations.

Verified examples include:

| Probe | Annotation says | Source inspection shows | Effect on local retrieval metric |
|---|---|---|---|
| Chat 3, contradiction resolution 1 | Message 166 contains the 88%-coverage claim | Message 166 is a `KeyError` debugging request; the coverage claim occurs at 164/262 | K=81 selected the actual evidence but is counted incomplete |
| Chat 3, knowledge update 2 | Message 324 contains the prior 50 epochs / 0.032 result | Message 324 discusses pytest coverage; the described result occurs at 322 | K=81 selected the actual prior and updated evidence but is counted incomplete |
| Chat 8, preference following 2 | Messages 1258/1260 contain an algebraic-manipulation preference | Those messages discuss CRT; the explicit preference occurs at 1410 | The measured target session is unrelated; the actual preference is missed |
| Chat 8, contradiction resolution 2 | Message 572 is the earlier “solved” statement | Message 572 is a Legendre-symbol discussion; relevant solved statements occur elsewhere | One target session is incorrectly identified |

This also explains an apparent contradiction in downstream behavior: 8 of the
20 “oracle-incomplete” K=81 cases still received perfect answers. Some may be
answerable from redundant evidence, but at least two verified cases contain
the real evidence while missing only an incorrectly labelled session.

The official 74.10% raw-context answer score remains valid because the official
evaluator judges the answer against rubrics and ideal answers. It does not use
this local gold-session mapping. What is invalidated is the present 58/78
retrieval gate baseline and any tuning decision made against it.

## Reproducibility limitation

The preserved K=81 artifact identifies its selector as `mmr_085` and points to
`/tmp/fusion-v2-deterministic-OMRMI5/results.json`. That temporary report no
longer exists, and no persisted implementation of the exact selector was found
in the repository. The input/output behavior can be audited from preserved
bags and search traces, but the exact scoring formula cannot currently be
reviewed line by line.

This should be fixed before selector tuning so a candidate change can be
compared against a reproducible baseline.

## What is known, inferred, and still unknown

### Known from traces

- Direct information extraction and temporal cases are retrieval-complete.
- Broad summarization and multi-session cases dominate both discovery and
  fusion loss.
- Fusion favors repeated, high-ranked, cross-retriever candidates.
- Dropped gold labels have far weaker observable support than selected gold.
- Raw-turn packaging introduces no additional session loss.
- Current oracle labels contain verified errors.

### Strong inference

- Query variants repeatedly rediscover central themes instead of exposing new
  story branches.
- Confidence-oriented fusion is structurally misaligned with rare-evidence
  preservation.
- A single retrieval policy is being asked to solve two different regimes:
  point lookup and broad story reconstruction.

### Not yet knowable

- The certified complete-story baseline after correcting all 78 cases.
- How many of the 95 measured missing labels are genuine retrieval misses.
- Whether the exact fusion formula or query planning is the larger remaining
  contributor after oracle correction.

## Required next step before solution design

1. Recertify every source ID used by the frozen 78 cases against the actual chat
   text and create a corrected, versioned evidence oracle without changing
   questions or answers.
2. Recompute discovery and K=81 full-story metrics with both the original and
   corrected oracle, reporting every changed label.
3. Persist the exact fusion implementation and its scores.
4. Keep the 85% complete-story target, but apply it to the corrected oracle.
5. Only then design retrieval changes, concentrating them on broad-history
   coverage while protecting the abilities that are already complete.

## Evidence

- `runs/beam-1m-k81-downstream-20260806/layer-diagnostic.json`
- `runs/beam-1m-k81-downstream-20260806/retrieval/k81-mmr085-focused-answerable78.json`
- `runs/beam-1m-recall-gate-0008.4-20260802/full-balanced.json`
- `runs/beam-1m-recall-gate-0008.4-20260802/full-balanced-retry7.json`
- `runs/beam-1m-canary-a-architecture-0008-20260731-r2/input/oracle.json`
- `runs/local-archive/beam-1m-canary-a-source/chats/1M/*/probing_questions/probing_questions.json`
- `src/agents/current/src/benchmarks/beam1m.ts`
