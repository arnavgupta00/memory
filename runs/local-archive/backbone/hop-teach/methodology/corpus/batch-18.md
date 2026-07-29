# Batch 18

## Coverage
- qids: 25
- by question_type: multi-session=13, temporal-reasoning=12
- notes_coverage: full=5, partial=20, none=0
- abstention: 4 (`e5ba910e_abs`, `gpt4_93159ced_abs`, `edced276_abs`, `eeda8a6d_abs`)
- gold-notes density: 5 qids have all gold sessions annotated; 20 qids have empty gold `notes_text` (cues live only in user turns — notes-hop fails unless those facts were indexed)

## Per-qid paths
- `d851d5ba` (`multi-session`): thin-notes; if indexed: `bm25_notes("raised charity $")` then `grep_notes(["raised $","charity"])` and `add_sessions` for all four raise amounts ($2000/$250/$1000/$500) before `done` — empty gold notes ⇒ cannot reach via notes alone.
- `gpt4_7f6b06db` (`temporal-reasoning`): `bm25_notes("got back trip hike camping road trip")` → add completed-trip hits → `grep_notes(["Muir Woods","Yosemite","Big Sur","Monterey"])` → add missing destinations → `done` once three completed trips are bagged (ignore Eastern Sierra planning).
- `d905b33f` (`multi-session`): `bm25_notes("favorite bookstore book discount favorite author")` → add → `grep_notes(["$30","$24","favorite author","bookstore"])` to join original price + paid price sessions → `done` (need both for % discount).
- `gpt4_8279ba02` (`temporal-reasoning`): thin-notes; target cue “got a smoker today” + session_date vs question_date; `bm25_notes("smoker")` / `grep_notes(["smoker"])` → add single purchase session → `done`; empty gold notes block notes-hop.
- `dd2973ad` (`multi-session`): thin-notes; hop doctor appointment then bedtime: `bm25_notes("doctor's appointment")` → add → `grep_notes(["bed","2 AM","Wednesday","Thursday"])` → add sleep session → `done` (need appointment day + prior bedtime).
- `gpt4_8279ba03` (`temporal-reasoning`): thin-notes; `bm25_notes("got kitchen appliance smoker today")` / `grep_notes(["smoker"])` → add purchase session dated ~10 days before question → `done`.
- `e25c3b8d` (`multi-session`): thin-notes; `bm25_notes("TK Maxx designer handbag")` → add → `grep_notes(["$500","$200","handbag","TK Maxx"])` to join original + paid → `done` (savings = difference).
- `gpt4_85da3956` (`temporal-reasoning`): thin-notes; `bm25_notes("Summer Nights Universal Studios Hollywood")` / `grep_notes(["Summer Nights","Universal Studios"])` → add festival session → compare session_date to question_date for weeks-ago → `done`.
- `e3038f8c` (`multi-session`): `bm25_notes("rare books figurines coins records")` → add → `grep_notes(["rare books","rare figurines","rare coins","rare records","5 ","12 ","25 ","57 "])` → add all count-bearing collection sessions (books/figurines/coins/records) → `done` without double-counting duplicate record mentions.
- `gpt4_88806d6e` (`temporal-reasoning`): `grep_notes(["Mark and Sarah","Tom"])` (or BM25 name query) → add both meet sessions → order by relative event text (“few months ago” vs “about a month ago”), not only session_date → `done`.
- `e56a43b9` (`multi-session`): thin-notes; `bm25_notes("FreshMart points discount")` → add → `grep_notes(["FreshMart","500 points","100 points","$1"])` to join balance + conversion rule → `done`.
- `gpt4_8c8961ae` (`temporal-reasoning`): thin-notes; `grep_notes(["Thailand","Europe"])` / BM25 trip names → add both trip sessions → order by relative time in text (“last year” vs “last month”), not same-day session stamps → `done`.
- `e5ba910e_abs` (`multi-session`, abstention): thin-notes; retrieve headphones price via `bm25_notes("headphones Sony")` / `grep_notes(["headphones","iPad"])`; iPad cost absent (only phone case/watch noise) → bag partial evidence then `done` with abstention (cannot total).
- `gpt4_8e165409` (`temporal-reasoning`): thin-notes; `bm25_notes("spider plant repot")` → add → `grep_notes(["Mrs. Johnson","cuttings","repotted","spider plant"])` → add both dated plant sessions → `done` for day-gap from session_dates/(today) events.
- `e6041065` (`multi-session`): thin-notes; `bm25_notes("packed shoes wore trip")` → add → `grep_notes(["pairs of shoes","wearing two","sneakers","sandals"])` to join packed-count + worn-count sessions → `done`.
- `gpt4_93159ced` (`temporal-reasoning`): thin-notes; `bm25_notes("NovaTech")` → add → `grep_notes(["working professionally","years","NovaTech"])` to join tenure + current-employer sessions → `done`.
- `e831120c` (`multi-session`): thin-notes; `bm25_notes("Marvel Cinematic Universe Star Wars marathon")` → add → `grep_notes(["Marvel","Star Wars","two weeks","week and a half"])` → add both binge sessions → `done` (sum durations).
- `gpt4_93159ced_abs` (`temporal-reasoning`, abstention): thin-notes; same tenure+job hop as sibling, but `grep_notes(["Google","NovaTech"])` finds NovaTech not Google → retrieve available job/tenure sessions then `done` abstaining (employer mismatch).
- `edced276` (`multi-session`): thin-notes; `grep_notes(["Hawaii","New York City"])` / BM25 place names → add both travel sessions (Hawaii ~10-day family; NYC five days) → `done` to sum days.
- `gpt4_93f6379c` (`temporal-reasoning`): `grep_notes(["Page Turners","Marketing Professionals"])` → add both join sessions → order by relative join text (“last week” vs “yesterday”); skip language-learning Facebook planning session → `done`.
- `edced276_abs` (`multi-session`, abstention): thin-notes; `grep_notes(["Hawaii","Seattle","New York"])` recovers Hawaii + NYC, not Seattle → bag found travel sessions then `done` abstaining (missing Seattle leg).
- `gpt4_98f46fc6` (`temporal-reasoning`): thin-notes; `grep_notes(["charity bake sale","charity gala"])` → add both event sessions → order by session_date/(today) (“bake sale today” earlier than “gala tonight”) → `done`.
- `eeda8a6d` (`multi-session`): thin-notes; `bm25_notes("aquarium tank fish gallon")` → add → `grep_notes(["20-gallon","10-gallon","neon tetras","betta","Bubbles","gouramis"])` → add both tank sessions and sum countable fish → `done`.
- `gpt4_9a159967` (`temporal-reasoning`): thin-notes; `bm25_notes("Airlines flight March April")` → add → `grep_notes(["United","Southwest","American","March","April"])` across all flight sessions → bag all March/April flights then `done` after counting airline frequency (do not stop at one airline).
- `eeda8a6d_abs` (`multi-session`, abstention): thin-notes; `grep_notes(["30-gallon","20-gallon","10-gallon","tank"])` finds 10/20-gallon tanks only → retrieve those then `done` abstaining (no 30-gallon tank evidence).

## Cross-cutting rules (generalist)
- For multi-aspect totals (sums, % from two numbers, N collections, N trips), keep hopping until every required aspect is in the bag; one strong hit is not enough.
- Prefer concrete nouns and numbers from the question (place names, store names, dollar amounts, proper names) over abstract labels (“discount”, “total”, “trip”).
- After the first hit, `grep_notes` sibling entities surfaced in that hit (other destinations, the other price, the other person/group) instead of re-running the same BM25 query.
- Temporal “which first / how long ago / days between” questions: bag all compared events, then order using event relative-time text and session_date/(today)—do not trust question paraphrase alone.
- When two events share the same calendar day in metadata, prefer in-note relative cues (“last year” vs “last month”, “few months ago” vs “a month ago”, “last week” vs “yesterday”).
- Purchase/savings/% questions usually need both list price and paid price (or points balance + conversion rule); search the merchant/item then grep amounts.
- “How many weeks/days ago” with a named event: retrieve the attendance/purchase session, then compute from session_date vs question_date; do not invent the date from the question.
- Abstention twin pattern: run the same multi-aspect retrieval, then verify every named entity in the question appears in notes; if one leg is missing or renamed (wrong employer/city/tank size), `done` with abstention rather than answering from the closest substitute.
- Thin/empty gold notes: notes-hop cannot invent sessions—if BM25/grep never return the needed entities after reformulation, stop with no-evidence/abstain; do not pad the bag with unrelated hits.
- Ignore planning/future noise when the question asks for completed events (planned Eastern Sierra vs completed Muir/Big Sur/Yosemite; future South America vs past Thailand/Europe).
- Bag ≤12 and only IDs from the latest search hits; always `add_sessions` before `done`; never answer inside the hop loop.

## Anti-patterns
- abstract label queries; done with empty bag; repeating the same query;
  answering instead of retrieving; stuffing unrelated hits
- stopping after one aspect of a multi-sum / multi-trip / two-price question
- treating a near-miss entity (wrong city, wrong employer, wrong tank size) as sufficient evidence instead of abstaining
- ordering events by session wall-clock alone when notes encode stronger relative-time phrases
- chasing planning/gear/future-trip vocabulary when completed-event language is available
- double-counting the same collection mentioned in multiple sessions while missing a different collection’s count session
