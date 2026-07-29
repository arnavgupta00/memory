# Batch 01
## Coverage
- qids: 25
- by question_type: single-session-user 5, multi-session 4, single-session-preference 4, temporal-reasoning 4, knowledge-update 4, single-session-assistant 4
- notes_coverage: full 6, partial 19, none 0
- gold_notes: all gold sessions annotated 6; no gold notes 19 (answer facts live only in user_turns / assistant turns)
- abstention: 2

## Per-qid paths
- `001be529` (`single-session-user`): gold notes empty — blocked as-is; if annotated, bm25/grep `asylum application` / `approved` → add session (wait “over a year”).
- `00ca467f` (`multi-session`): gold notes empty — blocked as-is; if annotated, bm25/grep `doctor appointment` + `March` / named clinicians → bag all March visit sessions and count appointments (not planned follow-ups).
- `06878be2` (`single-session-preference`): bm25/grep `Sony A7R IV` / `Godox` / photography flash+bag → add setup session; recommend accessories consistent with owned gear.
- `08f4fc43` (`temporal-reasoning`): gold notes empty — blocked as-is; if annotated, separate queries `Sunday mass St. Mary's` and `Ash Wednesday cathedral` → bag both dated events; subtract dates.
- `01493427` (`knowledge-update`): gold notes empty — blocked as-is; if annotated, bm25/grep `postcards` / `collection` across start+later sessions → bag both; use latest cumulative count (25), not a single trip add.
- `0e5e2d1a` (`single-session-assistant`): gold notes empty and answer is assistant-study detail — notes-hop cannot recover subject count; topic query `binaural beats` / `anxiety` may find session shell only → no-evidence for the numeric answer.
- `0862e8bf` (`single-session-user`): gold notes empty — blocked as-is; if annotated, bm25/grep `cat` / `my cat's name` → add session (Luna).
- `0100672e` (`multi-session`): gold notes empty — blocked as-is; if annotated, bm25/grep `coffee mugs` / `coworkers` → bag gift+spend sessions; derive per-mug from total÷count ($60 / 5).
- `06f04340` (`single-session-preference`): gold notes empty — blocked as-is; if annotated, bm25/grep `basil mint` / `cherry tomatoes` / homegrown garden → add session; dinner suggestions must use those ingredients.
- `0bb5a684` (`temporal-reasoning`): bm25/grep `Effective Communication in the Workplace` and `team meeting` / `January 17` → bag workshop (Jan 10) + meeting (Jan 17); days-before = date diff.
- `031748ae` (`knowledge-update`): bm25/grep `Senior Software Engineer` / `lead` / `engineers` → bag early outing session (lead 4) and later hike session (lead five); report then vs now, not a single value.
- `1568498a` (`single-session-assistant`): gold notes empty; user turns are move lists but the asked reply-move is assistant-only — chess token grep may hit shell; notes lack the answer move → no-evidence for the specific reply.
- `0862e8bf_abs` (`single-session-user`, abstention): query `hamster` / pet name; corpus only has cat Luna — do not transfer names across pet types; abstain.
- `078150f1` (`multi-session`): bm25/grep `charity cycling` / `donations` → bag goal session ($200) and result session ($250); answer is delta ($50), not either alone.
- `07b6f563` (`single-session-preference`): gold notes empty — blocked as-is; if annotated, bm25/grep `iPhone 13 Pro` / screen protector / wallet case → add device-constraint session before accessory suggestions.
- `0bc8ad92` (`temporal-reasoning`): gold notes empty — blocked as-is; if annotated, bm25/grep `museum` + `friend` (and competing dad/solo visits) → bag dated museum visits; use the friend-accompanied visit date vs question_date for months elapsed.
- `031748ae_abs` (`knowledge-update`, abstention): title in question is `Software Engineer Manager` but evidence is `Senior Software Engineer` — role mismatch; do not answer headcount under the wrong title; abstain.
- `16c90bf4` (`single-session-assistant`): gold notes empty; user echoes `Pilsner` after assistant advice — if annotated, bm25/grep `Seco de Cordero` / `Ancash` / `Pilsner` may recover; without notes, assistant-specific beer type is thin → prefer session topic then rely on user-echoed brand if present.
- `118b2229` (`single-session-user`): gold notes empty — blocked as-is; if annotated, bm25/grep `daily commute` / `audiobooks` → add session (45 minutes each way).
- `099778bb` (`multi-session`): bm25/grep `leadership positions` / `women` / `diversity` → bag total-positions session (100) and women-count session (20); compute percentage; do not stop after one hop.
- `09d032c9` (`single-session-preference`): bm25/grep `phone` / `power bank` / `wireless charging` / travel tech pouch → add owned-gear session; tips must respect existing power accessories, not generic battery advice.
- `0bc8ad93` (`temporal-reasoning`): gold notes empty — blocked as-is; if annotated, bm25/grep `museum` + companion cues (`friend` vs `dad`) anchored to “two months ago” → bag candidate visits; answer companion for the matching dated visit, not the latest museum mention.
- `06db6396` (`knowledge-update`): gold notes empty — blocked as-is; if annotated, bm25/grep `painting classes` / `projects completed` → bag earlier (4) and later (5th finished); use the latest completed count.
- `18dcd5a5` (`single-session-assistant`): gold notes empty; user only requests a D&D one-shot — mummy count is assistant-authored; topic grep `Lost Temple` / `Djinn` cannot yield the number from notes → no-evidence / abstain on count.
- `15745da0` (`single-session-user`): gold notes empty — blocked as-is; if annotated, bm25/grep `vintage cameras` / `collecting` → add session (three months).

## Cross-cutting rules (generalist)
- Prefer concrete entity/event tokens from the question (proper names, object nouns, dated event titles) over abstract labels (`appointment`, `collection`, `accessories`).
- Multi-hop aggregation: when the answer needs a total, delta, percentage, or then/now pair, keep querying until complementary facts are in the bag—do not `done` after the first relevant hit.
- Knowledge-update: retrieve both timeline states (earlier value + later value); answer from the chronologically appropriate pair, preferring the latest state when asked “now/since/completed”.
- Temporal-reasoning: land dated event facts in the bag first, then compute gaps from session/event dates—never estimate from narrative alone.
- Preference: retrieve owned-device / ingredient / setup constraints before suggesting; suggestions must be conditioned on retrieved ownership facts.
- Single-session-user: one precise lexical query for the buried aside often beats broad topic search; by-the-way personal facts are the usual gold.
- Single-session-assistant: if the asked detail is assistant-authored and absent from user facts/keyphrases/events, stop with no-evidence rather than inventing; only chase user-echoed confirmations when present.
- Abstention: require entity-type and role/title alignment (pet species, job title). Near-miss evidence for a different entity is a reason to abstain, not to answer.
- Empty gold notes: notes-hop cannot surface unannotated gold; treat as retrieval failure / no-evidence unless annotations exist—do not hallucinate session contents.
- Use `grep_notes` for rare proper nouns and exact phrases; use `bm25_notes` for multi-term topical recall; vary the query if the first pass returns unrelated hits.
- Stay within bag≤12; add only sessions that carry answer-bearing facts; drop unrelated high-rank noise.

## Anti-patterns
- abstract label queries; done with empty bag; repeating the same query;
  answering instead of retrieving; stuffing unrelated hits
