# Batch 10

## Coverage
- qids: 25
- by question_type: knowledge-update 5, multi-session 5, single-session-assistant 5, single-session-user 5, temporal-reasoning 5
- notes_coverage: full 7 / partial 18 / none 0
- gold-notes reachability: 8 packs have non-empty gold notes; 17 packs have empty gold notes (evidence only in user turns / assistant replies) so notes-hop cannot surface gold via bm25/grep
- abstention: 1 (`6aeb4375_abs`)

## Per-qid paths
- `95bcc1c8` (`single-session-user`): bm25/grep concrete cues `open mic` + `amateur comedians` → add the comedy/stand-up session → done (count=10 is in facts).
- `5a7937c8` (`multi-session`): no-evidence in notes (all 3 gold notes empty); would need Dec faith/church activity dates across sessions to sum distinct days — notes-hop cannot start.
- `d01c6aa8` (`temporal-reasoning`): bm25 `green card`/`EB-2`/`United States` → bag both gold sessions → combine age (32) with “living in US past five years” → age-at-move; done.
- `6a1eabeb` (`knowledge-update`): bm25/grep `charity 5K` / `personal best` → add both update sessions → keep latest PB (25:50 supersedes 27:12), not the earlier fact.
- `a40e080f` (`single-session-assistant`): bm25 `Triumvirate` / employee safety lands the session, but company names are assistant-only and absent from notes — thin-notes; retrieve session then expect answer gap unless raw transcript is read outside notes tools.
- `a06e4cfe` (`single-session-user`): bm25/grep `gin-to-vermouth` / `classic martini` → add cocktail session → done (3:1 in facts).
- `60036106` (`multi-session`): bm25 `Facebook ad` + grep `influencer`/`Instagram` → add both campaign sessions → sum reach (≈2000 ads + 10000 influencer), avoid double-counting the repeated 2000 fact.
- `dcfa8644` (`temporal-reasoning`): no-evidence in notes (gold empty); path would be Adidas purchase date + Converse lace-break date → day delta — unreachable via notes index.
- `6a27ffc2` (`knowledge-update`): no-evidence in notes; would retrieve Corey Schafer Python video-count updates and take latest (30 over 20) — notes-hop blocked.
- `ac031881` (`single-session-assistant`): no-evidence in notes; RPG/jumpsuit “designation” answer lives in interactive assistant turns — notes-hop cannot recover.
- `a82c026e` (`single-session-user`): no-evidence in notes; user-turn fact (beat Dark Souls last weekend) not annotated — cannot bm25/grep to gold.
- `60159905` (`multi-session`): bm25/grep `dinner party` + host names (Mike/Alex/Sarah) → add both sessions → count attended parties in past-month window (hosting plans ≠ attended).
- `e4e14d04` (`temporal-reasoning`): no-evidence in notes; need join date of Book Lovers Unite vs meetup date — notes-hop blocked.
- `6aeb4375` (`knowledge-update`): bm25/grep `Korean restaurants` → add both update sessions → take latest count (4 over 3); ignore cuisine-adjacent Indian/falafel noise.
- `b759caee` (`single-session-assistant`): no-evidence in notes; Instagram handle is assistant blog content from a thin user prompt — notes-hop cannot recover the handle.
- `ad7109d1` (`single-session-user`): no-evidence in notes; speed fact (500 Mbps) buried in battery-life chat user turns — cannot retrieve via notes.
- `60472f9c` (`multi-session`): no-evidence in notes; would union Data Mining + Database Systems projects and exclude thesis — notes-hop blocked.
- `eac54adc` (`temporal-reasoning`): no-evidence in notes; need website-launch session date vs first-client signing session → days-since-launch at signing — blocked.
- `6aeb4375_abs` (`knowledge-update`, abstention): empty gold notes; even in turns evidence is Korean (not Italian) restaurant counts — after cuisine-specific search finds no Italian try-count, abstain / done without stuffing Korean hits as answer evidence.
- `c4f10528` (`single-session-assistant`): no-evidence in notes; Bandung/Cihampelas/Nasi Goreng restaurant name comes from assistant recommendation (user later echoes Miss Bee) — notes empty, hop cannot index it.
- `af8d2e46` (`single-session-user`): no-evidence in notes; Costa Rica packing count (7 shirts) only in user turns — blocked.
- `60bf93ed` (`multi-session`): no-evidence in notes; need buy date (1/15) + arrive date (1/20) across two sessions — blocked on notes index.
- `eac54add` (`temporal-reasoning`): no-evidence in notes; “four weeks ago” milestone needs dated business event (launch vs first client) relative to question date — blocked.
- `71315a70` (`knowledge-update`): no-evidence in notes; ocean-sculpture hours update (5–6 → 10–12) would require latest-value merge — blocked.
- `c7cf7dfd` (`single-session-assistant`): no-evidence in notes; India fabric/store name is assistant-only recommendation — notes-hop cannot recover.

## Cross-cutting rules (generalist)
- Prefer entity+event lexical anchors from the question (race name, visa category, cuisine+restaurant, ad platform) over abstract labels (“update”, “milestone”, “activities”).
- For knowledge-update counts/times, always bag multiple matching sessions and keep the chronologically latest stated value; never stop at the first hit.
- For multi-session numeric aggregates, retrieve complementary facets (e.g. ad reach vs influencer reach; distinct attended events) then compose; de-dupe repeated restatements of the same number.
- Temporal deltas need both endpoint sessions (start event + later event) plus session/question dates; one-sided retrieval is insufficient.
- When the question asks what “you mentioned” (assistant recall), notes may only hold user-side cues — retrieve the cue session, but if the asked string is absent from notes, do not invent; treat as thin-notes failure.
- Cuisine/entity filters must match the asked type exactly (Italian ≠ Korean); near-miss cuisine sessions are distractors, not substitutes.
- Abstain when targeted evidence is missing after reasonable entity searches; do not answer from adjacent topic sessions in the bag.
- Prefer grep on rare proper nouns / numeric units (Mbps, 5K time, group name) when BM25 returns broad lifestyle chatter.
- `add_sessions` only from last hits; keep bag≤12; stop with `done` once complementary gold facets are covered — do not keep requerying the same string.
- Empty or near-empty notes on gold means notes-hop cannot succeed regardless of clever queries; recognize no-evidence early rather than looping.

## Anti-patterns
- abstract label queries; done with empty bag; repeating the same query;
  answering instead of retrieving; stuffing unrelated hits
