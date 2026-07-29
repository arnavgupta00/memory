# gpt4_7f6b06db

## Question gist
Temporal-reasoning question asking for the earliest-to-latest order of three completed trips in the past three months (relative to 2023/06/01). Needs all three completed-trip sessions, not planning talk.

## Gold sessions and cue phrases (from notes or user turns)
- `answer_5d8c99d3_1` (2023/03/10) — completed day hike: **Muir Woods National Monument**, **Dipsea Trail**, event “Day hike to Muir Woods … (today)”; planning noise: Eastern Sierra / John Muir Trail / backpack.
- `answer_5d8c99d3_2` (2023/04/20) — completed road trip: **Big Sur and Monterey**, **Point Lobos**, Highway 1, Cannery Row, Monterey Bay Aquarium, Pacific Grove; also “recently got back from a solo camping trip to **Yosemite**”; event “Road trip … Big Sur and Monterey (today)”.
- `answer_5d8c99d3_3` (2023/05/15) — completed solo camping: **Yosemite National Park**, event “Solo camping trip to Yosemite National Park (today)”; planning noise: Eastern Sierra / John Muir Wilderness.

Distinct completed destinations to recover: Muir Woods → Big Sur/Monterey → Yosemite (session dates order the three trips).

## Correct hop path (ordered tool calls with example queries/patterns)
1. `bm25_notes(query="got back from camping trip road trip hike", top_k=10)` — lexical completed-trip phrasing common in gold facts/events (“got back from …”).
2. `add_sessions([...])` — add hit IDs whose notes show completed trips / `(today)` events (expect Muir Woods, Big Sur/Monterey, and/or Yosemite sessions). Bag ≤12; only IDs from this search’s hits.
3. `grep_notes(patterns=["Muir Woods", "Yosemite", "Big Sur", "Monterey"])` — lock place-name coverage if hop 1 missed a destination among planning-heavy neighbors.
4. `add_sessions([...])` — add any missing gold destination sessions present in grep hits.
5. If still short of three distinct completed trips: `bm25_notes(query="Point Lobos Dipsea Trail Yosemite National Park", top_k=5)` — destination-specific reformulation; then `add_sessions` for remaining hit IDs.
6. `done(reason="bag covers three completed trips (Muir Woods, Big Sur/Monterey, Yosemite) for temporal ordering")` — stop once all three aspects are in the bag; do not chase Eastern Sierra planning sessions.

## Failure modes if agent searches wrong
- Queries dominated by **Eastern Sierra**, **John Muir Trail/Wilderness**, backpack/tent gear → planning sessions drown out completed trips.
- Single-destination search (e.g. only Yosemite) → may get two sessions but miss Muir Woods or conflate “recently Yosemite” with the later “today” Yosemite trip without collecting all three gold sessions.
- Stopping after two trip-like hits when the question asks for **three**.
- Treating planned future Eastern Sierra / July gear talk as a completed trip in the order.
- Broad `trip` alone without “got back” / place grep → haystack camping chatter, weak recall of Muir Woods or Big Sur.

## Reusable rules (3–7 bullets, generalist wording — no qid names)
- For “order of N trips/events” questions, search completed-event language first (`got back`, `today` events, past-tense trip nouns), not destination-planning or gear-shopping talk.
- After one destination or trip surfaces, `grep_notes` its proper nouns and sibling place names to recover the other legs of a multi-trip answer.
- Always `add_sessions` before `done`; the bag must cover all N asked aspects (here: three completed trips), not just the strongest hit.
- If BM25 returns mostly plans/future trips, reformulate toward completed-event or distinct place-name queries rather than deepening the same planning terms.
- Prefer event/`(today)` and session_date cues for ordering; ignore undated “planning a trip to X” facts when counting completed trips.
- Keep hops ≤6: one broad completed-trip BM25 → add → place grep → add → optional place-specific BM25 → done.

## Abstention / thin-notes note (if any)
Not abstention; `notes_coverage` is full. Notes already encode completed trips as facts/events with place names, so BM25+grep over notes is sufficient—no need to fall back to raw user turns for cue discovery.
