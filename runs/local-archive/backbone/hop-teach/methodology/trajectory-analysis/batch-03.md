# Batch 03 — sequential trajectory analysis (cases 90–134)

Scope: all 45 assigned cases, using only the recorded retrieval steps and the corresponding question text. `QI` = question-independent; `RD` = result-dependent; `R` = redundant (near-duplicate/no new retrieval direction).  The sequence below is in recorded call order and includes both `bm25_notes` and `grep_notes`; a trailing `R` also covers the exhausted-budget duplicate when present.

## Aggregate

- 45/45 cases covered; 227 retrieval calls: 215 BM25 and 12 grep (216 successful calls).
- Gold-session first surface: 41 cases had every gold session at search 1; 1 case first completed at searches 2–3; 0 first completed at searches 4–6; 3 cases never surfaced every gold session. At session level: 116 first surfaced at search 1, 2 at search 2, and 4 never appeared in retrieval hits.
- 32/45 trajectories contain only question-derivable (or redundant) successful retrieval calls, so all of their successful calls could have been issued in one initial batch. The other 13 introduce concrete hit-derived anchors, hence are not literally reproducible as a single pre-search batch.
- Two adaptive rounds would suffice for retrieval coverage in 42/45 cases (including the one whose last missing gold sessions arrive on round 2). The remaining three have at least one gold session absent from all six-hop results, so more adaptation of the recorded sort cannot suffice.
- Practical implication: batch diverse question-derived formulations first; reserve one focused follow-up round for anchors exposed by initial hits. Do not spend later rounds on token reorderings or identical grep calls.

## Per-case classifications

`gold` gives the first-surface bucket for all gold sessions: `1`, `2–3`, or `never` (a mixed result lists both). `batch` and `2 rounds` answer the requested counterfactuals.

| Case | Retrieval-call classes | gold | batch | 2 rounds |
|---|---|---:|---:|---:|
| d6233ab6 | QI, R, R, R, R, R, R | 1 | yes | yes |
| d905b33f | QI, R, R, R, R, R, R | 1 | yes | yes |
| db467c8c | QI, R, R | 1 | yes | yes |
| e3038f8c | QI, R, R, RD, RD, RD | 1 | no | yes |
| e982271f | QI, R, R, R, R, R, R | 1 | yes | yes |
| ec81a493 | QI, R, R, RD, R, R, R | 1 | no | yes |
| ed4ddc30 | QI, QI | 1 | yes | yes |
| ef9cf60a | QI, QI, RD | 1 | no | yes |
| f35224e0 | QI, R, R, R, R | 1 | yes | yes |
| f4f1d8a4 | QI, R, R, QI, R, R | 1 | yes | yes |
| f685340e | QI, R, RD, R, R, RD, R | 1 | no | yes |
| fca70973 | QI, R | 1 | yes | yes |
| fca762bc | QI, R, R, RD, R, R | 1 | no | yes |
| gpt4_0b2f1d21 | QI, R, QI, R, R, R | 1 | yes | yes |
| gpt4_18c2b244 | QI, R, R, R, R | 1 | yes | yes |
| gpt4_194be4b3 | QI, R, R, R, R, R | 1 | yes | yes |
| gpt4_2487a7cb | QI, R, R, R, R, R, R | 1 | yes | yes |
| gpt4_2ba83207 | QI, QI, R, R, R | 1 | yes | yes |
| gpt4_2c50253f | QI, R | 1 | yes | yes |
| gpt4_2f8be40d | QI, R, R, R, R, RD | 1 | no | yes |
| gpt4_2f91af09 | QI, R, QI, R, R, R | 1 | yes | yes |
| gpt4_372c3eed | QI, R, RD, RD | 1 | no | yes |
| gpt4_45189cb4 | QI, R, QI, RD, R, R, R | 1 | no | yes |
| gpt4_468eb063 | QI, R, R, R, QI | 1 | yes | yes |
| gpt4_468eb064 | QI, R, R, R, R, R, R | 1 | yes | yes |
| gpt4_4ef30696 | QI, R, R, R | 1 | yes | yes |
| gpt4_5501fe77 | QI, R, QI, R | 1 | yes | yes |
| gpt4_59c863d7 | QI, RD, R, R, RD | 1 | no | yes |
| gpt4_5dcc0aab | QI, QI | 1 | yes | yes |
| gpt4_731e37d7 | QI, QI, R, R, R, R | 1 | yes | yes |
| gpt4_7a0daae1 | QI, R, R, R, R, R, R | 1 | yes | yes |
| gpt4_7abb270c | QI, R, R, R, R, QI, R | 1 + never | yes | no |
| gpt4_7bc6cf22 | QI, R | 1 | yes | yes |
| gpt4_7f6b06db | QI, QI, QI, RD | 1 | no | yes |
| gpt4_7fce9456 | QI, R, QI, RD, R | 1 | no | yes |
| gpt4_88806d6e | QI, R, R | 1 | yes | yes |
| gpt4_93f6379c | QI, R | 1 + never | yes | no |
| gpt4_a1b77f9c | QI, R, R | 1 | yes | yes |
| gpt4_b5700ca0 | QI, R, RD, R, RD, RD | 1 | no | yes |
| gpt4_d6585ce8 | QI, QI, QI, R, R, R | 1 | yes | yes |
| gpt4_d6585ce9 | QI, R, R, R, R, R | 1 | yes | yes |
| gpt4_e061b84f | QI, QI, R, RD | 1 + 2–3 | no | yes |
| gpt4_e061b84g | QI, QI, R, R, R, R, R | 1 + never | yes | no |
| gpt4_f49edff3 | QI, R, QI, R | 1 | yes | yes |
| gpt4_fe651585 | QI, R, R, R, R, R | 1 | yes | yes |

## Recurring query roles and operating rules

1. **Question-anchor retrieval (QI).** Form a compact lexical query from the entities, relation, requested comparison/count, and explicit time window in the question. Exact title/name queries, relative-date expansions using the question date, and alternative generic facets are all initial-batch candidates.
2. **Orthogonal question-derived reformulation (QI).** A second initial query may change retrieval vocabulary or add a separate question facet (for example, purchase/delivery rather than only interval). Mere word-order changes, duplicate quoted forms, and synonym swaps are `R`, not useful diversification.
3. **Evidence-anchor follow-up (RD).** After initial hits expose a concrete anchor absent from the question—such as a school and years, item subtypes, a branded app/model, an event name, or a candidate location—issue one targeted follow-up/grep using that anchor. This is the only recurring justification for adaptivity in this slice.
4. **Stop on saturation (R).** Repeating the same query, reordering its terms, or rerunning an unchanged grep after it already returned the relevant sessions did not improve recall here. Avoid using the remaining hops for this pattern.
5. **Generalist examples.** Broad questions about totals (rare possessions, model kits, musical instruments) first retrieve a heterogeneous set; only then can named subtypes form an evidence-anchor query. Timeline/order questions usually need no adaptation: the named events and date/order relation already belong in the initial query set. For an underspecified preference/reminder question, first retrieve the stated subject and context; use a discovered specific recommendation only if initial results fail to expose the needed session.

## Representative evidence of the distinction

- In the rare-items trajectory, the first query already exposed the gold sessions. Later searches expanded to specific item types that were visible in those hits; the expansion was result-dependent but unnecessary for recall.
- In the education-duration trajectory, the school name and year spans used by grep and the later university query came from the earlier evidence; this is a legitimate adaptive anchor, though first-hop retrieval had already found the gold sessions.
- In the sports-event ordering trajectory, the first formulation found one gold session and the second found the remaining ones. The later named-event query was adaptive refinement, not the reason two rounds succeeded.
- The three incomplete cases illustrate a separate failure mode: at least one gold session never appears in any recorded hit. Extra query rephrasing cannot establish that missing recall; it calls for a broader retrieval strategy rather than more sequential hops.

## Validation

- Case range is exactly indices 90 through 134 inclusive: 45 rows in the table.
- No `grep_notes` calls were omitted: their 12 calls are represented in the sequences above.
