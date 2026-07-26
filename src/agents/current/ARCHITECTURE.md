# Current architecture

**Architecture ID:** `0004-session-retrieval-backbone` (revision **0004.1**)
**Status:** frozen — `dev-60-v1` with evidenceTable + medium reasoning **54/60 (90.0%)** · [checkpoint](architecture/0004.1-CHECKPOINT-2026-07-26.md)

Prior canary-2 freeze (simple prompt, reasoning off): **35/60 (58.3%)** · [0004 checkpoint](architecture/0004-CHECKPOINT-2026-07-26.md). The 90% figure is a contaminated development reading, not a canary result.

The smallest system that can answer a LongMemEval question at all. It exists to produce an honest
number that every later layer must beat.

## Decision

Raw sessions are the memory. Nothing is rewritten, summarized, or extracted at write time, so
nothing can be lost at write time. All intelligence happens at question time, where the question is
available to guide it.

```text
ingest(session)   → append verbatim to the case store        (zero model calls)
answer(question)  → BM25 over turn windows
                  → top-K windows into one prompt
                  → answer with explicit abstention          (one model call)
```

For `N` sessions the agent makes exactly **one** model call per question and **zero** during
ingestion, against `floor(N/B) + floor(N/C) + 2` in Architecture 0003.2.

## Why this shape

Architecture 0003.2's own blind diagnostics justify it. Deterministic BM25 located the reference
session in 17 of 18 blind cases while the constructed graph missed references BM25 found, and six of
seven answerable losses occurred after retrieval had already succeeded. Recall was not the
bottleneck; everything built to repair recall was paying for a problem that raw sessions plus a
lexical index already solved.

The cost consequence is the point. Architecture 0003.2 cost about $0.039 per case and roughly 22
model calls; the full-context baseline cost $0.0058 per case. A retrieval-limited single call should
sit below that, which puts the full 500-case benchmark within the price of one previous 18-case
gate. Cheap runs are what make honest measurement possible.

## Retrieval

Each session is indexed as overlapping role-tagged turn windows rather than as one document, so the
unit retrieved is already the unit the answerer needs. Every window carries its session ID, session
date, and turn index range; dates travel with the text because temporal questions depend on them.

Ranking is BM25 with `k1=1.2`, `b=0.75`, Unicode tokenization, and stable tie-breaking. Selected
windows are coalesced when adjacent, ordered chronologically in the prompt, and truncated only at
window boundaries.

There are no embeddings, no vector store, no reranker call, no query-planner call, and no write-time
model calls.

## Answering

One call receives the question, the question date, and the selected windows. It returns a structured
result carrying the answer, a support status, and the window references it used. Abstention is an
explicit supported outcome, not a fallback.

The frozen default prompt is `prompts/answer-v2-evidence.yaml` (`options.answer_prompt` defaults to
`answer-v2-evidence`). It keeps the simple-prompt abstention rules and adds a required
`evidenceTable` of dated memory facts before the hypothesis, so selection vs composition failures
are observable in one call. Recommended answer settings: `reasoning_effort: medium`,
`max_output_tokens: 16000` on `gpt-5.4-nano-2026-03-17`.

On `dev-60-v1` the ladder was: simple/none **56.7%** → simple/medium **88.3%** → evidence/medium
**90.0%**. On canary-2 the earlier simple/none configuration scored **35/60**. Canonical
development config: `configs/architecture-0004-dev60-evidence.yaml`. Canary confirmation config
(not yet run): `configs/architecture-0004-canary2-evidence-medium.yaml`.

## Measurement discipline

Two metrics, deliberately separated:

- **Retrieval recall@K**, computed offline against reference session IDs with no model call and no
  judge. This is the fast inner loop and it is free.
- **End-to-end accuracy**, via the pinned canonical judge.

At 18 cases a single answer is worth 5.6 points and the standard error near 65% is about 11 points,
which is why Architecture 0003.2's 14/18 and 11/18 were indistinguishable. No architectural decision
is made below roughly 100 cases.

`dev-9-v1` and `dev-60-v1` are development sets drawn from the unused pool and disjoint from both
canaries. They are contaminated by design and are never reported as blind results.

## The ladder

Each rung is a hypothesis that must earn its place with a measured delta:

1. this backbone, scored honestly;
2. retrieval quality — chunk sizing, hybrid lexical/dense, query decomposition, temporal filters,
   measured by recall@K alone;
3. answer quality — prompt shape, context ordering, stronger models, at fixed retrieval;
4. a reading or selection layer, only once the answerer is demonstrably drowning in context;
5. write-time structure such as summaries, extracted facts, or a graph, only against a question
   class retrieval provably cannot serve. Knowledge-update recency and multi-session aggregation are
   the honest candidates: they scored 1/3 and 1/3 in the last blind run.

Structure is not forbidden. It has to win an argument against a measured baseline instead of being
the starting assumption.

## Preserved work

Architecture 0003.2 remains runnable at
[`../architecture-0003.2-hybrid-graph-reader/`](../architecture-0003.2-hybrid-graph-reader/) and is
tagged in git as `architecture-0003.2-hybrid-graph-reader`. Architecture 0001 remains runnable under
[`../baselines/full_context/`](../baselines/full_context/). Architecture 0002 is archived under
[`../../../legacy/python-architecture-0002/`](../../../legacy/python-architecture-0002/).
