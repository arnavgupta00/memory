# Batch 04

## Coverage
- qids: 25
- by question_type: knowledge-update 4, multi-session 4, single-session-assistant 4, single-session-preference 4, single-session-user 5, temporal-reasoning 4
- notes_coverage: full 6, partial 19, none 0
- gold-notes reachability: 6/25 have ≥1 annotated gold session; 19/25 have all gold sessions empty in the notes index (haystack may still be partially annotated)
- abstention items: 0

## Per-qid paths
- `36580ce8` (`single-session-user`): gold unindexed — if notes existed, bm25/grep `bronchitis`/`thought was just a cold`/`health issues` then add the fitness/immune session; with empty gold notes, notes-hop cannot hit.
- `1a8a66a6` (`multi-session`): gold unindexed — need all magazine subscribe/cancel sessions (New Yorker, Architectural Digest, Forbes cancel, NatGeo mention); bm25 `magazine subscription` then grep title anchors and add every distinct title/cancel hit before counting “current.”
- `35a27287` (`single-session-preference`): gold unindexed — retrieve language/cultural-festival preference session (French podcasts, cultural exchange, volunteer festival) via `cultural events`/`language festival`/`French`; empty gold notes → unreachable.
- `5e1b23de` (`temporal-reasoning`): gold unindexed — find photography-workshop event (“3-day photography workshop… today”) via `photography workshop`/`astrophotography`; compute months vs question_date; empty gold notes → unreachable.
- `10e09553` (`knowledge-update`): bm25 `Lake Michigan` + `largemouth bass` + `Alex`; grep `7/10` vs `7/22` catch counts; add both fishing sessions and keep the **earlier** (7/10 → 7 bass), not the later 7/22 update.
- `3e321797` (`single-session-assistant`): gold unindexed and answer is assistant-only (tomato+lemon leave-on time); topic bm25 `dark circles`/`tomato juice`/`lemon` cannot surface empty-note gold — notes-hop fails / thin-notes abstain.
- `37d43f65` (`single-session-user`): gold unindexed — cues `RAM upgrade`/`16GB`/`Dell Inspiron`; empty gold notes → unreachable (fact lives in user turns only).
- `1c549ce4` (`multi-session`): gold unindexed — need car-cover **and** detailing-spray purchase sessions (`waterproof car cover` `$120`, `detailing spray` `$20`); add both then sum; empty gold notes → unreachable.
- `38146c39` (`single-session-preference`): gold unindexed — ground cookie advice in prior turbinado/muscovado/baking-sugar preference session (`turbinado sugar`, carrot-cake frosting experiments); empty gold notes → unreachable.
- `6613b389` (`temporal-reasoning`): gold unindexed — need Rachel engagement date (May 15) **and** anniversary (July 22); bm25 `Rachel`/`engaged`/`anniversary`; add both dated sessions then diff months; empty gold notes → unreachable.
- `184da446` (`knowledge-update`): gold unindexed — retrieve both reading-progress mentions of *A Short History of Nearly Everything* (page 200 then page 220); keep latest page; empty gold notes → unreachable.
- `41275add` (`single-session-assistant`): bm25/grep `YouTube`/`share`/`workplace posture` (thin keyphrases only); add the share-video session — Mayo Clinic title is assistant-authored and may be absent from notes even after add.
- `3b6f954b` (`single-session-user`): gold unindexed — cue `study abroad`/`University of Melbourne`/`Great Ocean Road`; empty gold notes → unreachable.
- `1f2b8d4f` (`multi-session`): bm25 `luxury boots`/`$800` and `budget store`/`$50`; grep price facts; add both boot sessions and compute $800−$50 difference; do not stop on one side of the pair.
- `505af2f5` (`single-session-preference`): bm25 `creamer`/`almond milk`/`vanilla`/`honey`; add homemade-creamer preference session and recommend in that sugar-reduction / DIY-creamer frame.
- `6e984301` (`temporal-reasoning`): gold unindexed — need class-start session and tools-purchase session (`sculpting classes` vs `sculpting tools` “today”); relative weeks from class start to tool buy; empty gold notes → unreachable.
- `18bc8abd` (`knowledge-update`): gold unindexed — retrieve BBQ-sauce brand mentions; prefer later “currently obsessed” (`Kansas City Masterpiece`) over earlier favorite (`Sweet Baby Ray's`); empty gold notes → unreachable.
- `4388e9dd` (`single-session-assistant`): bm25 `Andy`/`comedy`/`script`/`Head of Computing`; grep `stained white shirt` / wardrobe facts; add script session — clothing fact is present in user-sourced notes here.
- `3d86fd0a` (`single-session-user`): bm25/grep `Sophia` + `met`/`coffee shop`; add contacts/how-we-met session; stop once meeting-location fact is in bag.
- `21d02d0d` (`multi-session`): gold unindexed — collect March missed fun-run mentions (`March 5th`, `March 26th` 5K); add both running sessions then count; empty gold notes → unreachable.
- `54026fce` (`single-session-preference`): gold unindexed — retrieve WFH colleague-socializing / virtual-coffee-break preference session via `colleagues`/`virtual coffee`/`work from home`; empty gold notes → unreachable.
- `6e984302` (`temporal-reasoning`): gold unindexed — “investment for a competition four weeks ago” → sculpting-tools purchase dated ~4 weeks before question_date; bm25 `sculpting tools`/`art competition` and filter by session_date; empty gold notes → unreachable.
- `1cea1afa` (`knowledge-update`): gold unindexed — Instagram follower counts 500 then 600; bm25 `Instagram`/`followers`; keep chronologically latest; empty gold notes → unreachable.
- `488d3006` (`single-session-assistant`): gold unindexed; trail name is assistant recommendation — user cues `Moncayo`/`hiking trail`/`Aragón` insufficient if gold notes empty; notes-hop fails / thin-notes abstain.
- `3f1e9474` (`single-session-user`): gold unindexed — cue `destiny`/`everything happens for a reason`/`friend Sarah`; empty gold notes → unreachable.

## Cross-cutting rules (generalist)
- Treat **gold `has_notes=false` as a hard miss** for notes-hop: do not invent hits; abstain or stop rather than stuffing unrelated annotated distractors.
- For **knowledge-update / “currently”** questions, retrieve **all** value mentions for the entity, order by session/event date, and keep the **latest** state (followers, pages read, brand obsession, catch counts when asking “earlier” vs later).
- For **multi-session totals/diffs**, search until every complementary aspect is bagged (each subscription/title, each purchase line-item, each missed-event date, both price sides); never answer from a single partial hit.
- Prefer **proper nouns, SKUs, dollar amounts, and calendar dates** in bm25/grep over abstract labels (“health issue”, “investment”, “events”, “connected”).
- **Temporal** asks need the dated event session(s) plus question_date (or a second anchor date); grep date-like strings and engagement/anniversary/workshop phrasings, then compute—don’t retrieve a thematically related undated chat.
- **Preference** follow-ups: retrieve the session that defines prior taste/constraints (DIY creamer recipe, sugar experiments, language/cultural volunteering, WFH social prefs), not a generic topic match.
- **Single-session-assistant**: if the asked detail is assistant-authored and notes only mirror user prompts, retrieve the topic session when indexed, but expect **thin notes**—do not fabricate the assistant’s recommendation from keyphrases alone.
- After a hit that clearly covers the asked aspect(s), **add from last hits and done**; reformulate once with a rarer anchor if the first query is noisy; do not repeat the same query.
- When two near-duplicate narrative sessions exist (same hobby arc), disambiguate with **date_hint / explicit day mentions** (7/10 vs 7/22, page 200 vs 220) rather than topic overlap alone.

## Anti-patterns
- abstract label queries; done with empty bag; repeating the same query;
  answering instead of retrieving; stuffing unrelated hits
- treating haystack `notes_coverage: partial/full` as proof that **gold** is searchable
- stopping after one state in a knowledge-update chain (old brand, old follower count, later fishing trip when asked for earlier)
- summing or counting without collecting every complementary gold session
- grepping only the question’s paraphrase when a rare entity/amount in candidate notes would disambiguate
- adding assistant-answer sessions’ neighbors when gold itself is unindexed
