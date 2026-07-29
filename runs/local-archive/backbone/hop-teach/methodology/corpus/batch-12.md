# Batch 12

## Coverage
- qids: 25
- by question_type: knowledge-update 5, multi-session 5, single-session-assistant 5, single-session-user 5, temporal-reasoning 5
- notes_coverage: full 5 / partial 20 / none 0
- abstention: 0

## Per-qid paths
- `c19f7a0b` (`single-session-user`): gold notes empty; answer in user turn (“usually get home … around 6:30 pm on weekdays”) — notes-hop cannot land; if annotated, grep/bm25 `get home from work` / `6:30` / weeknight schedule, add once, done.
- `681a1674` (`multi-session`): gold notes empty; need both re-watch mentions (Endgame + Spider-Man: No Way Home; also “four Marvel movies”) — thin notes; if present, grep `re-watched`/`Marvel`/`Endgame`/`Spider-Man`, bag both sessions, done for count.
- `gpt4_1a1dc16d` (`temporal-reasoning`): gold notes empty; compare dated events (Rachel meeting Apr 10 vs pride parade May 1) — thin notes; if present, grep `Rachel` + `pride parade` / date phrases, add both, order by event dates not session timestamps.
- `852ce960` (`knowledge-update`): full notes; bm25/grep `Wells Fargo` + `pre-approved` / `$350,000`; later session updates to `$400,000` — prefer earlier mortgage pre-approval fact for “when I got my mortgage,” keep both if update contrast needed, done.
- `e3fc4d6e` (`single-session-assistant`): gold notes empty; entity lives in user-pasted article (Dr. Arati Prabhakar) — thin notes / assistant-adjacent; if notes had NER, grep `Chief Advisor` / `Prabhakar` / `Lawrence Livermore`, else cannot reach via notes.
- `c5e8278d` (`single-session-user`): full notes; grep `old last name` / `Johnson` / `name change` / `Winters`, add session, done (avoid DMV/credit-update distractors).
- `6c49646a` (`multi-session`): gold notes empty; sum needs Yellowstone 1,200 mi + prior three trips totaling 1,800 mi — thin notes; if present, grep `miles`/`road trips`/`Yellowstone`/`1,800`, bag both, done.
- `gpt4_1d4ab0c9` (`temporal-reasoning`): gold notes empty; span from “started watering my herb garden … today” to “harvested my first batch … today” — thin notes; if present, grep `herb garden`/`watering`/`harvested`, add both, diff session/event dates.
- `89941a93` (`knowledge-update`): partial/full-ish notes on gold; early “currently have three bikes” then later “four bikes” + new hybrid — grep `currently have`/`four bikes`/`hybrid bike`, prefer latest ownership count, bag both for update, done.
- `e48988bc` (`single-session-assistant`): gold notes empty; company name echoed in user turn (Patagonia) after assistant example — thin notes; if annotated, grep `Patagonia`/`supply chain`/`environmentally responsible`, else notes-hop fails.
- `c8c3f81d` (`single-session-user`): gold notes empty; favorite brand in user turn (Nike running shoes) — thin notes; if present, grep `Nike`/`favourite brand`/`running shoes`, add, done.
- `6cb6f249` (`multi-session`): gold notes empty; sum week-long mid-Jan break + 10-day mid-Feb break — thin notes; if present, grep `social media`/`break`/`week-long`/`10-day`, bag both, done.
- `gpt4_1d80365e` (`temporal-reasoning`): gold notes empty; duration from “started … Yosemite … today” to “got back from … Yosemite … today” — thin notes; if present, grep `Yosemite`/`solo camping`, add both, diff dates.
- `89941a94` (`knowledge-update`): full notes; before gravel/hybrid purchase, grep `road bike` + `mountain bike` + `commuter` / `three bikes` on earlier session; confirm later four-bike list includes road bike as the extra type, done.
- `e8a79c70` (`single-session-assistant`): gold notes empty; egg count is assistant recipe content, not user facts — notes-hop cannot recover quantity; topic grep `French omelette` only finds the session if keyphrases exist, answer still missing from notes.
- `c960da58` (`single-session-user`): gold notes empty; “I have 20 playlists on Spotify” in user turn — thin notes; if present, grep `playlists`/`Spotify`/`20 playlists`, add, done.
- `6d550036` (`multi-session`): full notes; facet search ownership — grep `I led`/`solo project`/`presented a poster`/`case competition`, selectively add all four gold workstreams, done on aspect coverage (not question-echo “projects led”).
- `gpt4_1e4a8aeb` (`temporal-reasoning`): gold notes empty; workshop day vs “planted 12 new tomato saplings today” — thin notes; if present, grep `gardening workshop`/`tomato saplings`, add both, diff dates.
- `8fb83627` (`knowledge-update`): gold notes empty; early “finished my third issue” vs later “finished five issues” of National Geographic — thin notes; if present, grep `National Geographic`/`finished`/`issues`, prefer latest finished count, bag both, done.
- `e9327a54` (`single-session-assistant`): gold notes empty; dessert-shop name is assistant recommendation (user only asks about milkshakes/Orlando) — notes-hop cannot read assistant answer; topic cues alone insufficient.
- `caf9ead2` (`single-session-user`): gold notes empty; “took me and my friends around 5 hours to move” (ignore 2-hour parents drive / 20-minute commute) — thin notes; if present, grep `hours to move`/`new apartment`, add, done.
- `7024f17c` (`multi-session`): gold notes empty; last-week evidence is thin (30-minute Saturday jog; yoga mostly habitual/planned, not clear last-week hours) — retrieve jog + yoga sessions via `jog`/`yoga`/`hours`, but may lack additive last-week total in notes; avoid stuffing old “3×2 hours” habit as last-week fact.
- `gpt4_1e4a8aec` (`temporal-reasoning`): gold notes empty; relative “two weeks ago” vs question_date — need dated gardening activities (workshop vs planting); thin notes; if present, grep `gardening workshop`/`tomato`/`planted`, bag candidates, pick by date offset, done.
- `945e3d21` (`knowledge-update`): gold notes empty; early “yoga twice a week” vs later “yoga classes … three times a week” — thin notes; if present, grep `yoga`/`times a week`/`anxiety`/`self-care`, prefer latest frequency, bag both, done.
- `e982271f` (`single-session-assistant`): notes have Portland/indie venue keyphrases only — can retrieve topic session via bm25 `Portland indie venues`, but last venue name is assistant list content absent from notes; stop with session in bag or abstain on the name.

## Cross-cutting rules (generalist)
- Prefer concrete entity/quantity/date greps (`Wells Fargo`, `National Geographic`, `Yosemite`, `playlists on Spotify`) over abstract question paraphrases (“how many”, “how often”, “remind me”).
- For knowledge-update / “currently” questions, retrieve both old and new states, then keep the latest ownership/frequency/amount; do not stop at the first matching number.
- For multi-session totals, bag every distinct evidence facet (each trip, break, re-watch, project) before summing; selective `add_sessions`, never fill from generic noun hits.
- For temporal compare/span questions, land both event-bearing sessions with dated phrases, then order/diff by event dates inside notes/turns—not by which session BM25 ranked first.
- After one hit, pivot synonyms/facets (`road bike` vs `hybrid`, `poster`/`solo project`/`case competition`, `re-watched` titles) instead of repeating the same query.
- Treat assistant-recall questions as high thin-notes risk: user turns may only hold the topic; if notes lack the named entity/quantity, do not invent—retrieve the topical session if possible, else abstain.
- When gold notes are empty, notes-hop cannot surface the session; do not loop identical bm25/grep—declare no-evidence rather than `done` with an empty bag.
- Disambiguate nearby quantities (commute minutes, parents’ drive, seller credits) by matching the question’s predicate (`hours to move`, `pre-approved`, `finished … issues`).

## Anti-patterns
- abstract label queries; done with empty bag; repeating the same query;
  answering instead of retrieving; stuffing unrelated hits
