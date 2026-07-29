# Batch 17
## Coverage
- qids: 25
- by question_type: multi-session 13, temporal-reasoning 12
- notes_coverage: full 4, partial 21, none 0
- abstention: 2 (`ba358f49_abs`, `gpt4_70e84552_abs`)
- gold-notes caveat: 21/25 packs have empty gold `notes_text` (partial); hop paths below assume facts/keyphrases/events mirror user-turn atoms when annotated — if gold stays empty in the notes index, treat as thin/no-evidence and do not invent.

## Per-qid paths
- `ba358f49` (`multi-session`, full): bm25/grep `Rachel`+`married`/`wedding` → add event session (married next year); pivot `years old`/`I am 32` (avoid tenure “five years”) → add age session → done (age+1).
- `gpt4_6ed717ea` (`temporal-reasoning`, partial): dual entity+item queries (`Luna`+`training pads`, `Max`+`dog bed`) → bag both purchase sessions → compare relative times (~month ago vs ~three weeks ago) → pads first; gold notes empty.
- `ba358f49_abs` (`multi-session`, abstention, partial): same Rachel-wedding + user-age atoms as sibling, but question needs Rachel’s age at user’s wedding — neither Rachel’s age nor user’s marriage is evidenced → gather what exists then abstain/no-evidence.
- `gpt4_70e84552` (`temporal-reasoning`, partial): query `fixed`/`fence` and `hoove`/`hoof`+`trimming` separately → bag both → order by relative offsets (three weeks vs two weeks before same-day sessions) → fence first; gold notes empty.
- `bb7c3b45` (`multi-session`, partial): grep/bm25 `Jimmy Choo` → add paid-price session ($200) then retail-price session ($500) → done with both atoms for savings; gold notes empty.
- `gpt4_70e84552_abs` (`temporal-reasoning`, abstention, partial): fence task is findable; `three cows`/`Peter` purchase is not in gold turns → after failed cow/Peter queries, abstain (do not substitute hoof-trim or “new cow soon”).
- `bc149d6b` (`multi-session`, partial): query `layer feed`/`50-pound` and `scratch grains`/`20 pounds` → bag both purchase sessions → sum weights in window; gold notes empty.
- `gpt4_74aed68e` (`temporal-reasoning`, partial): query `spark plugs`/`NGK` and `Turbocharged Tuesdays`/`auto racking` → add both “today” event sessions → day-delta from session dates; gold notes empty.
- `bf659f65` (`multi-session`, partial): fan-out purchase/download cues (`bought`+`EP`/`Midnight Sky`, `downloaded`+album/`Happier Than Ever`, signed `vinyl`/`Tame Impala`) across ≥3 sessions → count distinct albums/EPs acquired; gold notes empty.
- `gpt4_76048e76` (`temporal-reasoning`, partial): query `bike`+`February`/`repairs` and `Corolla`/`washed`+`February 27` → bag both → mid-February bike care precedes Feb 27 car wash; gold notes empty.
- `c18a7dc8` (`multi-session`, partial): retrieve graduation-age atom (`completed at the age of 25` / Berkeley) and current-age atom (`32-year-old`) in separate hops → subtract; avoid industry-tenure distractors; gold notes empty.
- `gpt4_78cf46a3` (`temporal-reasoning`, partial): query `lost`+`charger`/`gym` and `phone case`+`month ago` → bag both → compare relative ages (case ~1 month vs charger ~2 weeks) → case first; gold notes empty.
- `c2ac3c61` (`multi-session`, partial): query `completed`+`Coursera` (need the clarified “three courses”) and `completed`+`edX` (“two courses”) → bag both → sum totals; do not stop on vague “some courses”; gold notes empty.
- `gpt4_7a0daae1` (`temporal-reasoning`, full): bm25/grep `tennis racket`+`bought`/`online` then `received`/`new tennis racket` → add buy session + receive session → week delta from session dates / “today” events.
- `c4a1ceb8` (`multi-session`, partial): enumerate citrus mentions across cocktail sessions (`orange` bitters/sangria, `lemon` sangria, `lime` gimlet/daiquiri) via `cocktail`/`bitters`/`Sangria`/`lime` queries → bag all distinct-type sessions before counting types; gold notes empty.
- `gpt4_7abb270c` (`temporal-reasoning`, full): fan-out museum/exhibition names (`Science Museum`, `Museum of Contemporary Art`, `Metropolitan`, `Museum of History`, `Modern Art Museum`, `Natural History`) → add all six visit sessions → order by session/event dates; do not done after first museum hit.
- `cc06de0d` (`multi-session`, partial): query `taxi`+$ amount and `train fare`/`daily train` → bag both commute-cost sessions → subtract; gold notes empty.
- `gpt4_7bc6cf22` (`temporal-reasoning`, full): grep `New Yorker`+`March 15` → add read session; use session_date (“read … today”) vs question_date for days-ago (prefer session date over issue-date event tag).
- `d23cf73b` (`multi-session`, partial): fan-out cuisine cues (`Ethiopian`, `Indian`/`tikka masala`, `vegan cuisine` class, `Korean`/`bibimbap`) across four sessions → bag all before counting distinct cuisines tried/learned; gold notes empty.
- `gpt4_7ca326fa` (`temporal-reasoning`, partial): per-person graduation queries (`Emma`+`graduated`, `Rachel`+`graduation`, `Alex`+`graduated`) → bag three sessions → order by session/event times; gold notes empty.
- `d3ab962e` (`multi-session`, partial): query hike+distance+place (`Valley of Fire`/`3-mile`, `Red Rock`/`5-mile`) → bag both weekend-hike sessions → sum distances; gold notes empty.
- `gpt4_7ddcf75f` (`temporal-reasoning`, partial): query `whitewater`/`rafting`+`Oregon` → add session with “today” event → days-ago vs question_date; gold notes empty.
- `d6062bb9` (`multi-session`, partial): query `TikTok`+`views`/`Luna` and `YouTube`+`views`/`tutorial` → bag both platform sessions → sum most-popular view counts; gold notes empty.
- `gpt4_7de946e7` (`temporal-reasoning`, partial): query `persistent cough`/`February 10` and `skin tag`/`February 22` → bag both → cough date precedes skin-tag removal; ignore later pneumonia/flu distractors for “first”; gold notes empty.
- `d682f1a2` (`multi-session`, partial): fan-out delivery-service names (`Fresh Fusion`, `Domino's`, `Uber Eats`) → bag three sessions → count distinct services; gold notes empty.

## Cross-cutting rules (generalist)
- Split multi-operand questions into atom queries (entity+event, item+price, platform+metric, cuisine/name) and only `done` when every required atom is in the bag.
- For temporal “which first / how many days/weeks”, retrieve both (or all) event sessions, then compare session dates or explicit relative offsets — never answer from a single hit.
- Prefer concrete lexical anchors (proper names, product names, venue names, numerals with units) over abstract question nouns (`years`, `total`, `first`, `order`).
- After a partial hit, pivot to the missing operand’s pattern (age vs event; retail vs paid price; other platform; other person’s name) instead of synonym-expanding the same query.
- Enumeration questions (albums, courses, cuisines, citrus types, delivery apps, museums) need exhaustive fan-out across sessions; early `done` undercounts.
- Relative-time phrases (`today`, `next year`, `N weeks ago`, `about a month ago`) must be grounded to the hit’s `session_date` (and question_date for “days ago”).
- Distractor hygiene: tenure/duration, adjacent chores, later complications, and theme-neighbors without the missing atom must not fill the bag.
- Abstention: if a contrasted entity/event in the question never appears after targeted search, stop with no-evidence rather than substituting a related found event.
- When notes are empty/thin for gold, do not hallucinate sessions; keep querying distinctive user-turn atoms, and abstain if the index cannot surface them.
- Cap `add_sessions` to last-hit evidence sessions (bag≤12); thematic skincare/farm/music neighbors without required atoms are pollution.
- Keyphrase lists often omit sparse life facts (age, one-off purchases); grep facts/events or exact numerals when BM25 returns only topical filler.

## Anti-patterns
- abstract label queries; done with empty bag; repeating the same query;
  answering instead of retrieving; stuffing unrelated hits
