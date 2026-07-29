# Batch 15
## Coverage
- qids: 25
- by question_type: multi-session 9, temporal-reasoning 8, knowledge-update 8
- notes_coverage: full 8, partial 17, none 0
- abstention: 0
- gold-notes note: all 8 `full` packs have notes on every gold session; all 17 `partial` packs have **empty notes on every gold session** (evidence only in user turns), so notes-hop cannot surface those golds via `bm25_notes`/`grep_notes`

## Per-qid paths
- `8cf4d046` (`multi-session`): **no-evidence in notes** (both golds empty); if turns were indexed, bag undergrad GPA ~3.86 and grad GPA 3.8 then average—never stop on a single school session.
- `gpt4_468eb064` (`temporal-reasoning`): `bm25_notes`/`grep_notes` for lunch + person name / “Emma”; resolve “last Tuesday” via session_date vs question_date; `add_sessions` the lunch event hit; `done`.
- `ce6d2d27` (`knowledge-update`): grep/bm25 `cocktail-making class` + weekday; bag both Thursday (older) and Friday (newer) schedule sessions; answer with the **latest** weekday, not the first hit.
- `8e91e7d9` (`multi-session`): **no-evidence in notes**; path would need separate sibling fragments (3 sisters + 1 brother) from two sessions before summing—never treat one family mention as complete.
- `gpt4_483dd43c` (`temporal-reasoning`): **no-evidence in notes**; need both show-start sessions (GoT “about a month ago” vs Crown start/finish window) and compare relative start times, not finish order.
- `cf22b7bf` (`knowledge-update`): bm25/grep weight-loss + gym consistency; bag older “lost 5 pounds” and newer “lost 10 pounds since … 3 months”; prefer the **updated** total for “how much … since I started.”
- `91b15a6e` (`multi-session`): **no-evidence in notes**; retrieve necklace value ($5000) and vanity floor ($150) from separate item sessions, then sum minima—do not stop after one heirloom.
- `gpt4_4929293a` (`temporal-reasoning`): **no-evidence in notes**; bag cousin’s wedding and Michael’s engagement party sessions; order by session_date / “today” event stamps, not by which title matches first.
- `d7c942c3` (`knowledge-update`): **no-evidence in notes**; need prior state (mom on paper list) and update (mom now on same grocery app); answer from the **later** state.
- `92a0aa75` (`multi-session`): bm25/grep role tenure / “Senior Marketing Specialist” / months; bag promotion-duration fragment (2y4m) and total company tenure (3y9m); use the fact that answers “current role,” not the first duration hit.
- `gpt4_4929293b` (`temporal-reasoning`): **no-evidence in notes**; bag relative life-event sessions; anchor “a week ago” to question_date so cousin’s wedding (~1 week prior) wins over older engagement party.
- `dad224aa` (`knowledge-update`): **no-evidence in notes**; bag conflicting Saturday wake times (8:30 then 7:30); for current wake time prefer the **later** update.
- `9aaed6a3` (`multi-session`): **no-evidence in notes**; need SaveMart spend session ($75 last Thursday) plus membership cashback rate (1%); multiply—neither session alone answers.
- `gpt4_4cd9eba1` (`temporal-reasoning`): **no-evidence in notes**; bag acceptance date (Mar 20) and orientation start (every Friday since 3/27); compute weeks between those anchors.
- `db467c8c` (`knowledge-update`): bm25/grep parents staying / months in US; bag “six months” then “nine months”; report the **updated** duration.
- `9d25d4e0` (`multi-session`): **no-evidence in notes**; hop until all acquisition fragments in the two-month window are bagged (silver necklace, engagement ring, emerald earrings)—stopping at one piece undercounts.
- `gpt4_4edbafa2` (`temporal-reasoning`): **no-evidence in notes**; bag June BBQ date mentions (3rd vs 17th); pick the earliest June BBQ date, not the first BBQ sauce hit.
- `dfde3500` (`knowledge-update`): **no-evidence in notes**; bag previous tutor Juan (Wednesday) and current Maria (Thursday); question asks **previous** Juan’s weekday—do not answer with the newer tutor.
- `9ee3ecd6` (`multi-session`): bm25/grep Sephora points / redeem / free skincare; the redeem threshold (300) may sit in one session while balance (200+50) sits in another—bag both; answer the stated need-to-earn total.
- `gpt4_4ef30696` (`temporal-reasoning`): grep/bm25 exact book titles (`Nightingale`, `Hitchhiker`); bag finish-date and start-date sessions; use session_date/event “today” stamps to count intervening days.
- `e493bb7c` (`knowledge-update`): **no-evidence in notes**; bag living-room hanging then bedroom move of “Ethereal Dreams”; current location = **latest** placement.
- `a08a253f` (`multi-session`): bm25 `fitness classes` then grep class+weekday (`Zumba`, `yoga`, `weightlifting`); add both schedule sessions; count distinct weekdays across fragments before `done`.
- `gpt4_4fc4f797` (`temporal-reasoning`): **no-evidence in notes**; bag suspension-feedback mention and later track-day test date; compute day gap from those two anchors—not from generic suspension advice alone.
- `e61a7584` (`knowledge-update`): **no-evidence in notes**; bag “had Luna ~6 months” then “~9 months”; answer with the **updated** ownership duration.
- `a11281a2` (`multi-session`): **no-evidence in notes**; bag start-of-year followers (250) and after-two-weeks count (350); difference is the increase—never answer from a single follower mention.

## Cross-cutting rules (generalist)
- On knowledge-update questions, always retrieve **both** an earlier state and a later state; answer from the chronologically latest fact unless the question explicitly asks for a previous/old value.
- On multi-session aggregates (sum, average, count, min-total, rate×amount), keep hopping until every required numeric/entity fragment is in the bag; one matching topic session is not enough.
- Prefer concrete lexical anchors from the question (proper names, titles, product/store names, class types, dollar amounts, weekdays) over abstract labels (`schedule`, `family`, `fitness`, `update`).
- After any hit that contains a needed fragment, `add_sessions` immediately (bag ≤12); do not wait for a perfect single query that returns all golds.
- For temporal ordering / “how many days/weeks” / “which first” / “last &lt;weekday&gt;”, use session_date and notes `events`/`date_hint` relative stamps against `question_date`, not narrative order of retrieval.
- When BM25 on the question surface is incomplete, `grep_notes` for distinctive nouns already seen in hits (second book title, second item name, alternate class type, prior vs current person).
- If notes for candidate golds are empty, do not invent sessions or answer from assistant prose; treat as notes-hop failure / no-evidence rather than stuffing unrelated annotated hits.
- For frequency (“how many days a week”) and acquisition-count questions, union all recurring activity+weekday or item+time fragments before calling `done`.
- Distinguish “previous/old X” from “current X” in the query and in which bagged session you trust; updated entities often share a topic with superseded facts.
- Never call `done` with an empty bag or after repeating the same query with no new `add_sessions`.

## Anti-patterns
- abstract label queries; done with empty bag; repeating the same query;
  answering instead of retrieving; stuffing unrelated hits
- treating the first schedule/value/duration hit as final on update or multi-hop aggregate questions
- ordering events by which title matched BM25 first instead of dated evidence
- answering with the newer entity when the question asks for a previous one (or vice versa)
- assuming partial haystack notes imply gold sessions are searchable—partial often means gold notes are empty
