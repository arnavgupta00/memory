# Batch 08

## Coverage
- qids: 25
- by question_type: single-session-user 5, multi-session 5, temporal-reasoning 5, knowledge-update 4, single-session-assistant 4, single-session-preference 2
- notes_coverage: full 7, partial 18, none 0
- is_abstention: 0 (none marked abstention); many partial packs have **empty gold notes**, so notes-hop cannot surface gold even when user turns hold the fact

## Per-qid paths
- `75499fd8` (`single-session-user`): gold notes empty — no-evidence via bm25/grep; if notes existed, query dog/Max/Golden Retriever collar → add breed session → done.
- `3c1045c8` (`multi-session`): gold notes empty — no-evidence; ideal path bm25 age/department average + own age (32) across two sessions → add both → done (subtract).
- `d6233ab6` (`single-session-preference`): bm25 high school / debate team / old high school friends → grep `debate` or `high school friends` → add preference session → done (ground reunion advice in prior HS ties).
- `b29f3365` (`temporal-reasoning`): gold notes empty — no-evidence; ideal bm25 guitar lessons + amp purchase → add both dated sessions → done (lessons duration vs amp timing).
- `50635ada` (`knowledge-update`): gold notes empty — no-evidence; ideal bm25 United / MileagePlus / Premier → add older Silver then newer Gold → done (previous = Silver).
- `778164c6` (`single-session-assistant`): bm25 Caribbean/Jamaican snapper → grep `Escovitch` → add session → done (user notes already name the recommended dish).
- `76d63226` (`single-session-user`): gold notes empty — no-evidence; ideal bm25 Samsung TV / 55-inch / wall mount → add → done.
- `3fdac837` (`multi-session`): gold notes empty — no-evidence; ideal separate queries Japan/Tokyo trip dates and Chicago trip days → add both → sum durations → done.
- `fca70973` (`single-session-preference`): bm25 theme park / Halloween Horror Nights / Universal VIP → add recent park weekend session → done (suggest next weekend from stated Halloween food/VIP prefs).
- `b46e15ed` (`temporal-reasoning`): bm25 charity events → grep consecutive-day pair (`24-Hour Bike Ride`, `Books for Kids`) → add those two (+ optional others) → done; compute months from consecutive-day dates to question date.
- `5831f84d` (`knowledge-update`): gold notes empty — no-evidence; ideal bm25 Crash Course videos → add later count session (current) over earlier partial counts → done.
- `7a8d0b71` (`single-session-assistant`): gold notes empty and user turns lack budget figures — no-evidence in notes (influencer $ lives in assistant plan text only).
- `853b0a1d` (`single-session-user`): gold notes empty — no-evidence; ideal bm25 grandma / silver necklace / birthday → add jewelry provenance session → done (age 18).
- `3fe836c9` (`multi-session`): gold notes empty — no-evidence; ideal bm25 mortgage pre-approval amount + house sale price → add both → subtract → done.
- `b46e15ee` (`temporal-reasoning`): gold notes empty — no-evidence; ideal bm25 charity event names with session dates → pick event ~1 month before question date (Walk for Hunger) → add → done; do not answer from wrong-month charities.
- `59524333` (`knowledge-update`): gold notes empty — no-evidence; ideal bm25 gym time Mon/Wed/Fri → prefer later session’s updated time over older → add latest → done.
- `7e00a6cb` (`single-session-assistant`): bm25 Amsterdam hostel / budget-friendly → add gold travel session → done; notes are thin on the specific hostel name (assistant recommendation may not appear in notes).
- `8550ddae` (`single-session-user`): bm25 cocktail / lavender gin fizz / last weekend → grep `lavender gin` → add → done.
- `46a3abf7` (`multi-session`): gold notes empty — no-evidence; ideal bm25 aquarium/tank sizes + friend’s kid tank → add all tank-count sessions → sum → done.
- `b9cfe692` (`temporal-reasoning`): bm25 book titles (`Evelyn Hugo`, `Nightingale`) → grep finish durations → add both duration sessions → sum weeks → done.
- `5a4f22c0` (`knowledge-update`): gold notes empty — no-evidence; ideal bm25 Rachel + colleague/TechConnect → grep current employer cue → add update session (current company) over intro-only session → done.
- `8464fc84` (`single-session-assistant`): gold notes empty; deli name is assistant-only — no-evidence via notes; topic query Vatican/nearby food cannot recover the proper name from notes.
- `86b68151` (`single-session-user`): gold notes empty — no-evidence; ideal bm25 bookshelf / living room / IKEA → add → done.
- `4adc0475` (`multi-session`): gold notes empty — no-evidence; ideal bm25 indoor soccer goals + assists → add both stat sessions → sum → done.
- `bbf86515` (`temporal-reasoning`): gold notes empty — no-evidence; ideal grep `Turbocharged Tuesdays` and `Rack Fest` with event dates → add both → day-diff → done.

## Cross-cutting rules (generalist)
- Prefer **concrete entity anchors** (breed, SKU, airline status tier, book title, event name, city+duration) over abstract labels (“my pet”, “status”, “trip”, “stats”).
- For **multi-session aggregates** (sum days, goals+assists, tank counts, age gap), retrieve **every complementary fact session** before `done`; one hit is usually incomplete.
- For **knowledge-update / “current/previous/usually”**, retrieve **both** older and newer mentions, then keep the chronologically latest value (or explicitly the pre-update value when asked for previous).
- For **temporal-reasoning**, retrieve sessions that state **event names + dates or durations**, then compute; do not treat question-date alone as evidence.
- For **preference** follow-ups (“another weekend”, “should I attend reunion”), retrieve the session that encodes **prior choices/ties**, then stop—do not open-ended browse.
- For **single-session-assistant** recalls (“what did you recommend”), search notes for **user echoes of the recommendation** (accepted dish/place); if notes only restate the ask, expect thin evidence and avoid inventing names.
- When gold notes are empty (`has_notes: false`), **do not invent session IDs or fabricate facts**—notes-hop cannot reach gold; abstain rather than answer from parametric memory.
- After a hit list appears, **`add_sessions` from last hits only** (bag ≤12), then `done`; do not answer inside the hop loop.
- If BM25 is noisy, **grep a rare proper noun** from candidate notes (Escovitch, MileagePlus tier, exact book title, event proper name) to disambiguate.
- Split multi-hop evidence with **two focused queries** (e.g. Japan vs Chicago; goals vs assists; pre-approval vs sale price) instead of one vague combined query.

## Anti-patterns
- abstract label queries; done with empty bag; repeating the same query;
  answering instead of retrieving; stuffing unrelated hits
- treating assistant-only named entities as retrievable when notes only record the user’s question
- using an older superseded fact (gym time, flyer status, video count) as “current”
- summing or dating from a single charity/travel session when the question needs a pair or consecutive-day set
- adding every thematically related session (all aquariums, all flights) when only the numeric/date-bearing golds matter
