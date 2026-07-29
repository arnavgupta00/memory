# Batch 02
## Coverage
- qids: 25
- by question_type: knowledge-update 4, multi-session 4, single-session-assistant 4, single-session-preference 4, single-session-user 5, temporal-reasoning 4
- notes_coverage: full 6, partial 19, none 0
- abstention: 3

## Per-qid paths
- `15745da0_abs` (`single-session-user`, abstention): grep/bm25 `vintage films` / film-collection duration — gold only discusses vintage *cameras* (and related hobbies) with empty notes; after related hobby hits, abstain (entity mismatch: films ≠ cameras).
- `09ba9854` (`multi-session`): bm25/grep `airport train $` / `Narita train hotel` then `taxi airport hotel $60` across two sessions; bag both price sessions and subtract (train ~$10 vs taxi ~$60); gold notes empty — rely on user-turn facts if indexed.
- `0a34ad58` (`single-session-preference`): bm25 `Tokyo Suica` / `Park Hyatt Tokyo` / `nervous trip Tokyo`; add the Tokyo-travel preference session (transit, Suica, TripIt anxiety cues) then done.
- `0db4c65d` (`temporal-reasoning`): grep `Seven Husbands of Evelyn Hugo` + `Silent Patient` / `book reading event local library`; bag finish-read and library-event sessions; delta session/event dates (finish → event).
- `07741c44` (`knowledge-update`): grep `old sneakers` / `under my bed` vs later `shoe rack`; bag both update sessions and take the *initial* location (under bed); empty gold notes.
- `1903aded` (`single-session-assistant`): bm25 `work from home jobs seniors`; add that brainstorm session — 7th list item is assistant-side, so notes are thin; retrieve session then read transcript, not notes alone.
- `19b5f2b3` (`single-session-user`): grep/bm25 `Japan` + `two weeks` / `solo trip Japan`; add duration-bearing Japan-travel session; empty gold notes.
- `09ba9854_abs` (`multi-session`, abstention): same airport-transport hops as train/taxi prices; no *bus* fare in evidence — bag transport sessions then abstain (asked bus savings; only train+taxi priced).
- `0edc2aef` (`single-session-preference`): bm25 `hotel` + preference cues (`hot tub`, `view`, `rooftop`) / `Edgewater`; gold is Seattle hotel prefs for a Miami ask — retrieve preference session for transfer, not a Miami place-name hit.
- `2a1811e2` (`temporal-reasoning`): grep `Holi` / `February 26` and `St. Mary's` / `March 19`; bag both dated event sessions; day-delta between embedded dates; empty gold notes.
- `07741c45` (`knowledge-update`): same `old sneakers` dual-session path as sibling update; prefer *latest* storage mention (shoe rack in closet) for “currently”; empty gold notes.
- `1b9b7252` (`single-session-assistant`): bm25/grep `mindfulness` / `guided imagery` / `Mountain Meditation` / `Body Scan`; add mindfulness-resources session — website name is assistant-side (thin notes).
- `19b5f2b3_abs` (`single-session-user`, abstention): search `Korea` / `Seoul` duration; evidence only has Japan “two weeks”, Korea is aspirational — abstain after confirming no Korea stay length.
- `0a995998` (`multi-session`): bm25/grep `dry cleaning` / `navy blue blazer`, `return boots Zara`, `pick up`; bag all clothing pick-up/return sessions and sum distinct items; empty gold notes.
- `195a1a1b` (`single-session-preference`): bm25 `evening` / `meditation` / `Headspace` / schedule prefs (`productive`, `structured`); add time-management/evening-activity preference session.
- `2c63a862` (`temporal-reasoning`): grep `Rachel` real-estate + `started working` `2/15` and `house I love` / `March 1`; bag agent-start and loved-house sessions; day-delta; empty gold notes.
- `08e075c7` (`knowledge-update`): grep `Fitbit Charge 3`; bag both duration-claim sessions (6 months vs 9 months) and use the *updated/latest* tenure for “how long have I been using”; empty gold notes.
- `1d4da289` (`single-session-assistant`): bm25/grep `data privacy` / `data security` / `passwords`; add privacy session — 2FA method list is assistant-side while notes only hold user hassle attitudes (thin for answer span).
- `1e043500` (`single-session-user`): grep/bm25 `Spotify` / `playlist` / `Summer Vibes`; add playlist-naming session; empty gold notes.
- `0ea62687` (`multi-session`): grep `miles per gallon` / `30` and later `28`; bag both MPG sessions and subtract (was 30, now 28); empty gold notes.
- `1a1907b4` (`single-session-preference`): bm25 `Hendrick's gin` / `Pimm's Cup` / `cocktail`; add mixology preference session (likes Pimm's twist, cucumber, grapefruit syrup) then done.
- `2ebe6c90` (`temporal-reasoning`): grep `Nightingale` `Kristin Hannah` start vs finished; bag both reading sessions; delta session/event dates (start→finish); notes present on golds.
- `0977f2af` (`knowledge-update`): grep `Instant Pot` and `Air Fryer`; bag both gadget sessions and take the *prior* purchase (Instant Pot before Air Fryer); empty gold notes.
- `1de5cff2` (`single-session-assistant`): bm25 `high-end fashion` / `sustainability` / `wild rubber` / `Amazon rainforest`; add fashion-brands session — brand name is assistant-side (thin notes).
- `1faac195` (`single-session-user`): grep `Emily` / `sister Emily`; add person→place session (Emily in Denver) then done.

## Cross-cutting rules (generalist)
- Prefer concrete entities, titles, product names, and proper nouns from the question over abstract labels (“tips”, “jobs”, “activities”).
- Multi-value or compare/subtract questions need **all** complementary sessions in the bag before done (two prices, two MPGs, two dates, multiple pickups).
- Temporal “how many days” paths: retrieve each named event/state with date-bearing queries, then compute from note events or session dates—do not answer from a single hit.
- Knowledge-update: retrieve the full update chain; map question tense/adverb (“initially”, “currently”, “before X”, “how long have I been”) onto earlier vs later facts, not a random mention.
- Abstention: after related-topic retrieval, require the **asked entity/modality** to appear in evidence (films vs cameras, bus vs train, Korea vs Japan); close cousins are not enough.
- Preference asks: retrieve sessions with stable likes/constraints/tools (Suica, gin brand, schedule/meditation habits), even if the question’s city/surface form differs.
- Single-session-assistant recalls: search user-side topic anchors to find the session, then expect the answer span in assistant turns—notes alone are often insufficient.
- When gold notes are empty/partial, lexical targets still come from user-turn fact shapes (quoted prices, “two weeks”, gadget names); if those never appear in the notes index, note-hop cannot recover—avoid fabricating sessions.
- After useful search hits, `add_sessions` from last hits (bag ≤12) before `done`; never done on an empty bag.
- Reformulate rather than repeat: swap bm25↔grep, tighten to a second entity, or split multi-hop aspects across queries.

## Anti-patterns
- abstract label queries; done with empty bag; repeating the same query;
  answering instead of retrieving; stuffing unrelated hits
- treating near-miss entities as sufficient (wrong medium, country, or transport mode) instead of abstaining
- stopping after one temporal/knowledge-update endpoint when the question needs a pair
- querying only the question’s new city/product while ignoring preference/update anchors in notes
- expecting assistant list/URL/brand answers to appear as USER note facts
