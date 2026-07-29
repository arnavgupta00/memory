# gpt4_2f8be40d

## Question gist

Count how many weddings the user has **attended** in the calendar year of the question date (2023), not how many they are planning. Evidence is scattered across multi-session planning chats that mention past attendance as asides.

## Gold sessions and cue phrases

| Session | Date | Attendance cues in notes (facts / keyphrases / events) |
|---|---|---|
| `answer_e7b0637e_2` | 2023/10/15 04:44 | college roommate’s wedding in the city (recently); rooftop garden ceremony; friend Emily married Sarah; intimate ~50 guests |
| `answer_e7b0637e_1` | 2023/10/15 05:48 | been to a few weddings recently; cousin’s / Rachel’s vineyard wedding (August); bridesmaid at Rachel’s wedding; cousin Emily’s wedding in the city; rooftop garden wedding |
| `answer_e7b0637e_3` | 2023/10/15 19:23 | friend’s wedding last weekend; rustic barn countryside; bride Jen / groom Tom; Jen got married (book-club friend) last weekend |

Primary retrieval strings: `wedding` + past-attendance frames (`attended`, `got back from`, `bridesmaid`, `last weekend`, month names); named people (`Rachel`, `Emily`, `Jen`/`Tom`); venues (`vineyard`, `rooftop garden`, `rustic barn`).

## Correct hop path (H≤6)

1. **bm25_notes** — query for attended/third-party weddings with year-ish temporal cues, e.g. `attended wedding OR bridesmaid OR "got back from" wedding vineyard OR barn OR rooftop` (avoid pure venue-planning intent alone).
2. **grep_notes** — tighten on event markers: `bridesmaid|vineyard|Rachel|Emily|Jen|rustic barn|college roommate|last weekend|August`.
3. **add_sessions** — bag from **last hits only**, ≤12: prioritize sessions whose notes have `[events]` / facts of **past** attendance (`answer_e7b0637e_2`, `_1`, `_3`).
4. **bm25_notes** or **grep_notes** — second pass for missed named weddings / relative dates (`last weekend`, `August`, `recently`) anchored to question_date year.
5. **add_sessions** — if a gold-like hit was outside the first bag, add it (still last-hits, bag≤12).
6. **done** — stop once all distinct attended-wedding event clusters for the year are in-bag; do not chase more planning-only sessions.

Within-bag read order: extract each past-attendance event; align relative times to 2023; **dedupe** overlapping Emily/city/rooftop mentions across `_1` and `_2` before counting.

## Failure modes

- Retrieval floods on **own wedding planning** (outdoor ceremony, beach/park, guest list, music) and never isolates attendance asides.
- Counting the user’s **upcoming** wedding or reception ideas as attended events.
- Treating every `Emily` / rooftop-garden mention as a new wedding without cross-session identity check (cousin vs college roommate framing).
- Missing `last weekend` / `August` / `recently` temporal grounding → wrong year scope or dropped events.
- Stopping after one “few weddings” session and under-covering the Jen/barn and roommate sessions.

## Reusable rules (3–7 generalist)

1. For **count-of-attended** questions, rank notes with past-tense attendance and `[events]` over planning/desiderata keyphrases.
2. Strip **self-future** plans (my ceremony, my vows, my venue) from the countable set; keep only third-party events the user says they went to.
3. **Cluster then count**: merge sessions that share person+venue+time before incrementing.
4. Map relative time phrases to the **question_date** year before including an event in the tally.
5. Prefer **named** attendance (person, role, venue, month/weekend) over vague “a few” without enumeration.
6. Keep `add_sessions` bags ≤12 from **last hits only**; refill with attendance-shaped hits, not more planning twins.
7. If two relationship labels conflict but venue/date/name align, treat as one event unless notes clearly split them.

## Abstention / thin-notes

Not an abstention item (`is_abstention: false`); notes coverage here is full. Abstain or refuse a firm count only if notes lack any past-attendance events inside the year window, or if attendance is only implied (“few weddings”) with no recoverable distinct events after dedupe—thin notes that keep planning facts but drop `[events]` lines would systematically undercount and should trigger low-confidence / abstain rather than inventing sessions.
