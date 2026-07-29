# Batch 07

## Coverage
- qids: 25
- by question_type: single-session-user 5, multi-session 4, single-session-preference 4, temporal-reasoning 4, knowledge-update 4, single-session-assistant 4
- notes_coverage: full 9, partial 16, none 0 (abstention 0)

## Per-qid paths
- `6ade9755` (`single-session-user`): Gold notes empty (studio name only in turns); notes-hop cannot surface gold — do not `done` on empty/unrelated bag; if non-gold notes mention yoga/studio, grep proper noun, else no-evidence via notes.
- `2e6d26dc` (`multi-session`): `bm25_notes("baby born twins friends family")` then `grep_notes` on baby/parent names (Ava/Lily, Jasper, Max, Charlotte); `add_sessions` all four birth/gift sessions before counting.
- `b0479f84` (`single-session-preference`): Gold notes empty (documentary titles/nature prefs only in turns); notes-hop miss — abstain rather than answer from genre stereotypes.
- `9a707b82` (`temporal-reasoning`): Gold notes empty; answer cue is baked chocolate cake for a friend near the question date — unreachable via notes index.
- `42ec0761` (`knowledge-update`): `bm25_notes("screwdriver laptop")` / grep `spare screwdriver` + `misplaced`; bag both states and keep the later spare-screwdriver update as current.
- `6ae235be` (`single-session-assistant`): Gold notes empty; refining-process answer is assistant-only — topic query `CITGO`/`Lake Charles` cannot retrieve via notes; no-evidence for notes-hop.
- `6b168ec8` (`single-session-user`): `bm25_notes("bikes own road mountain")` or grep `three bikes` / `Trek Emonda`; one gold session holds the count fact.
- `36b9f61e` (`multi-session`): `bm25_notes("luxury items splurge")` then grep brands/amounts (Gucci/$1,200, evening gown/$800, leather boots/$500); add all three; exclude budget/H&M distractors before summing.
- `b6025781` (`single-session-preference`): Gold notes empty (meal-prep / quinoa / lentil prefs in turns only); notes-hop cannot reach preference session.
- `a3045048` (`temporal-reasoning`): `bm25_notes("Shutterfly photo album best friend birthday")`; bag order-date session + party-date session; compute days between April 15 order and April 22 party.
- `45dc21b6` (`knowledge-update`): Gold notes empty; Emma recipe try-counts update across two sessions (2→3) — notes-hop miss; if notes existed, take chronologically latest count.
- `70b3e69b` (`single-session-assistant`): `bm25_notes`/`grep_notes` on Catalonia + literature/music / pro-Spanish keyphrases can find the session; singer-songwriter name is assistant-only (thin notes) — retrieve session, do not invent the name from notes.
- `6f9b354f` (`single-session-user`): Gold notes empty; bedroom “lighter shade of gray” only in turns — notes-hop no-evidence.
- `37f165cf` (`multi-session`): Gold notes empty; page counts (e.g. 416; Nightingale 440) live in turns across two sessions — cannot aggregate via notes-only hop.
- `caf03d32` (`single-session-preference`): `bm25_notes("slow cooker recipes yogurt vegan")`; add the slow-cooker preference session; reformulate from recipe nouns in hits, not “advice.”
- `a3838d2b` (`temporal-reasoning`): `bm25_notes("charity event Run for the Cure")` then grep other event titles (Dance for a Cause, Walk for Wildlife, golf tournament, Food for Thought, Bike-a-Thon); bag all dated events; count only those before the Run for the Cure anchor.
- `4b24c848` (`knowledge-update`): Gold notes empty; H&M tops count updates (3→5) — notes-hop miss; pattern would be brand+item grep and keep latest count.
- `7161e7e2` (`single-session-assistant`): Gold notes empty; Admon Sunday shift lives in assistant schedule output — notes-hop cannot recover.
- `726462e0` (`single-session-user`): Gold notes empty; “10% discount” / first purchase / clothing brand only in turns — no-evidence via notes.
- `3a704032` (`multi-session`): Gold notes empty; plant acquisitions scattered across care talks (peace lily+succulent, snake plant, etc.) — notes-hop cannot assemble the count.
- `d24813b1` (`single-session-preference`): Gold notes empty; baking prefs (chocolate/caramel, lemon poppyseed) only in turns — notes-hop miss for recommendation grounding.
- `af082822` (`temporal-reasoning`): Gold notes empty; Nordstrom friends-and-family sale dated relative to session (“yesterday”) — need session date math; unreachable via notes index.
- `4d6b87c8` (`knowledge-update`): Gold notes empty; to-watch list size updates (20→25) — notes-hop miss; latest numeric state wins if notes were present.
- `71a3fd6b` (`single-session-assistant`): `bm25_notes("Speyer tourism board contact")` finds the ask session via notes; phone number itself is assistant-only — bag the session, do not fabricate digits from thin notes.
- `7527f7e2` (`single-session-user`): Gold notes empty; designer handbag `$800` only in turns — notes-hop no-evidence (contrast with full-notes luxury multi-session items elsewhere).

## Cross-cutting rules (generalist)
- Query with concrete entities (proper nouns, product types, brands, event titles, dollar amounts), not abstract stems like “where,” “how many,” or “recommend.”
- On knowledge-update, retrieve every session that states the tracked slot and keep the chronologically latest value; bag prior states when needed for conflict resolution.
- On multi-session aggregates (counts, sums, lists), do not call `done` until every aspect session with a contributing fact is in the bag (≤12).
- On temporal questions, retrieve the anchor event and the compared dated fact(s), then compute; do not search only relative phrases (“couple of days ago,” “weeks ago”).
- If gold-bearing sessions have empty notes, notes tools cannot emit those IDs — abstain / no-evidence rather than stuffing unrelated hits or answering from world knowledge.
- For single-session-assistant asks, notes often hold only topic keyphrases or “user asked about X”; hop to that session, but treat missing answer payloads as thin-notes (do not invent assistant content).
- Preference questions: search the preference domain nouns present in user history (genre, appliance, cuisine), then add the preference-bearing session — not generic “suggestions” language.
- After a partial hit, reformulate the next `bm25_notes`/`grep_notes` from entities found in notes; never repeat the identical query.
- Use `grep_notes` for distinctive literals (names, brands, `$…`, event titles) when BM25 returns incomplete coverage.
- Filter distractors that share a topic but wrong category (budget vs luxury, owned-vs-acquired, unrelated list sizes) before finishing.
- Only `add_sessions` from the last search’s hit IDs; never invent session IDs; never `done` with an empty bag when the question expects evidence.

## Anti-patterns
- abstract label queries; done with empty bag; repeating the same query;
  answering instead of retrieving; stuffing unrelated hits
