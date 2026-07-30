# Trajectory analysis — batch 02 (cases 45–89)

Scope: 45 assigned cases; 230 note searches (217 BM25, 13 grep): 55 `QI`, 28 `RD`, and 147 `R`. `QI` = question-independent, `RD` = result-dependent concrete cue, and `R` = redundant / no useful new direction. Search numbers below are ordinal searches (not hop labels). `first` reports first gold-session exposure as `s1 / s2–3 / s4–6 / never`; `batch` asks whether every successful issued query could have been sent initially; `2R` asks whether two adaptive rounds suffice for full-gold coverage in the observed trajectory.

## Aggregate

- Gold-session first exposure: **72/80 s1**, **3/80 s2–3**, **1/80 s4–6**, **4/80 never**. Thus 75/76 surfaced gold sessions (98.7%) appeared by search 3, and 72/76 (94.7%) at search 1.
- **29/45** cases have only question-independent successful directions and are fully initial-batchable. **16/45** include at least one successful result-dependent refinement.
- **41/45** have all gold sessions surfaced by the recorded searches and fit two adaptive rounds; **4/45** have a gold session that no recorded note search surfaced, so full-gold coverage cannot be claimed from this trace (though the surfaced targets are found within two rounds).
- The observed controller overspends: most later searches are lexical rewrites after a rank-1/2 gold hit. Concrete-hit refinement is useful only when it supplies a discriminative entity, title, amount, date, or named option.

## Per-case audit

| case | qid | classifications by search | first | batch | 2R |
|---:|---|---|---|---|---|
| 45 | 66f24dbb | QI, QI, RD, RD, R | s1 | no | yes |
| 46 | 6a1eabeb | QI, R | s1 | yes | yes |
| 47 | 6aeb4375 | QI, QI, R, R, R, R, R | s1 | yes | yes |
| 48 | 6b168ec8 | QI, R, RD, R, R, R, R | s1 | no | yes |
| 49 | 6d550036 | QI, QI, QI, RD, R, R, R | s1/s4–6/never | no | no* |
| 50 | 70b3e69b | QI, R, R, R, R, R | s1 | yes | yes |
| 51 | 71017276 | QI, R, R, R, R, R, R | s1 | yes | yes |
| 52 | 71a3fd6b | QI, R, R, R, R, R | s1 | yes | yes |
| 53 | 75832dbd | QI, QI, R, R, RD, R, R | s2–3 | no | yes |
| 54 | 778164c6 | QI, R | s1 | yes | yes |
| 55 | 7e00a6cb | QI, R, R, R, R, R, R | s1 | yes | yes |
| 56 | 81507db6 | QI, QI, R, R, R | s1/s2–3 | yes | yes |
| 57 | 852ce960 | QI, R, RD | s1 | no | yes |
| 58 | 8550ddae | QI, R, RD, R, RD | s1 | no | yes |
| 59 | 86f00804 | QI, R | s1 | yes | yes |
| 60 | 8752c811 | QI, R, RD, R, R, R, R | s1 | no | yes |
| 61 | 89941a94 | QI, R, RD, R, R, R, R | s1 | no | yes |
| 62 | 8c18457d | QI, R, R, R, R, R, R | s1 | yes | yes |
| 63 | 8cf51dda | QI, R, R | s1 | yes | yes |
| 64 | 92a0aa75 | QI, R, R, R, R, R | s1/never | yes | no* |
| 65 | 95228167 | QI, QI, R, RD, R | s1 | no | yes |
| 66 | 95bcc1c8 | QI, R | s1 | yes | yes |
| 67 | 9ea5eabc | QI, R | s1 | yes | yes |
| 68 | 9ee3ecd6 | QI, R, R, R, R, RD, R | s1 | no | yes |
| 69 | a06e4cfe | QI, R, R, R, R, R, R | s1 | yes | yes |
| 70 | a08a253f | QI, R | s1/never | yes | no* |
| 71 | a3045048 | QI, R, R, R, R, R | s1 | yes | yes |
| 72 | a3838d2b | QI, R, R | s1/never | yes | no* |
| 73 | a40e080f | QI, R, RD, RD, R, R | s1 | no | yes |
| 74 | a89d7624 | QI, QI, RD, RD, RD, RD | s1 | no | yes |
| 75 | afdc33df | QI, R, R, R, R | s1 | yes | yes |
| 76 | affe2881 | QI, R, RD, R, R, RD, R | s1 | no | yes |
| 77 | b3c15d39 | QI, R, RD, RD, RD, RD, R | s1 | no | yes |
| 78 | b46e15ed | QI, QI, R, R, R, R, R | s1 | yes | yes |
| 79 | b86304ba | QI, R, R, R, R, R | s1 | yes | yes |
| 80 | b9cfe692 | QI, R, R, R | s1 | yes | yes |
| 81 | ba358f49 | QI, QI, R, R, R, R | s1/s2–3 | yes | yes |
| 82 | c5e8278d | QI, R | s1 | yes | yes |
| 83 | c8090214 | QI, R, R, R, RD, RD, R | s1 | no | yes |
| 84 | c8f1aeed | QI, R, R, R, R, R, R | s1 | yes | yes |
| 85 | caf03d32 | QI, R, RD, RD | s1 | no | yes |
| 86 | cc5ded98 | QI, R, R, R | s1 | yes | yes |
| 87 | ce6d2d27 | QI, R | s1 | yes | yes |
| 88 | cf22b7bf | QI, R | s1 | yes | yes |
| 89 | d01c6aa8 | QI, R, R, R, R, R | s1 | yes | yes |

`*` A gold session was never returned by BM25/grep in the recorded trajectory; this is a retrieval-coverage limitation, not evidence that a third adaptive round would fix it.

## Recurring query roles and batching rules

- **Anchor retrieval (QI):** turn the question into its distinctive entities, relationship, action, and requested attribute. This first query was sufficient to surface the great majority of gold sessions.
- **Planned semantic variants (QI):** when the question has two independently expressible facets (for example, event plus date, or recommendation plus topic), issue the alternate wording in the same first batch. Do not serialize simple word-order swaps, singular/plural edits, or adding “number,” “date,” or “how many.”
- **Evidence pinning (RD):** after a hit introduces a concrete discriminator, issue one precision query using it. Product/model names, restaurant or venue names, a named dish/book, a dollar amount, a calendar date, and a specific recommendation are appropriate pins.
- **Verification grep (RD):** grep is worthwhile only to verify a newly discovered exact phrase/value in the already plausible session. Repeating grep with the same broad phrases, or rerunning the anchor after a confirmed hit, is redundant.
- **Stop rule:** once all known target sessions are present and the answer-bearing snippets are clear, stop. A better rank for a known gold session is not a new retrieval direction.

Representative generalist examples: a travel-recommendation question can launch broad city/activity and city/restaurant variants together; after the first result names a landmark, a second-round landmark query can pin the conversation. A purchase-history question can search the described item and event immediately; only after a result supplies an exact model, date, or sale event should a second round use that detail. Conversely, a question already containing a rare technical topic plus its requested fact should use one anchor and stop after it returns the relevant conversation, rather than cycling through reordered keywords.
