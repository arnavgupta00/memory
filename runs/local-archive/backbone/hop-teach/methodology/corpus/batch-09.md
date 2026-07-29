# Batch 09
## Coverage
- qids: 25
- by question_type: knowledge-update 5; multi-session 5; single-session-assistant 5; single-session-user 5; temporal-reasoning 5
- notes_coverage: full 8; partial 17; none 0

## Per-qid paths
- `86f00804` (`single-session-user`): `bm25_notes` on “currently reading book” should directly surface the fully annotated reading session; `add_sessions`, then `done`.
- `4bc144e2` (`multi-session`): Query “car wash cost” and “parking ticket cost” separately, but both gold sessions have empty notes, so notes-hop retrieval cannot recover the evidence and should abstain rather than add unrelated expense hits.
- `bcbe585f` (`temporal-reasoning`): Search “Audubon bird watching workshop” plus the workshop timing, but the gold session has no notes; if no explicit dated workshop evidence appears, abstain.
- `5c40ec5b` (`knowledge-update`): Search the distinctive entity pair “Alex Germany” and “met up,” but both state-bearing sessions lack notes, so the updated count is unavailable and warrants abstention.
- `8752c811` (`single-session-assistant`): `bm25_notes` on “100 prompt parameters voice tone register” can identify and add the request session, but the 27th assistant-generated list item is absent from notes, so retrieval reaches the session but not answer evidence.
- `8a137a7f` (`single-session-user`): Search “bedside lamp bulb warm tone Philips LED”; the gold note is empty, so notes cannot establish the bulb type and the retriever should abstain if no equivalent user fact is found elsewhere.
- `4f54b7c9` (`multi-session`): Query inherited family antiques by provenance, add the necklace/music-box/glassware hit, then query acquired family heirlooms and add the tea-set/typewriter hit before `done`.
- `c8090214` (`temporal-reasoning`): Query “Holiday Market week before Black Friday,” add that hit, then query “bought iPhone 13 Pro Black Friday,” add the purchase hit, and `done` once both event anchors are in the bag.
- `603deb26` (`knowledge-update`): Search “Negroni Emma showed me how many times,” but both old and updated counts occur only in empty-note gold sessions; abstain rather than infer a count from cocktail-topic distractors.
- `89527b6b` (`single-session-assistant`): Query the rare cluster “children’s book dinosaurs Plesiosaur image”; the gold session has no notes and the color was assistant-generated, so notes-hop retrieval cannot recover it.
- `8e9d538c` (`single-session-user`): Search “worsted weight yarn stash skeins”; because the gold session is unannotated, abstain unless an explicit duplicate count appears in another note.
- `5025383b` (`multi-session`): Query “joined online communities hobby,” add the cooking-community hit, then query the same relation with photography and add that hit before `done`.
- `c8090214_abs` (`temporal-reasoning`): Search “Holiday Market” and “bought iPad” independently; the market may be discoverable but no iPad purchase evidence exists, so do not substitute the iPhone event and abstain.
- `6071bd76` (`knowledge-update`): Query “French press ratio tablespoon ounces,” add both dated ratio hits (6 ounces, then 5 ounces), and `done` only after the chronology supports the direction of change.
- `8aef76bc` (`single-session-assistant`): Search “DIY recycled newspaper flower vase sealant”; the gold session has empty notes and the recommendation is assistant-only, so retrieval cannot supply evidence and should abstain.
- `8ebdbe50` (`single-session-user`): Search “certification completed last month LinkedIn”; the gold session is unannotated, so notes-hop cannot establish the certification and should abstain absent an explicit duplicate.
- `51c32626` (`multi-session`): Query “research paper sentiment analysis ACL submitted” and “ACL submission date February 1”; both gold notes are empty, so the submission date cannot be grounded through notes and requires abstention.
- `c9f37c46` (`temporal-reasoning`): Search separately for “watching stand-up regularly” and “open mic local comedy club”; both temporal anchors are in empty-note sessions, so notes-hop cannot calculate the duration.
- `618f13b2` (`knowledge-update`): Query the exact shoe model plus “worn times,” add the four-times hit and the later six-times hit, then `done` with the later state represented.
- `8b9d4367` (`single-session-assistant`): Query “Chaudhary rug manufacturing 40,000 employees”; the gold note is empty and the company name came from the assistant, so retrieval cannot recover it from user-note evidence.
- `94f70d80` (`single-session-user`): Search “IKEA bookshelf assembled hours”; the sole gold session has empty notes, so abstain if the explicit duration is not duplicated elsewhere.
- `55241a1f` (`multi-session`): Search “Facebook Live vegan recipes comments” and “most popular YouTube social media analytics comments” separately; both gold sessions lack notes, so the sum cannot be grounded.
- `cc6d1ec1` (`temporal-reasoning`): Query “bird watching for months” and “attended Audubon workshop month ago”; both anchors are absent from notes, so do not calculate from session dates and abstain.
- `69fee5aa` (`knowledge-update`): Search “pre-1920 American coins total” and “added new 1915-S Barber quarter”; both state-bearing sessions have empty notes, so the updated collection size is unrecoverable via notes.
- `8cf51dda` (`single-session-assistant`): `bm25_notes` on “grant aim molecular subtypes endometrial cancer” should identify and add the request session, but the three assistant-authored objectives are not preserved in notes, so retrieval cannot provide answer evidence.

## Cross-cutting rules (generalist)
- Decompose multi-session and temporal questions into one concrete query per entity, event, quantity, or time anchor; add only hits that explicitly cover a required component.
- Use distinctive lexical anchors first: named people, products, organizations, titles, locations, and uncommon object phrases outperform abstract question labels.
- For knowledge updates, retrieve both the earlier and later state and preserve chronology; the latest explicit state governs, while an increment event only changes a prior total when both are evidenced.
- For temporal comparisons, collect both event anchors before `done`; calculate only from explicit dates or relative-time statements tied to those events, never from retrieval rank.
- For assistant-recall questions, topic notes may locate the originating session without preserving the assistant-generated detail; distinguish session identification from answer evidence and abstain when the detail is absent.
- When a gold-relevant topic hit has empty or thin notes, try one lexical reformulation and `grep_notes` for a rare exact phrase; if the needed fact still does not appear, stop rather than fill the bag with topical neighbors.
- For abstention, search each premise independently and treat a missing or mismatched premise as decisive; never substitute a related device, person, event, or item.
- Keep the evidence bag minimal and compositional: add the smallest set of sessions that jointly covers all requested facts, with a hard ceiling of 12.

## Anti-patterns
- abstract label queries; done with empty bag; repeating the same query; answering instead of retrieving; stuffing unrelated hits
