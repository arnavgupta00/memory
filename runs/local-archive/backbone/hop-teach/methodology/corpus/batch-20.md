# Batch 20

## Coverage
- qids: 25
- by question_type: multi-session 10, temporal-reasoning 15
- notes_coverage: full 9 / partial 16 / none 0
- abstention: 1 (`gpt4_fe651585_abs`)
- gold-notes reachability: 9 packs have notes on all gold sessions; 16 packs have empty gold notes (evidence only in raw user asides) so notes-hop cannot bag gold

## Per-qid paths
- `gpt4_5501fe77` (`multi-session`): bm25/grep `followers` + platform names (Twitter/TikTok/Instagram/Facebook); bag all three social-strategy sessions; compare stated deltas (Twitter 420→540, TikTok ~200/3 weeks, FB/IG qualitative) → max gain TikTok.
- `gpt4_d6585ce9` (`temporal-reasoning`): bm25 `concert`/`festival`/`music` + companion phrases; bag Saturday music events; map “last Saturday” from Q-date 2023/04/22 → 2023/04/15 Queen/Adam Lambert with parents (discard earlier Billie/Brooklyn/jazz Saturdays).
- `gpt4_59c863d7` (`multi-session`): bm25/grep `model kit`/`Revell`/`Tamiya`/`Tiger`/`B-29`/`Camaro`; bag four hobby sessions; count distinct kits worked-on or bought (F-15, Spitfire, Tiger I, B-29, Camaro)—do not double-count technique chatter.
- `gpt4_d9af6064` (`temporal-reasoning`): no-evidence in notes (both golds empty); thermostat 2/10 vs router Jan 15 live only in raw asides—notes-hop cannot retrieve; abstain/fail closed-world.
- `gpt4_731e37d7` (`multi-session`): bm25 `workshop` + `$`/`paid`/`free`; bag all workshop sessions in ~4-month window; sum attendance fees (writing $200, marketing $500, mindfulness $20, photography free; filter out ad-budget dollars).
- `gpt4_e061b84f` (`temporal-reasoning`): bm25 named-event lexicon (`triathlon`/`5K`/`soccer tournament`); grep titles; bag three participation sessions in past month before 2023/07/01; order by session_date → Spring Sprint Triathlon → Midsummer 5K → charity soccer.
- `gpt4_7fce9456` (`multi-session`): bm25 `viewed`/`saw`/`offer`/`Brookside`/`condo`/`bungalow`; bag house-hunt sessions; list property views before Brookside offer (Oakwood bungalow, Cedar Creek, 1BR condo, 2BR condo, Brookside view) and count views preceding the offer.
- `gpt4_e061b84g` (`temporal-reasoning`): same sports-event sweep as sibling; resolve “two weeks ago” from 2023/07/01 → ~2023/06/17 charity soccer tournament (not earlier triathlon/5K).
- `gpt4_a56e767c` (`multi-session`): no-evidence in notes (golds empty); festival names (Portland/Austin/Seattle/AFI) only in raw asides—notes-hop cannot count; abstain/fail.
- `gpt4_e072b769` (`temporal-reasoning`): no-evidence in notes (single gold empty); Ibotta “just downloaded” on session_date 2023/04/16 vs Q 2023/05/06 not indexed—notes-hop cannot date-diff; abstain/fail.
- `gpt4_ab202e7f` (`multi-session`): no-evidence in notes (golds empty); replace/fix items (toaster→toaster oven, faucet, mat, shelves, coffee maker) only in asides—notes-hop cannot enumerate; abstain/fail.
- `gpt4_e414231e` (`temporal-reasoning`): no-evidence in notes; mountain-bike fix (2023/03/15) vs pedal-upgrade decision (2023/03/19) only in raw turns—cannot day-diff via notes; abstain/fail.
- `gpt4_d12ceb0e` (`multi-session`): no-evidence in notes; ages (self 32, parents 55/58, grandparents 75/78) scattered in empty-note golds—cannot average via notes; abstain/fail.
- `gpt4_e414231f` (`temporal-reasoning`): no-evidence in notes; “past weekend” before 2023/03/21 needs 2023/03/19 road-bike pedal work vs earlier mountain-bike fix—not in notes index; abstain/fail.
- `gpt4_d84a3211` (`multi-session`): no-evidence in notes; bike $ amounts YTD only in raw turns—cannot sum via notes; abstain/fail.
- `gpt4_ec93e27f` (`temporal-reasoning`): no-evidence in notes; bus (2023/02/27) vs train (2023/03/03) recency comparison not indexed—notes-hop cannot pick most recent; abstain/fail.
- `gpt4_e05b82a6` (`multi-session`): no-evidence in notes; per-event rollercoaster ride counts (Jul–Oct) only in asides—cannot aggregate via notes; abstain/fail.
- `gpt4_f420262c` (`temporal-reasoning`): no-evidence in notes; airline flight order across five dated sessions not in notes—cannot sort carriers via notes; abstain/fail.
- `gpt4_f2262a51` (`multi-session`): no-evidence in notes; distinct doctor names/visits only in raw turns—cannot count via notes; abstain/fail.
- `gpt4_f420262d` (`temporal-reasoning`): no-evidence in notes; Valentine’s Day (2023/02/14) airline aside not indexed—notes-hop cannot answer; abstain/fail.
- `gpt4_f49edff3` (`temporal-reasoning`): grep distinctive event phrases (`prepare a nursery`, `cousin`/`baby shower`, `customized phone case`); bag three sessions; order by session_date → nursery (02/05) → baby shower (02/10) → phone case (02/20).
- `gpt4_fa19884c` (`temporal-reasoning`): no-evidence in notes; keyboard start vs bluegrass discovery day-gap not in notes; abstain/fail.
- `gpt4_fa19884d` (`temporal-reasoning`): no-evidence in notes; “last Friday” artist/listen start (session ~2023/03/31) not indexed; abstain/fail.
- `gpt4_fe651585` (`temporal-reasoning`): bm25/grep `Rachel`/`Alex`/`twins`/`adopted`; bag both family sessions; compare parenthood dates (Rachel twins Feb 12 vs Alex adoption January) → Alex first.
- `gpt4_fe651585_abs` (`temporal-reasoning`): abstention—search `Tom`/`Alex` parenthood cues; Alex adoption may appear in raw/empty-note sessions but Tom has no parenthood evidence; after failed Tom retrieval, done with empty/incomplete bag and abstain (do not substitute Rachel).

## Cross-cutting rules (generalist)
- Relative temporal anchors (“last Saturday”, “two weeks ago”, “past weekend”, “past month”) must be resolved against `question_date`, then filter candidate events by session/event date—not by retrieval rank.
- For order / earliest-latest questions, collect N distinct dated participation/setup events, then sort strictly by event or session date; never reorder by mention order inside one session.
- For multi-session aggregates (how many / total spent / average), bag every session that contributes a countable unit or dollar amount, then union/sum; exclude same-topic advice sessions that add no new instance.
- Prefer concrete entity+metric notes (platform+follower delta, kit model name, workshop+$fee, named race title) over ambient topic labels (“social media”, “modeling”, “sports”).
- When comparing two candidates (device A vs B, bus vs train, person A vs B), retrieve dated evidence for both sides before choosing; if one side lacks notes evidence, do not invent.
- Treat “today” / “just finished” / “participated … today” as stronger event anchors than future plans (“thinking of”, “scheduling”, “after my … game”).
- Grep proper names and distinctive titles after a broad BM25 sweep so near-miss same-topic sessions do not crowd the bag (≤12).
- Dollar sums: keep attendance/purchase costs tied to the asked category; drop unrelated budgets (ads, daily bids) that share `$` hits.
- Count questions: dedupe repeated mentions of the same instance across sessions; count distinct entities/events, not fact-line duplicates.
- Empty gold notes (common under pack `notes_coverage: partial`): notes-only hop cannot surface gold—prefer abstain/no-evidence over answering from non-gold topic hits.
- Abstention items: after targeted search, if a named entity in the question has no parenthood/event evidence, stop with incomplete bag; do not substitute a similar name from a parallel question.

## Anti-patterns
- abstract label queries; done with empty bag; repeating the same query;
  answering instead of retrieving; stuffing unrelated hits
- resolving “last/past …” without anchoring to question_date
- treating plans/gear/training chatter as competed/completed events
- summing every `$` hit without category filter
- answering count/order from a single multi-topic session when evidence is split
- pretending notes-hop succeeded when all gold sessions have empty notes
- substituting a near-name (e.g. Rachel for Tom) on abstention questions
