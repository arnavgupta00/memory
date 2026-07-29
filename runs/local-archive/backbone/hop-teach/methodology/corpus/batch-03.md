# Batch 03

## Coverage
- qids: 25
- by question_type: knowledge-update 4, multi-session 4, single-session-assistant 4, single-session-preference 4, single-session-user 5, temporal-reasoning 4
- notes_coverage: full 7 / partial 18 / none 0
- abstention packs: 2 (`*_abs`); gold `has_notes=True` on only the 7 full-coverage packs (rest: empty gold notes — facts live in raw user turns or assistant text)

## Per-qid paths
- `21436231` (`single-session-user`): empty gold notes — notes-hop cannot surface “12 largemouth bass / Lake Michigan”; no-evidence via bm25/grep; fact only in raw user turns.
- `10d9b85a` (`multi-session`): empty gold notes — cannot hop; need both April attendance sessions (2-day workshop + 1-day lecture) from user turns; do not invent a conference day.
- `1c0ddc50` (`single-session-preference`): empty gold notes — cannot hop; commute+podcast preference (history/science, ~40 min) only in user turns.
- `2ebe6c92` (`temporal-reasoning`): `bm25_notes("just finished book novel")` → `add` finish session (~2023/01/31, Nightingale) → `grep` title → `add` start sibling → `done` (align session_date ≈ 1 week before Q).
- `0ddfec37` (`knowledge-update`): `bm25_notes("autographed baseballs collection")` → `add` both count sessions → keep latest tally (15→20) by session_date → `done`.
- `28bcfaac` (`single-session-assistant`): empty notes; answer is assistant-recommended site (user only echoes MusicTheory.net) — notes-hop thin/no recoverable assistant content.
- `25e5aa4f` (`single-session-user`): `bm25_notes("completed undergrad CS Bachelor Computer Science")` → bridge Bachelor’s↔undergrad → `add` UCLA completion session → `done` (avoid Master’s/Stanford noise).
- `1192316e` (`multi-session`): empty gold notes — cannot hop; need get-ready (~1 hr) + commute (~30 min) sessions from user turns, then sum.
- `1d4e3b97` (`single-session-preference`): `bm25_notes("bike chain cassette replacement performance")` → `add` Feb-1 maintenance session → `done` (cause of better Sunday rides).
- `370a8ff4` (`temporal-reasoning`): empty gold notes — cannot hop; need flu-recovery session_date + “10th jog outdoors” session_date delta from user turns.
- `0ddfec37_abs` (`knowledge-update`, abstention): ask autographed *football*; near-miss baseball collection only — retrieve if notes existed then abstain on entity mismatch; here notes empty + wrong sport → abstain.
- `2bf43736` (`single-session-assistant`): empty notes; Tanqueray chapter answer is assistant-side — user asks which chapter; notes-hop cannot recover.
- `29f2956b` (`single-session-user`): empty gold notes — cannot hop; “practicing guitar 30 minutes daily” only in user turns.
- `129d1232` (`multi-session`): `bm25_notes("charity raised $ walk Bike-a-Thon yoga")` → `add` all three raise sessions ($250 / $5,000 / $600) → keep hopping until inventory complete → `done`.
- `1da05512` (`single-session-preference`): empty gold notes — cannot hop; NAS buy-now deliberation only in user turns.
- `4dfccbf7` (`temporal-reasoning`): empty gold notes — cannot hop; need ukulele-lessons start + acoustic-guitar tech-service session dates from user turns for day delta.
- `0e4e4c46` (`knowledge-update`): empty gold notes — cannot hop; Ticket to Ride high-score updates (124→132) only in user turns; prefer latest by session_date.
- `3249768e` (`single-session-assistant`): empty notes; fifth gin-bar bottle is assistant recommendation — notes-hop cannot recover.
- `29f2956b_abs` (`single-session-user`, abstention): ask *violin* practice time; evidence is guitar — after near-miss music-practice hit, abstain (instrument mismatch); notes empty.
- `157a136e` (`multi-session`): empty gold notes — cannot hop; need user age (~32) + grandma’s 75th from two sessions, then subtract.
- `32260d93` (`single-session-preference`): `bm25_notes("stand-up comedy Netflix specials storytelling")` → `add` Mulaney/Kid Gorgeous preference session → `done` (recommend from stated taste, not generic shows).
- `4dfccbf8` (`temporal-reasoning`): `grep_notes(["Rachel"])` → `add` Wed ukulele-with-Rachel session → bridge Taylor/Joe music cues for companion → align session_date ≈ two months before Q → `done`.
- `0f05491a` (`knowledge-update`): empty gold notes — cannot hop; Starbucks Gold-level star threshold updates (125→120) only in user turns; prefer latest.
- `352ab8bd` (`single-session-assistant`): empty notes; HAMT framerate figure is assistant/paper content — notes-hop cannot recover.
- `311778f1` (`single-session-user`): empty gold notes — cannot hop; “10 hours … Netflix documentaries last month” only in user turns.

## Cross-cutting rules (generalist)
- If gold notes are empty, do not pretend BM25 will find the answer: treat as no-evidence / thin-notes and avoid `done` with an empty bag.
- Knowledge-update: retrieve every session mentioning the same tracked metric/entity, order by `[session_date]`, answer with the latest value—not the first hit.
- Abstention twin: when the asked entity differs from indexed evidence (sport, instrument, product), surface the near-miss then abstain; do not substitute the closest noun.
- Temporal “N ago” / “what with X on day D”: prefer event verbs + person/object proper nouns, then verify `[session_date]` (and `(today)` event hints) against the question’s relative window.
- Multi-session sums/totals: keep hopping after the first numeric hit until all additive facets are in the bag; one charity/attendance session is not the total.
- Preference questions: search for the user’s stated habits/likes (commute listening, comedy specials, bike maintenance cause), not open-ended “recommend activities/shows” abstract labels.
- Education / biography: query question surface forms plus note synonyms (Bachelor’s↔undergrad, Computer Science↔CS); ignore louder adjacent life-stage chatter (Master’s applications).
- After a concrete proper noun appears in hits (book title, person, event brand), `grep_notes` that token to pull sibling sessions before stopping.
- Single-session-assistant recall: notes index user-derived facts only—assistant-only answers (URLs, chapter IDs, bottle lists, paper metrics) are often invisible; do not invent IDs or answer from the question text.
- `add_sessions` only IDs from the last search hits; reformulate once if the first query is topic-adjacent noise, then stop when coverage is met.

## Anti-patterns
- abstract label queries; done with empty bag; repeating the same query;
  answering instead of retrieving; stuffing unrelated hits
