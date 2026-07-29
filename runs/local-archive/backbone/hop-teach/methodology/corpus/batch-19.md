# Batch 19
## Coverage
- qids: 25
- by question_type: multi-session 13, temporal-reasoning 12 (includes 2 abstention variants)
- notes_coverage: full 10, partial 15, none 0
- gold-notes empty (notes-hop cannot index gold turns): 15 / 25

## Per-qid paths
- `ef66a6e5` (`multi-session`): no-evidence in notes (gold notes empty); user turns mention competitive swim + competitive tennis — notes-hop cannot surface either session.
- `gpt4_a1b77f9c` (`temporal-reasoning`): grep each title (`The Nightingale`, `Sapiens: A Brief History of Humankind`, `The Power` / Naomi Alderman); add start+finish sessions; sum week spans from session dates / “today” events.
- `ef9cf60a` (`multi-session`): bm25/grep `sister` + gift/$ cues (`Tiffany`, `spa`, `gift card`); add both gold sessions; sum sister-gift amounts only (ignore niece planning).
- `gpt4_a2d1d1f6` (`temporal-reasoning`): no-evidence in notes (gold notes empty); harvest-from-herb-garden-kit “today” lives only in user turns.
- `efc3f7c2` (`multi-session`): no-evidence in notes; wake times (Friday 6:00 AM vs weekday 6:30 AM) only in user turns — cannot hop via notes.
- `gpt4_af6db32f` (`temporal-reasoning`): no-evidence in notes; Super Bowl “watched … today” only in user turns vs question_date.
- `f0e564bc` (`multi-session`): no-evidence in notes; $800 Coach handbag + $500 Nordstrom skincare only in user turns — cannot sum via notes.
- `gpt4_b0863698` (`temporal-reasoning`): no-evidence in notes; 5K charity run “today” only in user turns.
- `f35224e0` (`multi-session`): grep podcast titles `How I Built This` and `My Favorite Murder`; add both; take episode counts (≈15 + finished ep 12) and sum.
- `gpt4_b4a80587` (`temporal-reasoning`): no-evidence in notes; need both relative anchors (prime lens “a month ago” vs coastal road trip “last week”) — only in user turns.
- `gpt4_15e38248` (`multi-session`): no-evidence in notes; furniture buy/assemble/fix mentions (Casper mattress, IKEA bookshelf, West Elm coffee table, wobbly kitchen table) scattered across user turns only.
- `gpt4_b5700ca0` (`temporal-reasoning`): grep `Maundy Thursday` / `Episcopal Church` (also in events/keyphrases); add that session; answer location from notes — do not prefer Easter Egg Hunt volunteer distractor for “religious activity.”
- `gpt4_194be4b3` (`multi-session`): grep instrument ownership cues (`Fender Stratocaster`, `Yamaha FG800`, `Korg B1`, `Pearl Export` drum set); add multi-hit sessions; count currently owned instruments (exclude niece’s violin; ukulele is planned, not owned).
- `gpt4_b5700ca9` (`temporal-reasoning`): no-evidence in notes; Maundy Thursday Episcopal service “today” buried mid-dialog in user turns only.
- `gpt4_2ba83207` (`multi-session`): grep store+$ facts (`Walmart`, `Trader Joe`, `Thrive Market`, `Publix`); add all spend sessions; compare dollar totals for past-month grocery spend (attribute shared Trader Joe’s carefully).
- `gpt4_c27434e8` (`temporal-reasoning`): no-evidence in notes; Ferrari start “three weeks ago” vs Zero start “about a month ago” only in user turns — order needs both relative ages.
- `gpt4_2f8be40d` (`multi-session`): grep `wedding` + distinct attendees/venues (cousin Rachel vineyard, college roommate rooftop, friend Jen/Tom barn); add all three; count attended weddings this year (exclude own wedding planning).
- `gpt4_c27434e8_abs` (`temporal-reasoning`, abstention): no-evidence in notes; available turns mention Ferrari + Japanese Zero, not Porsche 991 — even if notes existed for Ferrari/Zero, abstain because asked alternative (Porsche) is unsupported.
- `gpt4_2f91af09` (`multi-session`): grep writing counts (`17 poems`, `five short stories`, writing-challenge piece titles); add all three golds; sum poems + stories + challenge pieces since restart window.
- `gpt4_cd90e484` (`temporal-reasoning`): no-evidence in notes; binoculars acquired “three weeks ago” + goldfinches seen “a week ago” only in user turns — duration = difference of those relative ages.
- `gpt4_31ff4165` (`multi-session`): no-evidence in notes; daily devices (Fitbit, hearing aids, Accu-Chek, nebulizer) split across five gold user-turn sessions — notes-hop cannot gather the set.
- `gpt4_d31cdae3` (`temporal-reasoning`): no-evidence in notes; Southwest family trip “a few years ago” vs Europe solo “last summer” only in user turns — earlier = Southwest.
- `gpt4_372c3eed` (`multi-session`): grep education timeline (`Arcadia High School`, `Pasadena City College` / Associate’s, `UCLA` Bachelor’s); add all three; sum years high-school→Bachelor’s from dated facts (HS 2010–2014 + four-year Bachelor’s; treat Associate’s path consistently with gold).
- `gpt4_d6585ce8` (`temporal-reasoning`): grep concert/event entities (`Billie Eilish`, outdoor park concert, `Glass Animals` / Brooklyn festival, jazz night, `Queen` / Adam Lambert); add all five; order by session_date within past-two-months window.
- `gpt4_372c3eed_abs` (`multi-session`, abstention): no-evidence in notes; user turns cover HS→Bachelor’s only — retrieve education facts if notes existed, then abstain: Master’s completion years are not evidenced.

## Cross-cutting rules (generalist)
- Prefer concrete entity/title/brand/dollar greps over abstract labels (`sports`, `furniture`, `devices`, `religious activity`, `weeks spent`).
- Multi-session totals: retrieve every distinct instance session before summing; keep bag≤12 and dedupe by session_id.
- Temporal duration/order: pull sessions that carry start/finish or relative-age cues, then compare session_date / “today”/“N weeks ago” hints against question_date — never invent chronology.
- Side-mention filter: when a fact appears while planning someone else’s gift/wedding/instrument, keep only self-owned / self-spent / self-attended instances.
- Named-media chains: for each title, fetch both start and finish (or count) hits; do not stop after the first title match.
- Distinguisher queries for lookalikes: church service vs community Easter event; podcast A vs podcast B; grocery chains with different $ totals.
- Abstention: if the question names an entity/degree/outcome absent from retrieved notes, keep partial supporting sessions in bag but `done` with unresolved gap — do not substitute a related entity.
- Empty/thin gold notes: if grep/bm25 returns nothing after 1–2 concrete reformulations, stop — do not `done` with an empty bag pretending completeness, and do not answer from parametric memory.
- After a hit, `add_sessions` from that hit’s neighborhood before issuing a near-duplicate query.
- For order questions, gather all candidate events first, then sort; do not answer after retrieving only one side of the comparison.

## Anti-patterns
- abstract label queries; done with empty bag; repeating the same query;
  answering instead of retrieving; stuffing unrelated hits
- treating planned purchases (ukulele, future spa day) as owned/spent facts
- using distractor volunteer/community events as the religious/activity answer
- stopping after one title/store/instrument when the question needs a multi-instance aggregate
- resolving abstention variants by swapping in a related evidenced entity (Zero for Porsche; Bachelor’s for Master’s)
