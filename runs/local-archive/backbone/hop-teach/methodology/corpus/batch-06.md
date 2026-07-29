# Batch 06

## Coverage
- qids: 25
- by question_type: knowledge-update 4, multi-session 4, single-session-assistant 4, single-session-preference 4, single-session-user 5, temporal-reasoning 4
- notes_coverage: full 13 / partial 12 / none 0
- abstention: 2

## Per-qid paths
- `58bf7951` (`single-session-user`): full notes; grep/bm25 `community theater` / `Glass Menagerie` / `attended a production`, add once, done — prefer attended play over `The Crucible` audition distractor.
- `2788b940` (`multi-session`): gold notes empty; weekly class map lives in user turns (BodyPump Mon, Zumba Tue/Thu, yoga Sun, Hip Hop Abs Sat) — thin notes; if present, grep class names/weekdays, bag all four facets, done for typical-week count.
- `8a2466db` (`single-session-preference`): gold notes empty; tool preference is Adobe Premiere Pro / Lumetri Color in user turns — thin notes; if present, grep `Premiere Pro`/`Lumetri`/`video editing`, add preference session, done.
- `982b5123` (`temporal-reasoning`): gold notes empty; SF Airbnb booked “three months in advance” + Haight-Ashbury wedding stay — thin notes; if present, grep `Airbnb`/`Haight-Ashbury`/`three months in advance`, bag booking + SF context, compute months-ago from question_date.
- `2698e78f_abs` (`knowledge-update`): abstention; gold notes empty; evidence names Dr. Smith with conflicting weekly/biweekly cadence and never Dr. Johnson — after `Dr. Johnson`/`Dr. Smith` greps fail to support the asked clinician, abstain (do not substitute Smith).
- `5809eb10` (`single-session-assistant`): full notes carry case facts including “construction … began in 2014”; grep `Bajimaya`/`Reward Homes`/`construction began`, add, done (answer is in user-side case paste, not thin assistant-only).
- `58ef2f1c` (`single-session-user`): full notes; grep `Love is in the Air`/`fundraising dinner`/`volunteered`/`Valentine's Day`/`February`, add, done — exclude forward-looking `Strut Your Mutt`.
- `28dc39ac` (`multi-session`): full notes; gather distinct playtime facts (`70 hours` Odyssey, `25`/`30 hours` Last of Us difficulties, `5 hours` Hyper Light Drifter, `10 hours` Celeste) via bm25 `hours`/`finished`/`completed` + title greps, bag all five golds, sum without double-counting the same playthrough, done.
- `95228167` (`single-session-preference`): full notes; guitar upgrade prefs Stratocaster→Les Paul, open D, coil-tap — grep `Les Paul`/`Stratocaster`/`open D`/`guitar`, add preference session, done.
- `982b5123_abs` (`temporal-reasoning`): abstention; gold notes empty; only San Francisco Airbnb/Haight-Ashbury evidence — grep `Sacramento` should miss; do not answer with SF booking date; abstain.
- `26bdc477` (`knowledge-update`): gold notes empty; early “three trips” vs later “five trips” with Canon EOS 80D — thin notes; if present, grep `Canon EOS 80D`/`trips`, bag both update states, prefer latest count, done.
- `58470ed2` (`single-session-assistant`): gold notes empty; Borges center/circumference quote is assistant essay content and user turn is nearly empty — notes-hop cannot recover the quote; topic `Library of Babel` alone insufficient.
- `5d3d2817` (`single-session-user`): full notes; previous occupation “marketing specialist” at a startup — grep `previous role`/`marketing specialist`/`startup`, add, done — do not answer with current “senior marketing analyst”.
- `2b8f3739` (`multi-session`): gold notes empty; three market earnings ($225 jam, $120 herbs, 20×$7.5 plants) in user turns — thin notes; if present, grep `sold`/`market`/`earning`/`jars`/`bunches`, bag all three sale sessions, sum, done.
- `a89d7624` (`single-session-preference`): full notes; Denver music prefs (Killers, Red Rocks, Ship Rock Grille) — grep `Denver`/`Red Rocks`/`The Killers`/`Ship Rock Grille`, add preference session, done.
- `993da5e2` (`temporal-reasoning`): gold notes empty; “new area rug … a month ago” vs “rearranged the furniture three weeks ago” — thin notes; if present, grep `area rug`/`rearranged`/`furniture`, bag both relative anchors, compute intervening duration, done.
- `3ba21379` (`knowledge-update`): full notes; early Ford Mustang Shelby GT350R then switched to Ford F-150 pickup — grep `Mustang`/`Shelby`/`F-150`/`model`, bag both, prefer latest “currently working on”, done.
- `6222b6eb` (`single-session-assistant`): notes are keyphrases-only (`SIAC_GEE`, `Sen2Cor`, `6S`, `MAJA`); grep those tokens to land the topic session, but which algorithm SIAC_GEE implements is likely assistant-side — retrieve session; if notes lack the binding, do not invent.
- `60d45044` (`single-session-user`): gold notes empty; “favorite Japanese short-grain rice” in user turn — thin notes; if present, grep `short-grain`/`Japanese`/`favorite`/`rice`, add, done.
- `2ce6a0f2` (`multi-session`): full notes; four dated art attendances (Women in Art, Art Afternoon, History Museum tour, Evolution of Street Art lecture) — bm25 attendance+art nouns then grep event titles/dates, bag all four, exclude Met/workshop plans, done.
- `afdc33df` (`single-session-preference`): full notes; kitchen-cleanliness prefs (utensil holder, garbage disposal, faucet/counter care) — grep `kitchen`/`utensil holder`/`garbage disposal`/`granite`, add preference session, done.
- `9a707b81` (`temporal-reasoning`): gold notes empty; baking class “yesterday” (culinary school) plus later friend’s birthday cake bake — thin notes; if present, grep `baking class`/`culinary school`/`birthday`/`cake`, bag both, measure days from class date to question_date, done.
- `41698283` (`knowledge-update`): full notes; earlier `50mm prime` vs later `70-200mm zoom` purchases — bm25/grep `lens`/`50mm`/`70-200mm`, bag both episodes, pick most recent by session/event date (ignore wide-angle considerations), done.
- `65240037` (`single-session-assistant`): gold notes empty; dilution ratio is assistant advice; user only asks about tea tree oil application — notes-hop cannot recover the ratio; topic grep `tea tree oil`/`dilute` finds session only if annotated, still answer-thin.
- `66f24dbb` (`single-session-user`): full notes; sister’s birthday gifts yellow dress + matching/pearl silver hoop earrings — grep `sister's birthday`/`yellow dress`/`earrings`, add, done — exclude mom/coworker/Mrs. Johnson gift lists.

## Cross-cutting rules (generalist)
- Prefer concrete entity/title/quantity greps (`Glass Menagerie`, `Canon EOS 80D`, `Les Paul`, `F-150`, dollar/hour amounts) over abstract question paraphrases (“what play”, “how many”, “remind me”).
- For knowledge-update / “currently” / “most recently” questions, retrieve every candidate state (old + new), then resolve by latest session or event date—never `done` on the first matching item.
- For multi-session totals (hours, earnings, class counts, event counts), bag every distinct evidence facet before aggregating; keep searching after the first hit.
- For temporal questions, land both anchoring sessions (booking vs trip, rug vs rearrange, class vs cake) and compute from dated or relative phrases—not from BM25 rank order alone.
- On abstention items, verify the asked entity/place is absent (wrong clinician name, wrong city) after targeted greps; do not answer with a near-miss sibling fact.
- Preference questions: retrieve the session with stated tool/place/product likes, then stop—do not stuff generic recommendation chatter.
- Assistant-recall is high thin-notes risk: if notes only have topic keyphrases (or are empty), retrieve the topical session when possible but abstain on quantities/quotes that never appear in user-derived notes.
- When gold notes are empty, notes-hop cannot surface those sessions; after one failed entity grep + one synonym reformulation, declare no-evidence rather than looping or `done` with an empty bag.
- Disambiguate same-topic distractors by predicate: attended play ≠ audition; previous occupation ≠ current title; purchased lens ≠ “considering” wide-angle; volunteered dinner ≠ future charity event.

## Anti-patterns
- abstract label queries; done with empty bag; repeating the same query;
  answering instead of retrieving; stuffing unrelated hits
