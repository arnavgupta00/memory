# Batch 13

## Coverage
- qids: 25
- by question_type: single-session-user 6, multi-session 5, temporal-reasoning 5, knowledge-update 5, single-session-assistant 4
- notes_coverage: full 5, partial 20, none 0
- gold_notes populated: 5 qids (all gold sessions annotated); 20 qids have empty gold notes (hop success depends on whether haystack annotations captured the same user-turn facts)
- abstention: 0

## Per-qid paths
- `ccb36322` (`single-session-user`): bm25/grep concrete service name or “Spotify” / “listening … lately” with indie/concert context; gold notes empty — if no Spotify fact in notes, no-evidence (do not invent a streamer).
- `720133ac` (`multi-session`): grep `Lola` + `vet`/`consultation`/`$50` and separately `flea`/`$25`; `add_sessions` both cost hits; sum before answering (ignore dog-bed/grooming-kit prices).
- `gpt4_213fd887` (`temporal-reasoning`): retrieve `volleyball` league (duration ~2 months) and `charity 5K` / children’s hospital (~1 month ago); bag both; order by relative recency → volleyball first.
- `9bbe84a2` (`knowledge-update`): grep `Apex` + `level` goals; bag older `level 100` and newer `level 150`; for “previous … before I updated” keep the earlier goal (100), not the latest.
- `eaca4986` (`single-session-assistant`): answer lives in assistant-authored song/chords; user turns only request a sad/romantic song — notes-hop likely no-evidence; do not fabricate a progression.
- `d52b4f67` (`single-session-user`): grep `cousin` + `wedding` / `Grand Ballroom`; one session should suffice if that venue fact was annotated.
- `73d42213` (`multi-session`): retrieve Monday doctor/clinic leave time (`7 AM`) and separately travel duration (`two hours`); bag both; arrival = leave + duration (not “back to office 1:00 PM”).
- `gpt4_21adecb5` (`temporal-reasoning`): retrieve undergrad completion and master’s thesis submission with session/event dates; bag both; compute month gap from dated facts (not from question date alone).
- `9ea5eabc` (`knowledge-update`): bm25/grep `family trip` + place names (`Hawaii`, `Paris`); bag both; for “most recent” prefer later relative/event dating (Paris “last month” over earlier Hawaii).
- `f523d9fe` (`single-session-assistant`): user states the show example — grep `Netflix` + `Doc Martin` / `doc martin` / “last season”; assistant roleplay shell is noise.
- `dccbc061` (`single-session-user`): grep `spirituality` / `atheist` / “previous stance”; gold fact is prior `staunch atheist` (current Buddhism is the update, not the ask).
- `7405e8b1` (`multi-session`): retrieve `HelloFresh` first-order `%` and `UberEats` first/order `%` in separate hops; bag both; compare percentages (ignore other meal-kit chatter).
- `gpt4_2312f94c` (`temporal-reasoning`): grep `Galaxy S22` and `Dell XPS 13` with acquisition dates; bag both; for “got first” use receive/own dates (not preorder alone); ignore power-bank purchase dates.
- `a1eacc2a` (`knowledge-update`): grep `short stories` counts across sessions (`four` then `7`); for current total use the later updated count; bag both to confirm update.
- `fca762bc` (`single-session-assistant`): user asks which app uses mnemonics — that name is assistant-only; notes have language-apps context but not the answer → treat as no-evidence unless a user echo exists.
- `e01b8e2f` (`single-session-user`): grep `family` + `week`/`week-long` + trip/`Hawaii`/`Big Island`; prefer the completed past trip over future planning turns.
- `77eafa52` (`multi-session`): grep `Sakura` / trip quote `$2,500` and corrected `$2,800`; bag both; difference is the overage (ignore insurance quotes).
- `gpt4_2487a7cb` (`temporal-reasoning`): grep exact titles `Effective Time Management` and `Data Analysis using Python`; bag both; order by event relative time (“two months ago” vs “last Saturday”) → webinar first.
- `a2f3aa27` (`knowledge-update`): grep `Instagram` + `followers` / counts (`1250`, `1300`); bag both; “now” → later/higher updated count, not the first mention.
- `fea54f57` (`single-session-assistant`): grep `Fifth Album` / song title; user turn echoes `Evolution` after the assistant pick — retrieve that echo if notes captured it; else assistant-only no-evidence.
- `e47becba` (`single-session-user`): grep `graduated` / `degree` / `Business Administration`; single lexical hit should suffice if annotated.
- `80ec1f4f` (`multi-session`): grep museum/gallery visits with February dates (`Natural History` `2/8`, `Art Cube` `2/15`); bag all venue hits; filter out January (`Modern Art Museum`) before counting distinct places.
- `gpt4_2655b836` (`temporal-reasoning`): retrieve first service date (`March 15`) and post-service issues (`GPS` `3/22`); bag timeline sessions; “first issue after first service” = earliest dated fault after service (not purchase date).
- `affe2881` (`knowledge-update`): grep `bird` / `species` / local park counts (`27`, `32`); bag both; answer the updated total (32), not the earlier running count.
- `ec81a493` (`single-session-user`): grep `debut album` / `signed poster` / `500` / `worldwide`; numeric fact is in user notes — avoid confusing poster edition size with unrelated collectibles.

## Cross-cutting rules (generalist)
- Prefer question entities and quoted titles over abstract labels (“streaming service”, “spirituality”, “language app”) when forming `bm25_notes` / `grep_notes` queries.
- Multi-hop numeric questions: pull each operand with its own query, `add_sessions` every supporting hit (bag ≤12), then combine (sum, difference, percent compare, count) — never answer from a single partial number.
- Knowledge-update / “previous” / “now” / “most recent”: always try to bag both old and new values; resolve with session/event recency — “previous/before update” → earlier fact; “now/most recent/how many … have I” → latest fact.
- Temporal “which first”: retrieve both candidates with their absolute or relative dates; order by event time in notes, not by which session was retrieved first; do not confuse purchase/preorder/service/issue timestamps.
- Month/window filters: when the question scopes a calendar month, keep only dated visits inside that window and drop same-theme distractors outside it before counting.
- After a broad bm25 hit list, `grep_notes` for exact titles, dollar amounts, percents, level numbers, or proper nouns to tighten the bag.
- Empty or thin gold notes are common on partial coverage: keep one synonym/entity reformulation, then stop with no-evidence rather than guessing; assistant-authored content (chords, recommended app/song names) is especially often missing from user-turn notes unless the user echoed it.
- Side-channel prices and gear talk in the same sessions are distractors — only bag turns that bind the asked entities (pet name + vet/flea; agency + trip quote; device + acquire date).

## Anti-patterns
- abstract label queries; done with empty bag; repeating the same query; answering instead of retrieving; stuffing unrelated hits
- treating the first numeric mention as final on knowledge-update (skipping the later corrected count/goal/follower total)
- using session retrieval order or question date as event order without reading relative/absolute date phrases in notes
- counting out-of-window or theme-adjacent venues/devices/costs (January museum; power bank; dog bed; insurance quote)
- inventing assistant-only answers when notes only show the user’s request
- calling `done` after one multi-session operand when the question needs a join/sum/compare
