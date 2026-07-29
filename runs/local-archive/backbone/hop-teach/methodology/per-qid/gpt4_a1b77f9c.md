# gpt4_a1b77f9c
## Question gist
Temporal sum of weeks spent on three named media items: reading *The Nightingale* and listening to *Sapiens: A Brief History of Humankind* and *The Power*. Needs start and finish sessions (with dates) for each title.

## Gold sessions and cue phrases (from notes or user turns)
| session_id | role | cue phrases in notes |
|---|---|---|
| `answer_e9ad5914_1` | Nightingale start | `The Nightingale`; `Kristin Hannah`; event *Started reading 'The Nightingale'* |
| `answer_e9ad5914_2` | Nightingale finish | `The Nightingale`; `Kristin Hannah`; event *Finished reading "The Nightingale"* |
| `answer_e9ad5914_3` | Sapiens start | `Sapiens: A Brief History of Humankind`; `Yuval Noah Harari`; event *Started listening to 'Sapiens...'* |
| `answer_e9ad5914_4` | Sapiens finish | `Sapiens: A Brief History of Humankind`; `Yuval Noah Harari`; event *Finished listening to 'Sapiens...'* |
| `answer_e9ad5914_5` | The Power start | `The Power by Naomi Alderman`; `Naomi Alderman`; event *Started listening to The Power* |
| `answer_e9ad5914_6` | The Power finish | `The Power by Naomi Alderman`; `Naomi Alderman`; event *Finished listening to 'The Power'* |

Notes coverage is full; start/finish facts and date_hints are present for all three titles.

## Correct hop path (ordered tool calls with example queries/patterns)
Budget: H≤6. Prefer title/author greps over vague “weeks reading/listening” BM25.

1. **grep_notes**  
   `patterns=["The Nightingale", "Sapiens: A Brief History", "Naomi Alderman"]`  
   Rationale: distinctive title/author substrings. Use full *Sapiens* stem (not bare “Sapiens” if noisy) and **author** for *The Power* to avoid *The Power of Habit* collisions. Expect hits covering all six gold sessions.

2. **add_sessions**  
   Add every hit that is a start or finish for one of the three question titles (here: all six `answer_e9ad5914_{1..6}`). Bag ≤12.

3. **done**  
   `reason=bag has start+finish notes (with session dates) for Nightingale, Sapiens, and The Power; enough to sum weeks.`

Optional recovery if hop 1 misses a title (still within H≤6):

4. **bm25_notes** `query="finished listening The Power Naomi Alderman", top_k=10` (or `"started reading The Nightingale Kristin Hannah"` / `"finished listening Sapiens Harari"`).  
5. **add_sessions** any missing start/finish IDs from those hits.  
6. **done** as above.

## Failure modes if agent searches wrong
- Querying only generic terms (`reading`, `listening`, `audiobook`, `weeks`, `book recommendations`) floods haystack and buries start/finish facts.
- Grepping bare `"The Power"` pulls *The Power of Habit* / habit-change sessions and may fill the bag with wrong IDs.
- Adding only “finished” sessions (or only one title) leaves the temporal span incomplete; weeks cannot be computed.
- Stopping after the first BM25 page without a second title/author hop misses multi-title aggregation questions.
- Treating recommendation chatter (*All the Light We Cannot See*, *Atomic Habits*, etc.) as evidence of time spent on the asked titles.

## Reusable rules (3–7 bullets, generalist wording — no qid names)
- For multi-item duration questions, retrieve **start and finish** evidence per named item before calling done; dates live on those session notes/events.
- Prefer **grep on distinctive titles or authors** over BM25 on activity verbs (“reading”, “listening”, “weeks”).
- When a short title collides with other works, grep the **author or longer title form**, not the ambiguous short string alone.
- After a multi-pattern grep, **add all matching start/finish sessions in one bag update**, then done if every asked item is covered.
- If one item is missing from hits, reformulate with that item’s title+author (or “started/finished” + medium) rather than broadening to genre/recommendation language.
- Do not add sessions that only discuss similar books or habits unless notes state start/finish of the asked title.
- Never call done with a partial bag when the question asks for a total across several named items.

## Abstention / thin-notes note (if any)
Not abstention; `notes_coverage=full`. No thin-notes gap: each gold session carries explicit start or finish events for the relevant title.
