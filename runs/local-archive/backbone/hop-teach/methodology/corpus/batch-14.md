# Batch 14

## Coverage
- qids: 25
- by question_type: knowledge-update 7, multi-session 7, temporal-reasoning 7, single-session-user 4
- notes_coverage: full 6 / partial 19 / none 0
- abstention: 3

## Per-qid paths
- `f4f1d8a4` (`single-session-user`): full notes; bm25/grep `stand mixer` + `birthday gift` / `sister`, add the gift session, done (giver is sister).
- `80ec1f4f_abs` (`multi-session`, abstention): gold notes empty; turns mention Jan/Feb museum visits, not December — grep `museum`/`gallery`/`December`; if no December visit evidence in notes, abstain (do not invent a count).
- `gpt4_2c50253f` (`temporal-reasoning`): full notes; need both mornings — grep `wake`/`7:00` and `Tuesdays and Thursdays` / `15 minutes earlier`; combine base wake with Tue/Thu offset, bag both, done.
- `b01defab` (`knowledge-update`): gold notes empty; early unfinished vs later “finished … The Nightingale” — thin notes; if present, grep `Nightingale`/`Kristin Hannah`/`finished`, prefer latest finish state, bag both, done.
- `f4f1d8a4_abs` (`single-session-user`, abstention): gold notes empty; birthday gift evidence is sister/stand mixer, not dad — grep `birthday gift`/`dad`; if notes only name sister (or empty), abstain.
- `81507db6` (`multi-session`): full notes; facet-search graduations — grep `graduation`/`preschool`/`master's`/`leadership development`/`eighth grade`; bag attended ceremonies (Emma, Rachel, Alex), exclude missed nephew Jack and non-graduation reunion, done for count.
- `gpt4_2d58bcd6` (`temporal-reasoning`): gold notes empty; compare finish times (“Hate U Give … two weeks ago” vs “Nightingale … last weekend”) — thin notes; if present, grep both titles + `finished`, add both, order by relative finish phrases, done.
- `b6019101` (`knowledge-update`): gold notes empty; early “4 MCU films” vs later “5 MCU films” in last 3 months — thin notes; if present, grep `MCU`/`Marvel`/`last 3 months`, prefer latest count, bag both, done.
- `f8c5f88b` (`single-session-user`): gold notes empty; purchase place in user turn (“sports store downtown”) — thin notes; if present, grep `tennis racket`/`sports store`/`downtown`, add, done.
- `85fa3a3f` (`multi-session`): gold notes empty; sum four Max purchases across sessions (bowl $15, cup $5, chews $10, collar $20) — thin notes; if present, grep `Max`/`food bowl`/`measuring cup`/`dental chews`/`flea and tick collar`, bag both, sum named items only, done.
- `gpt4_2f56ae70` (`temporal-reasoning`): gold notes empty; compare service start recency (Netflix/Hulu/Prime ~6 months, Apple TV+ ~few months, Disney+ free trial last month) — thin notes; if present, grep streaming names + `started`/`free trial`/`months`, bag all three, pick most recent start, done.
- `ba61f0b9` (`knowledge-update`): gold notes empty; early “5 women … team of 10” vs later “6 women out of 10” under Rachel — thin notes; if present, grep `Rachel`/`women`/`team of 10`, prefer latest headcount, bag both, done.
- `faba32e5` (`single-session-user`): gold notes empty; Alex BBQ ribs marinade duration in user turns — thin notes; if present, grep `Alex`/`marinate`/`BBQ ribs`/`special sauce`, add, done; else no-evidence.
- `87f22b4a` (`multi-session`): gold notes empty; need dozens sold × price/dozen (40 dozen × $3) — thin notes; if present, grep `sold`/`dozen eggs`/`$3 a dozen`, bag both farm sessions, multiply, done.
- `gpt4_2f584639` (`temporal-reasoning`): gold notes empty; compare gift buys (photo album “two weeks ago” vs necklace “last weekend”) — thin notes; if present, grep `necklace`/`Tiffany`/`photo album`/`Shutterfly`, add both, order by relative purchase phrases, done.
- `c4ea545c` (`knowledge-update`): gold notes empty; early gym Tue/Thu/Sat (3×) vs later “four times a week” — thin notes; if present, grep `gym`/`times a week`/`workouts`, prefer latest frequency, bag both, done (yes, more frequent).
- `88432d0a` (`multi-session`): gold notes empty; count distinct bake events in past two weeks across sessions (sourdough Tuesday, baguette Saturday, chocolate cake last weekend, wings tonight, etc.) — thin notes; if present, grep `baked`/`baking`/`sourdough`/`baguette`/`chocolate cake`, bag all bake-bearing golds, count in-window events, done.
- `gpt4_385a5000` (`temporal-reasoning`): gold notes empty; tomatoes indoors since Feb 20 vs marigolds started ~Mar 3 — thin notes; if present, grep `tomato`/`marigold`/`started … seeds`/`February 20`, add both, order by seed-start dates, done.
- `c6853660` (`knowledge-update`): gold notes empty; early “cut back to just one cup” vs later “changing … limit to two cups” — thin notes; if present, grep `cup`/`coffee`/`morning`/`limit`, prefer latest limit change direction (increase), bag both, done.
- `88432d0a_abs` (`multi-session`, abstention): gold notes empty; baking sessions lack egg tarts — grep `egg tarts`/`baked`; if no egg-tart bake evidence, abstain (do not answer with other bake counts).
- `gpt4_45189cb4` (`temporal-reasoning`): full notes; retrieve three January watch events — grep `Staples Center`/`Lakers`/`College Football National Championship`/`Chiefs`/`Bills`; bag all three, order by event dates/relative phrases, done.
- `c7dc5443` (`knowledge-update`): gold notes empty; early volleyball “3-2” vs later “5-2” / Net Ninjas — thin notes; if present, grep `volleyball`/`record`/`5-2`/`3-2`, prefer latest record, bag both, done.
- `8979f9ec` (`multi-session`): gold notes empty; sum lunch yields (chicken fajitas 3 meals + lentil soup 5 lunches) — thin notes; if present, grep `chicken fajitas`/`lentil soup`/`lunches`/`meal`, bag both, sum, done.
- `gpt4_468eb063` (`temporal-reasoning`): full notes; grep `Emma`/`lunch`/`freelance writer` (event “today” on session date); add session, compute days from session_date to question_date, done.
- `cc5ded98` (`knowledge-update`): full notes; early “about an hour each day” vs later “about two hours each day” coding exercises — grep `coding exercises`/`hour`/`two hours`, prefer latest duration, bag both, done.

## Cross-cutting rules (generalist)
- Prefer concrete entity/quantity greps (`stand mixer`, `Nightingale`, `MCU`, `Rachel`, `egg tarts`, `volleyball`) over abstract question shells (“how many”, “who gave”, “most recently”).
- For knowledge-update / “current” / “most recently changed” questions, retrieve both old and new states, then keep the latest count/limit/record/frequency; do not stop at the first matching number.
- For multi-session totals/costs, bag every named facet (each graduation, bake, purchase line-item, meal yield) before summing; never fill the bag from generic category hits (`baking`, `museum`, `gym`).
- For temporal compare/order/offset questions, land all event-bearing sessions, then order or diff by event dates and relative phrases inside notes—not by BM25 rank or session clock alone.
- After one hit, pivot facets/synonyms (`preschool graduation` vs `master's` vs `leadership development`; streaming service names; seed types) instead of repeating the same query.
- When gold notes are empty, notes-hop cannot surface the session unless other annotated notes carry the fact; do not loop identical bm25/grep—declare no-evidence rather than `done` with an empty bag.
- For abstention-shaped asks (wrong giver, wrong month, missing specific item), search the claimed predicate first; if notes only support a different entity/time/item, stop and abstain.
- Disambiguate nearby quantities (total films vs MCU-only; bake-anything vs egg tarts; reunion vs graduation; gym days listed vs “times a week”) by matching the question’s exact predicate.

## Anti-patterns
- abstract label queries; done with empty bag; repeating the same query;
  answering instead of retrieving; stuffing unrelated hits
