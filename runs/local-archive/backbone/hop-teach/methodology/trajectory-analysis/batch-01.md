# Trajectory analysis — batch 01 (cases 0–44)

Scope: the first 45 archived cases only.  I treated a query as **QUESTION_INDEPENDENT** (QI) when it can be formulated from the question and its date alone, **RESULT_DEPENDENT** (RD) when it imports a concrete detail first exposed by an earlier hit, and **REDUNDANT** (R) when it is a near-repeat or adds no materially different retrieval direction.  `grep_notes` pattern searches are included.  The code order below is the recorded search order; repeated hop-6 calls remain separate searches.

## Aggregate

- 261 searches: 57 QI (21.8%), 43 RD (16.5%), and 161 R (61.7%). The large redundant share is principally repeated lexical rephrasings after the answer sessions were already retrieved.
- Gold-session first appearance (79 gold sessions): 76 at search 1; 2 at searches 2–3; 0 at searches 4–6; 1 never appeared in any recorded search hit. At case level, 42/45 had all gold sessions by search 1, 2/45 by searches 2–3, and one case retained one missing gold session.
- All recorded successful searches could be sent as one initial batch in 18/45 cases (no RD query). In the other 27, later successful searches included an earlier-hit-specific cue, though that cue was usually unnecessary because the gold had already surfaced at search 1.
- Two adaptive rounds suffice for 45/45 cases: no first gold appearance is later than search 3, and the only later appearances are reachable with question-derived variants. This is a statement about retrieval coverage, not a reason to spend the rounds after the gold is already in the bag.

## Per-case ledger

`batch` means every successful search is QI; `2r` is whether two adaptive rounds suffice. `first` reports the first hit for each gold session; `—` means never hit.

| case | search classifications | first | batch | 2r |
|---|---|---:|:---:|:---:|
| 031748ae | QI R R R R R R | 1,1 | yes | yes |
| 06878be2 | QI R R RD RD | 1 | no | yes |
| 078150f1 | QI R R RD R R R | 1,1 | no | yes |
| 099778bb | QI R R R R RD R | 1,1 | no | yes |
| 09d032c9 | QI R R R R R | 1 | yes | yes |
| 0a34ad58 | QI R RD R R RD R | 1 | no | yes |
| 0bb5a684 | QI R RD R RD RD R R | 1,1 | no | yes |
| 0db4c65d | QI RD RD RD R RD R | 1,1 | no | yes |
| 0ddfec37 | QI QI R QI R | 1,1 | yes | yes |
| 10e09553 | QI R R R R R R | 1,1 | yes | yes |
| 129d1232 | QI R RD R RD R R | 1,1,1 | no | yes |
| 195a1a1b | QI QI R RD R R | 2 | no | yes |
| 1a1907b4 | QI R R R | 1 | yes | yes |
| 1d4da289 | QI R RD R RD R R | 1 | no | yes |
| 1d4e3b97 | QI R QI R QI R R | 1 | yes | yes |
| 1f2b8d4f | QI R R R R R R | 1,1 | yes | yes |
| 1faac195 | QI R | 1 | yes | yes |
| 2318644b | QI R | 1,1 | yes | yes |
| 25e5aa4f | QI R QI R R R R | 1 | yes | yes |
| 28dc39ac | QI R R RD R | 1,1,1,1,1 | no | yes |
| 2ce6a0f2 | QI QI RD QI R | 1,1,1,1 | no | yes |
| 2e6d26dc | QI R | 1,1,1,1 | yes | yes |
| 2ebe6c92 | QI QI R R R R R | 1,1 | yes | yes |
| 32260d93 | QI R RD RD R R | 3 | no | yes |
| 36b9f61e | QI R R R R RD R | 1,1,1 | no | yes |
| 3ba21379 | QI R RD | 1,1 | no | yes |
| 3d86fd0a | QI R RD RD R R | 1 | no | yes |
| 4100d0a0 | QI R RD R RD | 1 | no | yes |
| 41275add | QI R R R R R R | 1 | yes | yes |
| 41698283 | QI RD R RD | 1,1 | no | yes |
| 42ec0761 | QI R R RD R R R | 1,1 | no | yes |
| 4388e9dd | QI R RD R RD R R | 1 | no | yes |
| 4dfccbf8 | QI QI QI R R R R | 1,— | yes | yes |
| 4f54b7c9 | QI R R R RD | 1,1 | no | yes |
| 5025383b | QI R RD R | 1,1 | no | yes |
| 505af2f5 | QI R R | 1 | yes | yes |
| 5809eb10 | QI R RD RD R R R | 1 | no | yes |
| 58bf7951 | QI R RD R R R RD | 1 | no | yes |
| 58ef2f1c | QI QI R R R R R | 1 | yes | yes |
| 5d3d2817 | QI R R R R R R | 1 | yes | yes |
| 60036106 | QI R | 1,1 | yes | yes |
| 60159905 | QI R RD R R R | 1,1 | no | yes |
| 6071bd76 | QI R RD R R R R | 1,1 | no | yes |
| 618f13b2 | QI R R RD R RD R | 1,1 | no | yes |
| 6222b6eb | QI R R R R R | 1 | yes | yes |

Validation: 45 rows above, corresponding exactly to archive indices 0–44.

## Recurring query roles

- **Anchor/intent query (QI):** translate the entity, relation, quantity, and time window in the question into a compact lexical query. It retrieved 76/79 gold sessions at the first search.
- **Question-derived coverage variant (QI):** make a distinct but still pre-search formulation for a broad recommendation or time calculation; use it in the initial batch, rather than serially. This accounts for the two gold sessions first seen in searches 2–3.
- **Hit-specific resolver (RD):** after a promising hit, use a newly revealed proper noun, date, model, amount, title, or attribute to disambiguate. Useful for inspection, but generally not required for initial gold recall here.
- **Rewording loop (R):** reorder the same terms, pluralize them, or repeat the exact query. Once the hit set is stable, stop rather than consume hops.

## Generalist rules and examples

Use an initial parallel batch with (1) a direct intent anchor and (2) one or two genuinely different question-derived coverage variants. For a broad evening-activity request, “hobbies/entertainment” and “relaxation” are independent variants, while repeating the latter is not a new direction. For a recommendation to watch something, genre and service alternatives belong in the initial coverage batch only if they are plausible from the request; they should not be serial guesses copied from a prior answer.

Reserve an adaptive round for concrete evidence from hits: a camera body and flash name discovered in a photography record, a named charity event and dollar amount, a specific legal citation/year, or named family heirlooms. These are legitimate resolvers, but are not initial-batch queries because the question alone does not supply them. Conversely, dates computable from the question date, generic location/quantity terms, and alternate wording of the question are QI—not evidence of a need for sequential search.

Stop after stable gold coverage. The trajectories repeatedly reissued the same anchor for four to six hops even when every gold session was already present. A missing second gold session in the Rachel trajectory was not recovered by those repeats, so additional paraphrases did not repair coverage.
