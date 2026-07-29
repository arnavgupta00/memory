# Batch 05

## Coverage
- qids: 25
- by question_type: knowledge-update 4, multi-session 4, single-session-assistant 4, single-session-preference 4, single-session-user 5, temporal-reasoning 4
- notes_coverage: full 5, partial 20, none 0
- gold-notes reachability: 6/25 have ≥1 annotated gold session; 19/25 have all gold sessions empty in the notes index (haystack may still be partially annotated)
- abstention items: 2

## Per-qid paths
- `4100d0a0` (`single-session-user`): grep/bm25 `Irish`/`Italian`/`mixed ethnicity`/`passport`; add the heritage/passport session once ethnicity co-occurs; stop.
- `2311e44b` (`multi-session`): gold unindexed — need Nightingale total-pages session (440) plus progress session (page 250); bm25 `Nightingale`/`440 pages`/`page 250` then add both hits; empty gold notes → unreachable.
- `57f827a0` (`single-session-preference`): gold unindexed — retrieve mid-century bedroom dresser preference (`walnut`/`satin finish`/`brass`/`mid-century modern dresser`) to ground rearrange tips; empty gold notes → unreachable.
- `71017276` (`temporal-reasoning`): grep `crystal chandelier`/`aunt`/`great-grandmother`; add the gift session; weeks = question_date − session_date (not abstract “antique” alone).
- `2133c1b5` (`knowledge-update`): gold unindexed — retrieve both Harajuku apartment tenure mentions (“a month” then “3 months”); keep chronologically latest; empty gold notes → unreachable.
- `4baee567` (`single-session-assistant`): gold unindexed; Chiefs–Jaguars–Arrowhead counts are assistant-authored — user cues `chiefs`/`jaguars`/`kansas` insufficient if gold notes empty; notes-hop fails / thin-notes abstain.
- `4fd1909e` (`single-session-user`): gold unindexed — cue `Imagine Dragons`/`Xfinity Center`/`June 15th`; empty gold notes → unreachable.
- `2311e44b_abs` (`multi-session`, abstention): gold unindexed — search `Sapiens`/`pages`/`reading`; bag related reading sessions show pace only, not pages left — after confirming missing quantity, abstain (do not invent from Nightingale totals).
- `6b7dfb22` (`single-session-preference`): gold unindexed — retrieve prior painting/art-practice session (`acrylic`/`flower paintings`/`palette knives`/`price paintings`) to ground inspiration tips; empty gold notes → unreachable.
- `71017277` (`temporal-reasoning`): grep `aunt`/`crystal chandelier`/`got … today`; add that gift session as the “last Saturday” giver (session_date Saturday); avoid jewelry-only abstract queries that miss chandelier wording.
- `2133c1b5_abs` (`knowledge-update`, abstention): gold unindexed — search `Shinjuku`/`apartment`/`living`; hits only evidence Harajuku tenure — after mismatch, abstain rather than answering with Harajuku duration.
- `4c36ccef` (`single-session-assistant`): gold unindexed — topic cues `Italian restaurant`/`Rome`/`romantic dinner`/`Roscioli`; restaurant name may only appear after assistant recommend + user echo; empty gold notes → unreachable / thin-notes.
- `51a45a95` (`single-session-user`): gold unindexed — cue `$5 coupon`/`coffee creamer`/`Cartwheel`/`Target`; empty gold notes → unreachable.
- `2318644b` (`multi-session`): bm25 `Maui`/`$300 per night`/`resort` and `Tokyo hostel`/`$30 per night`; add both accommodation sessions; compute nightly difference; do not stop on one trip or query only “Hawaii.”
- `75832dbd` (`single-session-preference`): bm25/grep `medical image analysis`/`explainable AI`/`deep learning`/`segmentation`; add the research-interest session (keyphrase-only notes still searchable) to ground publication/conference recs.
- `8077ef71` (`temporal-reasoning`): gold unindexed — find networking-event “today” session (`networking event`/`6 PM to 8 PM`); days = question_date − session_date; empty gold notes → unreachable.
- `22d2cb42` (`knowledge-update`): gold unindexed — retrieve guitar-service mentions (intent/`Rhythm Central` then completed `music shop on Main St`); keep latest completed servicing location; empty gold notes → unreachable.
- `51b23612` (`single-session-assistant`): gold unindexed; Soviet cartoon name is assistant-authored — user cues `political propaganda`/`humor`/`satire` won’t encode the title; notes-hop fails / thin-notes abstain.
- `545bd2b5` (`single-session-user`): gold unindexed — cue `Instagram`/`2 hours`/`screen time`; empty gold notes → unreachable.
- `27016adc` (`multi-session`): gold unindexed — need countryside listing (`$200,000`/`5-acre`) and renovation budget (`$20,000`/`deck`/`patio`); add both then compute percentage; empty gold notes → unreachable.
- `75f70248` (`single-session-preference`): gold unindexed — retrieve living-room dust/cat-shed / air-purifying-plant preference session (`cat`/`dust-free`/`spider plant`/`snake plant`) to ground sneeze hypothesis; empty gold notes → unreachable.
- `8c18457d` (`temporal-reasoning`): grep `graduation gift`/`3/8`/`wireless headphone` and `best friend's 30th`/`March 15`/`silver necklace`; add both dated gift sessions; days = later − earlier.
- `2698e78f` (`knowledge-update`): gold unindexed — retrieve all `Dr. Smith`/`therapy` frequency mentions (`every two weeks` then `every week`); keep chronologically latest cadence; empty gold notes → unreachable.
- `561fabcd` (`single-session-assistant`): gold unindexed — cues `Radiation Amplified`/`Fissionator`/`zombie` name brainstorm; final name is user-confirmed but gold notes empty → unreachable.
- `577d4d32` (`single-session-user`): gold unindexed — cue `stop`/`work emails`/`7 pm`/`evening routine`; empty gold notes → unreachable.

## Cross-cutting rules (generalist)
- Treat **gold `has_notes=false` as a hard miss** for notes-hop: do not invent hits; abstain or stop rather than stuffing unrelated annotated distractors.
- For **knowledge-update / “current”** questions, retrieve **all** entity-state mentions, order by session/event date, and keep the **latest** grounded value (tenure months, service location, therapy cadence)—ignore stale earlier states once a later dated value exists.
- For **multi-session totals/diffs/percentages**, search until every complementary numeric aspect is bagged (both nightly rates, price + renovation cost, book total + progress); never answer from one side.
- Prefer **proper nouns, titles, dollar amounts, and explicit dates** (`chandelier`, `Harajuku`, `$300`, `3/8`, `March 15`) over abstract labels (“jewelry”, “ethnicity”, “networking”, “inspiration”).
- **Temporal** asks need the dated event session plus question_date (or a second gift/event date); grep the concrete gift/event phrase and use session_date—“weeks/days ago” is computed, not retrieved as a number.
- **Abstention twins**: if the asked entity/quantity is absent or mismatched (wrong neighborhood, book with pace but no pages-left), bag the near-miss evidence then **done-abstain**—do not substitute a sibling fact.
- **Preference** follow-ups: retrieve the session that encodes prior taste/constraints (furniture finishes, painting practice, research topics, living-room allergens), not a generic tip query matching the new question wording alone.
- **Single-session-assistant**: when the asked detail is assistant-authored (game counts, cartoon titles, restaurant picks before user echo), expect **thin notes**—topic search cannot invent the answer; abstain if gold is unindexed.
- When the question uses a **region label** but notes use a finer place name inside it, reformulate to the indexed place (`Maui` not “Hawaii”, `chandelier` not “jewelry”).
- After hits cover the asked aspect(s), **add_sessions from last hits then done**; reformulate once with a rarer anchor if noisy; never repeat the same query or answer in-tool.

## Anti-patterns
- abstract label queries; done with empty bag; repeating the same query;
  answering instead of retrieving; stuffing unrelated hits
- treating haystack `notes_coverage: partial/full` as proof that **gold** is searchable
- answering abstention items with a close sibling entity (Harajuku for Shinjuku; Nightingale totals for Sapiens pages-left)
- stopping after one side of a multi-session arithmetic pair
- grepping only the question’s paraphrase when notes use a more specific object (chandelier vs “jewelry”; Maui vs “Hawaii”)
- keeping an older knowledge-update state when a later dated value exists
- adding thematically related annotated distractors when gold itself is unindexed
