# Parallel-query methodology from 135 sequential trajectories

## Evidence

The methodology is distilled from the complete v1/Luna/H=6 traces for 135
answerable cases, audited in three independent 45-case batches.

- 281 total gold sessions:
  - 264 (94.0%) first appeared in search 1
  - 7 (2.5%) first appeared in searches 2–3
  - 1 (0.4%) first appeared in searches 4–6
  - 9 (3.2%) never appeared in any search
- 127/135 cases surfaced every gold session by search 3. The remaining eight
  never surfaced every gold session; additional late paraphrases did not fix
  them.
- 718 search calls were classified as:
  - 177 question-independent directions (24.7%)
  - 91 result-dependent directions (12.7%)
  - 450 redundant directions (62.7%)
- 79/135 trajectories were literally initial-batchable. Most result-dependent
  searches in the remaining trajectories were unnecessary for recall because
  their gold sessions had already appeared.

Conclusion: use **two adaptive rounds**, not six sequential planning rounds.
The first round should contain a small set of orthogonal question-derived
queries. The second round should be reserved for concrete anchors discovered
in the merged first-round hits.

## Round 1 — question-derived fan-out

Emit one to three searches in parallel. Every search must have a distinct
role; never issue simple word-order, singular/plural, or generic synonym
variants.

1. **Primary anchor**
   - Combine the main entity/topic, requested relation or action, and explicit
     date/window.
   - Use vocabulary shaped like stored facts, keyphrases, or events.
2. **Independent facet**
   - Add a second query only when the question contains a separable operand,
     endpoint, candidate group, requested attribute, or comparison side.
3. **Question-known exact anchor**
   - Use `grep_notes` only when the question itself supplies a proper noun,
     title, amount, model, date, or compact literal phrase.

Type guidance:

- Single-session fact or assistant recall: normally one primary anchor.
- Preference/recommendation: primary subject/context plus one genuinely
  different activity, genre, venue, or constraint formulation when the request
  is broad.
- Multi-session/count/aggregate: query the common set anchor and a separate
  operand or membership facet.
- Temporal: query the named event/entity and the computable date window or
  second endpoint.
- Knowledge update: query the entity together with both old/new or
  prior/current state language; usually one broad anchor already co-locates
  both sessions.

## Merge and add

- Execute all Round-1 searches concurrently.
- Merge hits by session ID, retaining the best rank/score and the union of
  matched terms.
- Treat snippets as routing evidence, not proof of the final answer.
- Add every plausibly relevant session from the merged batch while the bag has
  capacity. When uncertain, retain the session for the downstream answerer.
- Do not discard repeated or adjacent sessions merely because one snippet
  appears sufficient; four sequential failures already surfaced all gold but
  under-filled the bag.

## Round 2 — evidence-derived fan-out

Run zero to three searches in parallel, only for uncovered facets.

- Use concrete anchors that were absent from the question and first appeared
  in Round-1 hits: names, titles, event names, models, amounts, dates, places,
  or item subtypes.
- Use one query per missing facet or candidate cluster.
- A targeted exact grep is appropriate for a newly discovered literal anchor.
- If Round 1 returned no credible routing hit, spend one Round-2 query on a
  broader vocabulary family rather than repeating the same terms.
- Do not issue a third round of lexical paraphrases. In the observed traces,
  only one gold session first appeared after search 3, while 450/718 searches
  were redundant.

## Stop policy

Call `done` after all plausible hits from the latest merged batch have been
added and each question facet has either candidate coverage or a documented
search attempt.

Do not continue merely because search budget remains. Stop immediately when:

- later queries would only reorder or lightly synonymize existing terms;
- a grep would repeat an unchanged literal pattern;
- all question facets have plausible sessions in the bag.

## Parallel controller contract

- Keep existing tool JSON shapes.
- Enable multiple `bm25_notes`/`grep_notes` function calls in one model
  response.
- Count each individual search against the six-search budget.
- Interpret “last search hits” as the deduplicated union of the most recent
  parallel batch, so `add_sessions` can add IDs from any call in that batch.
- Recommended configuration: maximum three searches in Round 1 and maximum
  three in Round 2.
- Preserve the global 200k-token/60-second gate and parallelize different
  questions independently from within-question search fan-out.

## Evaluation

Compare the parallel controller against the sequential answerable135 baseline:

- full-gold in bag by hard/mid/easy and question type
- mean gold recall
- cases where gold was surfaced but not added
- total model turns, searches, input/output tokens, and wall-clock latency
- mean and maximum bag size

The parallel design passes only if easy remains at least 94/95, hard is at
least 19/28, mid is at least 10/12, and overall full-gold is at least 123/135,
while materially reducing model turns or latency.
