# Hop + Arm 3 checkpoint — 2026-07-31

Parent checkpoint: `8d8e379dfce212987bfe1a24a4e219af8045612a`

## Frozen state

This checkpoint freezes the answerable135 evaluation of the sequential v1 hop
retriever and four downstream readers. The canonical protocol run is
`hop-bag-downstream-answerable135-protocol1-*`. Earlier smoke and
`hop-bag-downstream-answerable135-v1-*` pilot directories are intentionally not
part of the checkpoint.

### Retriever

- Input notes: `session-annotations-v1`, already constructed from user turns.
- Controller: `gpt-5.6-luna`, low reasoning.
- Prompt: `hop-retrieve-v1`.
- Search budget: H=6; bag maximum 12.
- Answerable135 full-gold-in-bag: 123/135.
- Strata: hard 19/28, mid 10/12, easy 94/95.
- Frozen result:
  `runs/local-archive/backbone/hop-gate-luna-h6-v1-answerable135.json`.

### Winning downstream reader

Arm 3 is a per-session map/reduce reader:

1. Hydrate every session in the frozen hop bag from raw conversations.
2. Run one `gpt-5.4-nano-2026-03-17` low-reasoning extraction call per session
   concurrently (`hop-session-extract-v1`).
3. Validate exact session/turn references.
4. Build a deterministic balanced package: one bounded excerpt per session
   first, adjacent conversational turns, then round-robin breadth; maximum 40
   turns / 40,000 characters.
5. Answer with `answer-v8-preference` using the same Nano model at medium
   reasoning.

Canonical answerable135 scores:

| Reader | Correct |
|---|---:|
| Architecture 0005.4 | 110/135 |
| Architecture 0005.4.4 | 113/135 |
| Arm 1A — unchanged selector | 115/135 |
| Arm 1B — guarded selector | 112/135 |
| Arm 2 — deterministic package | 113/135 |
| **Arm 3 — parallel map/reduce** | **118/135** |

Arm 3 scored hard 19/28, mid 9/12, easy 90/95. It used 2,159,456 Nano tokens
and an estimated $0.632 of Nano inference for 135 questions, excluding frozen
hop retrieval and canonical judging.

## Failure localization

Of Arm 3's 17 wrong answers:

- 7 had incomplete-gold hop bags;
- approximately 2 had the gold session but the decisive raw turn did not reach
  the reduced package;
- approximately 8 had the decisive evidence in the package but the final
  `answer-v8` Nano call selected, counted, deduplicated, or abstained
  incorrectly.

The final answerer is therefore the leading immediate improvement target.
Freeze the current Arm 3 packages and use answer-only replay to test a stronger
Call 2 before changing retrieval or extraction.

## Canonical artifacts

- `runs/local-archive/backbone/hop-downstream-answerable135-results.md`
- `runs/hop-bag-downstream-answerable135-protocol1-1a`
- `runs/hop-bag-downstream-answerable135-protocol1-1b`
- `runs/hop-bag-downstream-answerable135-protocol1-2`
- `runs/hop-bag-downstream-answerable135-protocol1-3`

Each protocol run contains its manifest, predictions, per-case package and
intermediate artifacts, canonical GPT-4o judgments, and report.

## Validation

- Four-arm protocol generation: 540/540 tasks completed, zero failures.
- Canonical judging: 135/135 cases per arm.
- Predictions validated with `PredictionRecord`.
- Package caps and answer citation references validated.
- TypeScript typecheck passed.
- Agent test suite: 56/56 passed.

## Next controlled experiment

Run Arm 3 answer-only replay from the frozen packages. Do not regenerate notes,
hop bags, or per-session maps. Compare final answer models/prompts on the same
135 packages so any score movement is attributable only to Call 2.
