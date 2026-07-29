# Batch 11

## Coverage
- qids: 25
- by question_type: knowledge-update 5, multi-session 5, single-session-assistant 5, single-session-user 5, temporal-reasoning 5
- notes_coverage: full 4, partial 21, none 0
- abstention packs: 3 (`*_abs` / `is_abstention: true`)
- gold-notes empty on most partial packs: notes-hop must still use concrete entity/event queries that would match if user-turn facts were indexed; when gold notes stay empty, retrieval fails and the honest outcome is miss or abstain—not free-form answering

## Per-qid paths
- `b320f3f8` (`single-session-user`): grep/bm25 `thrift` + `action figure` / `Snaggletooth` → add single gold → done (empty gold notes today; cue is incidental aside in collectibles talk).
- `60bf93ed_abs` (`multi-session`, abstention): grep `iPad case` / `iPad`+`arrive`; only backpack delivery dates exist → no matching entity → done empty / abstain (do not answer from backpack latency).
- `f0853d11` (`temporal-reasoning`): grep exact event titles `Walk for Hunger` and `Coastal Cleanup` (or `March 7` / `February 21`) across two sessions → add both → done; subtract dated attendance events (not session timestamps alone).
- `72e3ee87` (`knowledge-update`): grep `Crash Course` + `Science` / `episodes`; retrieve earlier “on episode 10” and later “completed 50 episodes” → prefer latest completed count → add both for update chain → done.
- `c8f1aeed` (`single-session-assistant`): grep `Marcellus Shale` / `fracking`+`groundwater` → add topic session (notes have user stance, not the state name) → answer from assistant transcript after retrieve; do not invent state from notes alone.
- `b86304ba` (`single-session-user`): question says “painting of a sunset” but notes/turns only have `flea market find` + `worth triple`; bm25 `flea market` / `worth triple` / art valuation → add → done (avoid literal `sunset`/`painting` dead-end).
- `61f8c8f8` (`multi-session`): grep `5K` + time cues (`45 minutes`, `35 minutes`) → add prior-year and recent finish sessions → done; compute delta after both times are bagged.
- `gpt4_0a05b494` (`temporal-reasoning`): grep `farmer's market`/`jam` and `Australia`/`tourist`/`subway` → add both meet sessions → order by relative time phrases (“two weeks ago Saturday” vs “last Thursday”) against session dates → done.
- `7401057b` (`knowledge-update`): grep `Hilton` + `free night` / `points`; take later “two free night's stays” over earlier “single” → add both update sessions → done.
- `cc539528` (`single-session-assistant`): grep `front-end`+`back-end` / `full-stack` → add session → done; languages live in assistant turns only (empty/thin user notes)—retrieve then read transcript, do not answer from notes facts.
- `bc8a6e93` (`single-session-user`): grep `niece` + `birthday` / `lemon blueberry cake` → add → done (bake item is lemon blueberry cake).
- `6456829e` (`multi-session`): grep `tomato`+`planted` and `cucumber`+`plants` → add both garden sessions (5 tomatoes + 3 cucumbers) → sum → done.
- `gpt4_0b2f1d21` (`temporal-reasoning`): grep `coffee maker` (bought ~three weeks ago) and `stand mixer` (repair last month) → add both → order by relative spans in notes/events → done.
- `7a87bd0c` (`knowledge-update`): grep `daily tidying routine` / `tidying`+`weeks`; prefer later “4 weeks” over earlier “3 weeks” → add both → done.
- `ceb54acb` (`single-session-assistant`): user turns nearly content-free; grep seed phrase `sexual compulsions` if present in notes index, else topic synonyms for behavior-term brainstorming → add sharegpt session → four alternatives only in assistant transcript (notes-hop cannot extract answer text).
- `bc8a6e93_abs` (`single-session-user`, abstention): grep `uncle`+`birthday`/`bake`; evidence only for niece’s party → mismatch → done abstain (do not reuse niece bake answer).
- `6456829e_abs` (`multi-session`, abstention): grep `chili`/`chili peppers`+`plant`; tomatoes+cucumbers exist, chili plants do not → partial produce evidence insufficient → abstain.
- `gpt4_18c2b244` (`temporal-reasoning`): three parallel greps—`ShopRite`+`rewards`, `Luvs`/`BOGO`+`Walmart`, `Ibotta`+`Amazon gift card`—→ add all three dated event sessions → order by session/event dates → done.
- `7e974930` (`knowledge-update`): grep `Downtown Farmers Market` + earn/`$`; bag list-of-markets session and later “most recent visit…$420” → prefer explicit most-recent amount over older table rows → done.
- `d596882b` (`single-session-assistant`): grep `New York`+`vegan` / `vegetarian`+NYC food → add → done; multi-location eatery name is assistant-only—notes path stops at session retrieve.
- `c14c00dd` (`single-session-user`): grep `shampoo` / `Trader Joe`+`lavender` → add → done (brand cue is Trader Joe’s lavender shampoo).
- `67e0d0f2` (`multi-session`): grep `Coursera`+`completed` and `edX`+`courses` → add both (12 + 8) → sum total completed online courses → done; do not stop after one platform.
- `gpt4_1916e0ea` (`temporal-reasoning`): grep `FarmFresh` (cancel) and `Instacart` (order “today”) → add both → day-delta using event/session dates (cancel lacks intra-turn calendar day; use session date + Instacart “today”) → done.
- `830ce83f` (`knowledge-update`): grep `Rachel`+`moved`/`Chicago` then later `suburbs`; prefer latest relocation (“moved back to the suburbs”) over earlier Chicago apartment → add both → done.
- `dc439ea3` (`single-session-assistant`): grep `powwow`+`traditional games` / Native American powwow → add → done; named game is assistant-recommended—thin notes, transcript after retrieve.

## Cross-cutting rules (generalist)
- Prefer **concrete nouns** from the question (product, event title, person, platform, place) over abstract frames (“how long”, “how many”, “what type”); follow with a second hop on a synonym if the first bag is empty.
- For **knowledge-update**, always retrieve ≥2 chronological mentions of the same attribute and keep the **latest** stated value; bag both so the answerer can see the update, not only the winner.
- For **multi-session aggregates** (sums, deltas, totals across platforms/crops/races), issue parallel entity queries and refuse `done` until every conjunct in the question has a hit or a justified miss.
- For **temporal order / day-count**, retrieve each named event with its own proper-noun grep, then compare **event-relative dates** inside notes/turns (or session dates when the turn only says “today”), never invent a delta from one session.
- For **single-session-assistant** recall, treat notes as a **topic index** only: hop until the prior Q&A session is in the bag, then read assistant content; do not expect answer strings in user facts/keyphrases.
- When question surface form **mismatches** indexed wording (e.g. descriptive object vs “flea market find”), reformulate to valuation/ownership/event paraphrases instead of repeating the failed literal query.
- **Abstention**: after targeted greps for the asked entity/relation fail, or only a near-miss sibling entity appears (niece≠uncle, cucumber≠chili, backpack≠iPad case), call `done` without stuffing unrelated hits; never answer from analogous evidence.
- Cap the bag (≤12): add only sessions that matched the current entity/event query; drop topical neighbors that lack the asked slot.

## Anti-patterns
- abstract label queries; done with empty bag; repeating the same query;
  answering instead of retrieving; stuffing unrelated hits
- answering knowledge-update from the first chronological hit
- treating near-miss entities as substitutes on abstention items
- expecting assistant recommendations to appear in user-note facts
- literal-only greps when notes paraphrase the object
- computing temporal deltas without both event endpoints in the bag
