# Architecture 0006 — session routing

**Status:** measured — does not beat 0005.4  
**Prior:** [0005.4 checkpoint](0005.4-CHECKPOINT-2026-07-27.md) canary-1 **124/150 (82.7%)**
**Checkpoint:** [0006-CHECKPOINT-2026-07-28.md](0006-CHECKPOINT-2026-07-28.md)

## Decision

Give Call 1 visibility over the full haystack (~48 sessions) instead of the ~30% BM25
reaches, without write-time model calls and without putting summaries into the evidence
path.

1. **Deterministic session index** (`sessionIndex.ts`): per session — id, date, ~160-char
   opener, top tf-idf terms within the case haystack. Router only; not evidence.
2. **Series sibling expansion** (`seriesExpand.ts`): when BM25 hits `answer_foo_1`, also
   pull `answer_foo_2` / `answer_foo_3` as full-session spans. Offline gate on the 13
   0005.3 retrieval-gap cases: **8/8** missed gold sessions recoverable this way.
3. **`expandSessions` second pass** (`select-v5`): Call 1 may name up to
   `session_expand_max` sessions from the index that are missing from the bundle; one
   bounded re-select after those sessions are pulled raw.

Role contract unchanged: Call 1 recalls evidence; Call 2 reasons. Raw turns remain the
only evidence.

## Offline gate

`pnpm gate:session-routing` on 0005.3 canary-1 artifacts (13 retrieval-gap focus):

- Pure lexical opener/term overlap: 0/8 recovery (openers often off-topic)
- With series-neighbor expansion from bundle + scored index: **8/8 (100%)**

## Config

`configs/architecture-0006-canary2-session-routing.yaml` /
`configs/architecture-0006-canary1-session-routing.yaml`

- `select_prompt: select-v5`
- `session_index_enabled: true`, `session_expand_max: 8`
- `series_expand_enabled: true`, `series_expand_max: 16`
- `package_full_session_enabled: true` (keeps 0005.4)
- `answer_prompt: answer-v6-package` (keeps Stage 2)

## Deferred

LLM-generated session summaries at ingest: 93% of haystack sessions are unique per
question in LongMemEval-S, so write-time work does not amortize (~6× canary-1 cost) and
0003.2 already showed write-time extraction does not beat raw BM25.

## Live measurement

| Slice | Accuracy | Abstention | vs best prior |
|---|---:|---:|---|
| canary-2 | 50/60 | 9/10 | −4 vs 0005.3 freeze |
| canary-1 | 122/150 (81.3%) | 14/15 | −2 vs 0005.4 |

Series expand recovered missing sibling sessions offline, but live packages added enough
noise that Call 1/2 accuracy did not improve. Best canary-1 remains **0005.4**.
