# Batch 16

## Coverage

- qids: 25
- by question_type: multi-session 10, temporal-reasoning 9, knowledge-update 6 (includes 2 abstention variants)
- notes_coverage: full 4, partial 21, none 0

## Per-qid paths

- `a1cc6108` (`multi-session`): bm25_notes for "Alex" + age and "turned 32"; add_sessions for both mentor/career sessions, then subtract ages from paired facts.
- `gpt4_5438fa52` (`temporal-reasoning`): grep_notes "Spanish classes" and "cultural festival hometown"; compare relative timing ("three months" vs "yesterday") across the two Europe-trip sessions.
- `e66b632c` (`knowledge-update`): grep_notes "charity 5K" "personal best" "27 minutes"; retrieve the earlier session for the superseded PB before the 26:30 update.
- `a3332713` (`multi-session`): bm25_notes "coworker baby shower" $100 and "brother graduation" $100; add_sessions from both gift-spending threads and sum.
- `gpt4_59149c77` (`temporal-reasoning`): bm25_notes "MoMA" "Ancient Civilizations" "Metropolitan Museum"; add both museum-visit sessions and compute day gap from session dates (Jan 8 vs Jan 15).
- `eace081b` (`knowledge-update`): grep_notes "birthday trip Hawaii" plus island names; prefer the later session stating "stay on Oahu" over the earlier Kauai-only planning.
- `a346bb18` (`multi-session`): bm25_notes "marathon" "4h 22" and "target time 4 hours 10"; add both running sessions to derive minutes over target.
- `gpt4_59149c78` (`temporal-reasoning`): grep_notes "MoMA tour" and "Ancient Civilizations exhibit"; anchor "two weeks ago" to question_date and match the Met visit (~Jan 15) over the earlier MoMA tour.
- `ed4ddc30` (`knowledge-update`): bm25_notes "dozen eggs" "fridge"; take the March 15 count (20 dozen) over the January 30 dozen figure.
- `a4996e51` (`multi-session`): grep_notes "40 hours a week" and "peak campaign" "10 hours"; combine baseline hours from one session with peak increment from the other.
- `gpt4_5dcc0aab` (`temporal-reasoning`): bm25_notes "cleaned white Adidas" "last month"; single fact-bearing session suffices—notes explicitly name the cleaned pair.
- `f685340e` (`knowledge-update`): grep_notes "weekly tennis" and "every other week" at local park; add both tennis sessions to capture prior vs current frequency.
- `a96c20ee` (`multi-session`): bm25_notes "Harvard University" "poster" "thesis research conference"; Harvard mention in the second gold session supplies the venue.
- `gpt4_61e13b3c` (`temporal-reasoning`): grep_notes "Farmers' Market" baked goods and "Spring Fling Market"; compare Feb 26 farmers-market sale to March 20 Spring Fling and count weeks between.
- `f685340e_abs` (`knowledge-update`, abstention): grep_notes "table tennis" returns nothing; tennis-only hits confirm sport mismatch—retrieve tennis sessions then abstain (no table-tennis evidence).
- `a96c20ee_abs` (`multi-session`, abstention): bm25_notes "undergrad course research poster" finds thesis/conference only; Harvard visit lacks undergrad-poster claim—abstain after confirming degree-level mismatch.
- `gpt4_65aabe59` (`temporal-reasoning`): grep_notes "smart thermostat" "month ago" vs "mesh network" "3 weeks ago"; thermostat setup predates mesh upgrade by ~1 week.
- `f9e8c073` (`knowledge-update`): bm25_notes "bereavement support group" "sessions"; take the later October recall (five sessions) over the May three-session count.
- `a9f6b44c` (`multi-session`): grep_notes "March" with "Pedal Power" "road bike serviced" "commuter" "tire replace"; add all three bike-maintenance sessions to count distinct bikes touched in March.
- `gpt4_68e94287` (`temporal-reasoning`): grep_notes "#FoodieAdventures" "vegan chili" and "#PlankChallenge"; chili post (Mar 9) precedes plank challenge (Mar 15).
- `aae3761f` (`multi-session`): bm25_notes "hours to drive" plus each destination (Outer Banks, Washington D.C., Tennessee mountains); add all three road-trip sessions and sum drive times (4+6+5).
- `gpt4_68e94288` (`temporal-reasoning`): grep_notes "#PlankChallenge" "social media challenge"; anchor question_date Mar 20 minus five days → Mar 15 plank session.
- `b3c15d39` (`multi-session`): bm25_notes "remote shutter release" "February 5" "February 10"; order and arrival dates in notes yield five-day delivery window.
- `gpt4_6dc9b45b` (`temporal-reasoning`): bm25_notes "Seattle International Film Festival" "SIFF"; single June 2021 session vs Oct 2021 question_date → ~4 months ago.
- `b5ef892d` (`multi-session`): grep_notes "camping trip" "days" "Yellowstone" "Big Sur"; add 5-day Yellowstone and 3-day Big Sur sessions; exclude the non-camping Utah road trip.

## Cross-cutting rules (generalist)

- Query concrete entities from the question (person names, venues, dollar amounts, hashtags, gear brands)—not abstract type labels like "knowledge-update" or "temporal-reasoning."
- When gold sessions have empty notes, seed bm25/grep from distinctive user-turn phrases visible in packs (ages, dollar figures, event names); do not assume notes exist.
- Multi-session arithmetic requires separate retrieval passes per entity, then add_sessions for each distinct gold hit before done (≤12 bag limit).
- Knowledge-update: always retrieve both the older and newer gold sessions; prefer the fact stated in the chronologically later session when values conflict.
- Temporal "which came first" and "how many days/weeks/months": retrieve both anchor events, use explicit session_date plus relative phrases in user turns ("yesterday," "last month," "N days ago") anchored to question_date.
- Relative-time questions ("5 days ago," "two weeks ago"): compute the target calendar window from question_date, then grep for the matching event rather than guessing from session order alone.
- Abstention: when the question swaps a key noun (sport, degree level, product) that never appears in notes or user turns, collect the nearest related evidence to confirm absence, then stop without inventing an answer session.
- Supersession cues ("shaved off a minute," "now I stay on Oahu," "beat my previous record") signal which session holds the outdated vs current value—follow the narrative direction of change.
- Frequency or duration composition across sessions: one session may hold baseline (40 hr/week) and another the modifier (+10 peak hours); both must be in the bag.
- Full-notes cases still benefit from targeted grep on the specific fact (egg count, shoe brand cleaned, delivery dates) rather than broad topical queries that return unrelated hits.

## Anti-patterns

- abstract label queries; done with empty bag; repeating the same query; answering instead of retrieving; stuffing unrelated hits
- retrieving only the newer session on knowledge-update questions and missing the superseded value (or vice versa—only the old value when the question asks for the current state)
- using the wrong temporal anchor (session date instead of question_date) for "N days/weeks ago" phrasing
- summing or merging facts from decoy nearby entities (Utah road trip into camping-day totals; thesis poster into undergrad-poster answers)
- stopping at the first sport/activity mention when the question names a different activity (tennis hits for a table-tennis question)
- single broad query ("Hawaii trip") when island-specific stay location changed between sessions
- treating duplicate maintenance mentions on one bike as multiple bikes serviced
