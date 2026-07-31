# Screen90 full-pipeline comparison: v1 vs parallel-discovery hybrid

Date: 2026-07-31

> Replication update: the later answerable135 run included these same 90
> questions and reran both downstream cells. On that repeat, the screen90
> subset scored 75/90 for v1 and 75/90 for the hybrid. The +9 result below did
> not replicate because independent Arm 3 extraction and answer calls have
> substantial case-level variance. Treat this document as the first observed
> run, not a stable accuracy estimate.

## Result

On the same 90-question stress screen, replacing the sequential v1 retriever
with parallel multi-view discovery plus v1 admission improved canonical
end-to-end answer accuracy from 68/90 to 77/90.

| Pipeline | Retriever full gold | Final answers | Hard | Mid | Easy |
|---|---:|---:|---:|---:|---:|
| Opaque v1 H=6 → Arm 3 → Nano | 76/90 | 68/90 | 15/28 | 6/12 | 47/50 |
| **Opaque parallel + v1 hybrid → Arm 3 → Nano** | **79/90** | **77/90** | **20/28** | **8/12** | **49/50** |
| Delta | +3 | **+9** | +5 | +2 | +2 |

Paired final-answer outcomes were 12 hybrid wins, 3 hybrid losses, and 75
ties.

## Fixed downstream protocol

Both retrievers used exactly the same downstream stack:

1. Hydrate every session in the frozen retriever bag.
2. Remap raw dataset session IDs to deterministic per-question `memory_*`
   handles before any model call.
3. Run one `gpt-5.4-nano-2026-03-17` low-reasoning extraction per session.
4. Build the deterministic Arm 3 balanced context package, capped at 40 turns
   and 40,000 characters.
5. Answer with `answer-v8-preference` using the same Nano model at medium
   reasoning.
6. Score with the pinned canonical `gpt-4o-2024-08-06` judge.

There were 90/90 completed cases and zero failures in each cell. No raw
`answer_*` IDs occurred in any downstream context package or intermediate
model-facing artifact.

## Per-question type

| Type | N | v1 | Hybrid | Delta |
|---|---:|---:|---:|---:|
| knowledge-update | 11 | 10 | 11 | +1 |
| multi-session | 26 | 15 | 17 | +2 |
| single-session-assistant | 8 | 8 | 8 | 0 |
| single-session-preference | 11 | 7 | 10 | +3 |
| single-session-user | 9 | 8 | 8 | 0 |
| temporal-reasoning | 25 | 20 | 23 | +3 |

## Retrieval-conditioned answer accuracy

| Pipeline | Full-gold bags | Correct | Incomplete bags | Correct |
|---|---:|---:|---:|---:|
| v1 | 76 | 62 (81.6%) | 14 | 6 (42.9%) |
| Hybrid | 79 | 72 (91.1%) | 11 | 5 (45.5%) |

Five of the hybrid's answer wins coincided with an incomplete v1 bag becoming
full-gold. One additional win improved incomplete-bag recall without reaching
full gold. Other flips occurred when both bags had full gold but differed in
composition, extraction, or stochastic Nano output.

The answer delta is larger than the +3 full-gold delta because the hybrid also
produced smaller, cleaner bags: mean bag size 2.42 instead of 2.83, with a
90.8% rather than 76.1% oracle share. This reduces irrelevant per-session
extraction and answer-context distraction. A repeated or untouched-slice run
is still needed to separate that effect from stochastic downstream calls.

## Cost and time

Costs exclude the canonical judge, which made the same 90 calls per cell.

| Query-time component | v1 | Hybrid | Delta |
|---|---:|---:|---:|
| Retrieval calls | 857 | 180 | -677 |
| Downstream calls | 345 | 308 | -37 |
| Retrieval cost | $1.473 | $1.310 | -$0.163 |
| Downstream cost | $0.430 | $0.387 | -$0.043 |
| **Total inference cost** | **$1.903** | **$1.697** | **-$0.206 (-10.8%)** |
| Retrieval wall time | 103.5s | 18.8s | -84.7s |
| Downstream wall time | 199s | 193s | -6s |
| **Approx. serial wall time** | **302.5s** | **211.8s** | **-90.7s (-30.0%)** |

Downstream Nano tokens fell from 1,470,161 to 1,307,670 and per-session
extraction calls fell from 255 to 218 because the hybrid bag is smaller.

## Artifacts

- Retriever control:
  `runs/local-archive/backbone/hop-screen90-control-v1.json`
- Retriever hybrid:
  `runs/local-archive/backbone/hop-screen90-hybrid-v1.json`
- Full v1 run:
  `runs/hop-screen90-opaque-v1-arm3-20260731-3`
- Full hybrid run:
  `runs/hop-screen90-opaque-hybrid-arm3-20260731-3`
