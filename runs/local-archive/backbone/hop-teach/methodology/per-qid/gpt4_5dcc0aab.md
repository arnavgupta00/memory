# gpt4_5dcc0aab
## Question gist
Temporal question: which shoe pair was cleaned last month (relative to 2023/05/24). Gold evidence names white Adidas sneakers as cleaned last month; other gold sessions supply contrasting shoe pairs and nearby times so the answerer can discriminate cleaning from wearing, buying, lending, or cobbler plans.

## Gold sessions and cue phrases (from notes or user turns)
- `answer_099c1b6c_3` — facts/events: "cleaned my white Adidas sneakers last month"; keyphrases: "white Adidas sneakers cleaning"; also Converse worn last month, Vans bought last weekend, outdoor music festival on the 15th.
- `answer_099c1b6c_1` — facts/events: "cleaned my white Adidas sneakers last month"; cleaning method (soap and water, air dry on balcony); "Cleaning white Adidas sneakers last month".
- `answer_099c1b6c_2` — Converse Chuck Taylor All Star at music festival last month; heel sole wear; water seeping — same temporal window, different action (wore / got wet, not cleaned).
- `answer_099c1b6c_4` — brown leather dress shoes → cobbler polish/condition this Saturday; hiking-boot shopping frame (contrast maintenance type).
- `answer_099c1b6c_5` — spare running shoes lent to sister a few weeks ago / almost a month; brown leather dress shoes polishing; clean/maintain hiking boots (future care, not last-month cleaning).

## Correct hop path (ordered tool calls with example queries/patterns)
1. `bm25_notes(query="cleaned sneakers last month", top_k=10)`  
   Action + object class + temporal cue from the question. Expect strong hits on `answer_099c1b6c_1` and `answer_099c1b6c_3` (Adidas cleaning facts/events).
2. `add_sessions(["answer_099c1b6c_1", "answer_099c1b6c_3"])`  
   Bag the sessions that state the cleaning event before expanding.
3. `grep_notes(patterns=["white Adidas", "cleaned my"])`  
   Lock the brand/object named in cleaning facts; confirm the cleaned pair is Adidas.
4. `bm25_notes(query="Converse Chuck Taylor music festival last month", top_k=10)`  
   Pull the same-window contrast session (`answer_099c1b6c_2`) where shoes were worn/got wet, not cleaned.
5. `add_sessions(["answer_099c1b6c_2"])` (plus any still-missing cleaning IDs if they reappear in hits), then `bm25_notes(query="brown leather dress shoes cobbler running shoes sister", top_k=10)`  
   Surface maintenance/lending contrast sessions `answer_099c1b6c_4` and `answer_099c1b6c_5`.
6. `add_sessions(["answer_099c1b6c_4", "answer_099c1b6c_5"])` from those hits → `done(reason="bag covers cleaned pair last month plus contrasting shoe actions/times")`.

## Failure modes if agent searches wrong
- Querying only "shoes last month" or "sneakers last month" ranks Converse/festival wear alongside Adidas cleaning and may miss which action was cleaning.
- Searching dominant co-topic "hiking boots" / Merrell / Keen floods hits with every gold and many distractors while skipping the cleaning fact.
- Stopping after one cleaning session without contrast sessions leaves temporal discrimination thin (wear vs clean vs lend vs cobbler).
- Grepping brand names before the cleaning action surfaces (e.g. only "Vans" or "Converse") retrieves wrong pairs.
- Calling `done` after hiking-boot sessions alone never bags the Adidas cleaning evidence.

## Reusable rules (3–7 bullets, generalist wording — no qid names)
- For action+object questions (cleaned, repaired, lent), put the **action verb** and object class in the first BM25 query together with the question’s temporal phrase.
- After a hit names a specific brand/model tied to that action, `grep_notes` that proper noun to confirm and re-rank lexical matches.
- When many similar items share a time window, run a reformulation hop for **contrast cues** (other brands, adjacent events) so the bag can discriminate the asked action.
- Prefer `add_sessions` as soon as hits clearly cover the asked aspect; do not wait for a perfect single-query ranking of all gold IDs.
- Avoid anchoring on a high-frequency co-occurring topic that appears in most sessions but does not answer the asked predicate.
- If the first hop returns mixed same-time items, keep the action term in the next query rather than dropping it for broader category terms.

## Abstention / thin-notes note (if any)
Not abstention; notes coverage is full. Cleaning evidence is concentrated in two sessions; the other gold sessions are contrast/context and lack the cleaning predicate—still add them when the question needs temporal discrimination among multiple shoe events.
