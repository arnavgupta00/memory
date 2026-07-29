# 4dfccbf8

## Question gist

Temporal person+activity recall: on question date 2023/04/01, ask what the user did with **Rachel** on the **Wednesday ~two months earlier** (resolved target ≈ **2023/02/01 Wed**). Notes are USER-turn only (facts / keyphrases / events).

## Gold sessions and cue phrases (from notes or user turns)

| Session | Date | Role in answer | Notes cues |
|---|---|---|---|
| `answer_4bebc783_1` | 2023/02/01 (Wed) | Direct hit: activity *with Rachel* | **Rachel**; **ukulele lessons** (started today); fingerpicking exercises from Rachel; also plans **Taylor GS Mini** service with **Joe** at **Guitar Central** |
| `answer_4bebc783_2` | 2023/02/25 (Sat) | Companion gold in same music thread | **No Rachel**. **Taylor GS Mini** taken to guitar tech / **Joe's shop**; action fixed; shared instruments (Taylor GS Mini, Yamaha P-125, Korg/Roland) |

Hard structure: gold_1 is findable by the person name; gold_2 is **Rachel-absent** and only surfaces via **bridge entities** co-mentioned in gold_1 notes (Taylor GS Mini / Joe / guitar-tech servicing).

Distractors seen under the same cues:
- Other **Rachel** (thesis group member) — different activity, wrong date alignment for “two months ago Wednesday.”
- Other **ukulele** interest without Rachel.

## Correct hop path (ordered tool calls with example queries/patterns)

Budget H≤6; bag≤12; `add_sessions` only from the **last** hits.

1. **`grep_notes(patterns=["Rachel"])`** *(or `bm25_notes(query="Rachel", top_k=10)`)*  
   - Hits: Rachel sessions including gold_1 + name distractor.  
   - Prefer the hit whose notes also encode a *done-with-person* activity (here: ukulele lessons) and whose `session_date` matches the resolved Wednesday (~2023/02/01), not bare name overlap.

2. **`add_sessions(["answer_4bebc783_1"])`**  
   - Bag the dated person+activity session before further hops.

3. **Reformulate from bagged notes** — do **not** re-query calendar fluff. Mine co-occurring proper nouns / planned events: `Taylor GS Mini`, `Joe`, `Guitar Central`, servicing/action.  
   - **`bm25_notes(query="Taylor GS Mini Joe", top_k=10)`**  
     *or* **`grep_notes(patterns=["Taylor GS Mini"])`**  
     *or* **`grep_notes(patterns=["Joe"])`**  
   - Both golds rank in the top hits (grep Joe / Taylor GS Mini returns exactly the two golds).

4. **`add_sessions(["answer_4bebc783_2"])`**  
   - From those last hits only.

5. **`done(reason="Bagged Rachel+ukulele Wednesday session and bridged companion Taylor/Joe service session")`**

Optional tighten between steps 1–2 if name hits are ambiguous:  
`bm25_notes(query="Rachel ukulele lessons", top_k=5)` — gold_1 at rank 1; still requires the bridge hop for gold_2.

## Failure modes if agent searches wrong

- **Literal temporal BM25** (`Wednesday`, `two months ago`, `activity`, `together`) dilutes ranking toward unrelated “month/ago” travel notes and never encodes the resolved date in the index text.
- **Stop after first Rachel hit** — companion gold has zero Rachel tokens; person-only search cannot finish the gold set.
- **Bag every Rachel hit** — thesis-Rachel distractor burns bag slots and looks “relevant” under name-only scoring.
- **Activity-only without person** (`ukulele`) — pulls beginner-ukulele distractors that never mention Rachel.
- **Repeat near-duplicate queries** until hop budget dies instead of pivoting to bridge entities from the bagged notes.
- **`done` with partial bag** after gold_1 alone when a second gold remains unreachable only because no bridge hop was run.

## Reusable rules (3–7 bullets, generalist wording — no qid names)

1. For person + relative-time + activity questions, **search the proper noun first** (grep or short BM25); do not put weekday / “N months ago” / “what did I do” into the lexical query.
2. **Resolve relative dates offline** from `question_date` and use them to **filter or prefer hits by session_date**, not as BM25 terms (notes rarely restate “two months ago”).
3. When a bagged session mentions a person activity **and** other durable entities (people, shops, product models, planned events), run a **bridge hop** on those co-mentions — later gold sessions often drop the original person name.
4. Prefer **person + concrete activity noun** once the activity is visible in a hit (`Rachel` + `ukulele lessons`) to demote same-name distractors.
5. Use **`grep_notes` for distinctive proper nouns** (given names, shop names, model names) when BM25 with mixed fluff is noisy; keep patterns short and literal.
6. **`add_sessions` as soon as a hit clearly matches the question aspect**; never call `done` while a known aspect (person event vs follow-up fulfillment of a plan named in that session) is still unbagged and bridgeable within H≤6.
7. After a strong hit, **change the query family** (person → instrument/tech/place) rather than paraphrasing the same failed temporal string.

## Abstention / thin-notes note (if any)

Pack reports `notes_coverage: full` and `is_abstention: false`. Do **not** abstain when the person name is present in at least one session: the Rachel-absent companion is expected and should be recovered by bridging. Abstain / thin-notes only if **no** session notes contain the person (or an unambiguous activity synonym) after grep + short BM25 — i.e., the index truly lacks the entity, not merely lacks the companion session under the first cue.
