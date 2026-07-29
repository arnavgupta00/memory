# Session annotations (v1) — documentation dump

Generated: 2026-07-29 20:42 UTC

This folder is a human-readable export of every index-time annotation produced for
the BM25 ranking upgrade (Phase 2 document expansion).

Machine-readable source of truth remains:

- Per session: `../<session_id>.json`
- Combined index: [`../_index.json`](../_index.json)

## Methodology

**What this is:** index-time **document expansion** for BM25 — not an ontology,
taxonomy, graph, or semantic layer.

**Shared contract (storer ↔ retriever):** both sides use natural-language English
terms. The storer writes words a future question might use; the retriever still
runs plain BM25 over session text with those terms appended. No controlled
vocabulary mapping.

**Storer model:** `gpt-5.4-nano-2026-03-17`  
**Prompt:** `session-annotate-v1` (`src/agents/current/prompts/session-annotate-v1.yaml`)  
**Input:** user turns only (assistant replies omitted)  
**Unit of annotation:** one chat session (one LLM call per unique session)

Each session yields three lists:

| Field | Role |
|---|---|
| `facts` | Exhaustive enumerated personal facts (not summaries), each tagged with `turn_index` |
| `keyphrases` | Short noun phrases a user might type in a question |
| `events` | Dateable event mentions with `date_hint` + `turn_index` (for optional time filtering) |

Facts are meant to be **appended into BM25 text** (key merging), either session-wide
or turn-anchored to windows containing `turn_index`.

## Corpus stats

| Metric | Value |
|---|---:|
| Unique sessions annotated | 6,070 |
| Total facts | 64,445 |
| Total keyphrases | 72,849 |
| Total events | 10,852 |
| Empty sessions (no fields) | 20 |
| Mean facts / session | 10.6 |
| Mean keyphrases / session | 12.0 |
| Mean events / session | 1.8 |
| Median facts / session | 11 |
| Median keyphrases / session | 12 |
| Median events / session | 1 |

## Schema (per session)

```json
{
  "session_id": "…",
  "prompt": "session-annotate-v1",
  "facts": [
    { "text": "I have a 2015 Honda Civic.", "turn_index": 0 }
  ],
  "keyphrases": ["2015 Honda Civic", "car upgrade"],
  "events": [
    { "text": "Birthday coming up", "date_hint": "April 10th", "turn_index": 6 }
  ]
}
```

## Offline gate outcome (context)

On canary-1 answerable (n=135), stacking these expansions on Phase-1 BM25
improved secondary metrics (mean gold rank, NDCG) but **did not move** primary
case-level top-5 coverage beyond Phase 1 alone (79.3%). Annotations are retained
for analysis and future experiments. See
[`../../BM25-RANKING-UPGRADE-RESULTS.md`](../../BM25-RANKING-UPGRADE-RESULTS.md).

## File index

Sessions are sorted by `session_id` and split into parts of up to 400 sessions.

| File | Sessions | Range |
|---|---:|---|
| [annotations-part-01-of-16.md](annotations-part-01-of-16.md) | 400 | `0018b628` … `24f78a31_2` |
| [annotations-part-02-of-16.md](annotations-part-02-of-16.md) | 400 | `25156294` … `48d385f0_1` |
| [annotations-part-03-of-16.md](annotations-part-03-of-16.md) | 400 | `48f804a3` … `6e0b32d1_1` |
| [annotations-part-04-of-16.md](annotations-part-04-of-16.md) | 400 | `6e2cca63_1` … `96c743d0_abs_1` |
| [annotations-part-05-of-16.md](annotations-part-05-of-16.md) | 400 | `96da07f9_1` … `answer_991d55e5_1` |
| [annotations-part-06-of-16.md](annotations-part-06-of-16.md) | 400 | `answer_991d55e5_2` … `cae09ac0_1` |
| [annotations-part-07-of-16.md](annotations-part-07-of-16.md) | 400 | `cae65795_1` … `f1bdf7f3_3` |
| [annotations-part-08-of-16.md](annotations-part-08-of-16.md) | 400 | `f1bdf7f3_4` … `sharegpt_9UDeCis_0` |
| [annotations-part-09-of-16.md](annotations-part-09-of-16.md) | 400 | `sharegpt_9Va3BiZ_0` … `sharegpt_OYJrGdy_75` |
| [annotations-part-10-of-16.md](annotations-part-10-of-16.md) | 400 | `sharegpt_OYMr8YY_0` … `sharegpt_ezogapI_0` |
| [annotations-part-11-of-16.md](annotations-part-11-of-16.md) | 400 | `sharegpt_f18bljY_0` … `sharegpt_uj4i7AM_0` |
| [annotations-part-12-of-16.md](annotations-part-12-of-16.md) | 400 | `sharegpt_upcsBm3_0` … `ultrachat_186470` |
| [annotations-part-13-of-16.md](annotations-part-13-of-16.md) | 400 | `ultrachat_186481` … `ultrachat_325372` |
| [annotations-part-14-of-16.md](annotations-part-14-of-16.md) | 400 | `ultrachat_326427` … `ultrachat_458202` |
| [annotations-part-15-of-16.md](annotations-part-15-of-16.md) | 400 | `ultrachat_458757` … `ultrachat_74296` |
| [annotations-part-16-of-16.md](annotations-part-16-of-16.md) | 70 | `ultrachat_74640` … `ultrachat_9855` |

## How to regenerate

```bash
# Re-annotate (disk cache; only missing sessions call the model)
pnpm --dir src/agents/current exec node --import tsx \
  src/scripts/sessionAnnotate.ts \
  --slice answerable \
  --cache runs/local-archive/backbone/session-annotations-v1 \
  --concurrency 24

# Rebuild this markdown dump
python3 src/agents/current/src/scripts/exportAnnotationsDocs.py
```
