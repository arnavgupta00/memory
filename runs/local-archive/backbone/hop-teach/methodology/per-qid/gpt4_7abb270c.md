# gpt4_7abb270c

## Question gist

Temporal-reasoning question (as of 2023/03/10): recover the **chronological order of six distinct museum visits** the user made, from earliest to latest. Each gold session anchors one visit (or a first-mention visit) tied to a named museum or a clearly dated exhibition event; the answer requires collecting all six visit sessions and sorting by session date / event timing in notes.

## Gold sessions and cue phrases (from notes or user turns)

| Session | Date | Museum / visit anchor | Cue phrases (notes-first) |
|---------|------|----------------------|---------------------------|
| `answer_7093d898_1` | 2023/01/15 | **Science Museum** — "Space Exploration" exhibition | `Science Museum`, `Space Exploration`, moon rocks, colleague David |
| `answer_7093d898_1` | 2023/01/15 | **Museum of Contemporary Art** — lectures series | `Museum of Contemporary Art`, `Dr. Maria Rodriguez`, feminist art 1970s, networking reception |
| `answer_7093d898_2` | 2023/01/22 | **Museum of Contemporary Art** — follow-up on same lecture series | `came back from a lecture series at the Museum of Contemporary Art`, Judy Chicago, feminist art |
| `answer_7093d898_3` | 2023/02/10 | **Unnamed venue** — "Ancient Egyptian Artifacts" exhibition (user wrongly said Met, then corrected) | `Ancient Egyptian Artifacts`, `Tutankhamun golden mask`, mummies, ankh symbol |
| `answer_7093d898_4` | 2023/02/15 | **Museum of History** — conservation lab tour | `Museum of History`, `conservation lab`, behind-the-scenes tour, art conservation |
| `answer_7093d898_5` | 2023/02/20 | **Modern Art Museum** — guided tour | `Modern Art Museum`, `The Evolution of Abstract Expressionism`, `Dr. Patel`, Pollock, Rothko |
| `answer_7093d898_6` | 2023/03/04 | **Natural History Museum** — "Dinosaur Fossils" exhibition | `Natural History Museum`, `Dinosaur Fossils`, life-sized T-Rex, niece |

**Intended visit order (earliest → latest):** Science Museum → Museum of Contemporary Art → [Ancient Egyptian Artifacts exhibition venue] → Museum of History → Modern Art Museum → Natural History Museum.

**Red herring:** `Metropolitan Museum of Art` / `Met` appears in several sessions but is explicitly corrected as a mistake in session 3; do not treat Met mentions as a separate visit.

## Correct hop path (ordered tool calls with example queries/patterns)

Budget: **H ≤ 6**. Bag must hold all six gold session IDs (≤12).

1. **`bm25_notes("museum visited exhibition tour guided", top_k=20)`**  
   Broad lexical pull across visit narratives. Expect hits on sessions 1, 2, 4, 5, 6; may partially rank session 3.

2. **`grep_notes(["Science Museum", "Museum of Contemporary Art", "Museum of History", "Modern Art Museum", "Natural History Museum"])`**  
   Proper-noun sweep for the five named museums. Surfaces sessions 1, 2, 4, 5, 6 reliably; session 3 lacks a stable museum name.

3. **`bm25_notes("Ancient Egyptian Artifacts Tutankhamun golden mask mummies", top_k=10)`**  
   Exhibition-shaped query for the visit whose notes omit a correct museum proper noun (session 3).

4. **`add_sessions([...])`** — add **only** IDs seen in hops 1–3 hits:  
   `answer_7093d898_1`, `answer_7093d898_2`, `answer_7093d898_3`, `answer_7093d898_4`, `answer_7093d898_5`, `answer_7093d898_6`  
   (6 IDs, within bag limit 12).

5. **`bm25_notes("Dr. Maria Rodriguez Dr. Patel conservation lab Dinosaur Fossils", top_k=10)`** *(optional sanity hop if bag incomplete after step 4)*  
   Person/event anchors to recover any session missed by generic museum wording.

6. **`done("Bag covers all six museum-visit sessions with distinct dates for temporal ordering")`**

**Minimal 5-hop variant** (if hop 1+2+3 already surface all six IDs): skip hop 5; go straight from `add_sessions` to `done`.

## Failure modes if agent searches wrong

- **Met-only or Met-first search:** Retrieves misleading Met references in sessions 3, 5, and 6 without isolating the six actual visits; session 3 even notes the Met claim was wrong.
- **Single-museum query:** e.g. only `Modern Art Museum` or only `Museum of Contemporary Art` — returns one cluster and misses the other five visits spread across Jan–Mar.
- **Generic "art" / "feminist art" without museum anchor:** Collapses many sessions but may omit Science Museum, Natural History Museum, or Museum of History conservation tour.
- **Stopping after first hit cluster:** Session 1 and 2 both mention MoCA; an agent may add only one and never reach sessions 4–6.
- **Missing exhibition-title hop:** Session 3 is weak on museum proper nouns; without `Ancient Egyptian Artifacts` / `Tutankhamun`, the third visit never enters the bag.
- **`add_sessions` from stale hits:** Adding after hop 1 only (before grep/exhibition reformulation) leaves session 3 out of the bag.
- **Calling `done` before `add_sessions`:** Search hits alone do not populate the bag; temporal ordering cannot be computed.

## Reusable rules (3–7 bullets, generalist wording — no qid names)

- For **multi-visit temporal** questions, start with a **broad bm25** query (`museum`, `visited`, `exhibition`, `tour`) at `top_k=20`, then **narrow** with entity-shaped follow-ups — one broad hop rarely suffices alone.
- Run **`grep_notes` on proper nouns** (museum names, curator names, exhibition titles) when the question involves named venues; lexical BM25 may rank narrative filler above the visit fact.
- When notes cite an **exhibition title but a wrong or missing venue name**, reformulate with **exhibition + artifact keywords** rather than trusting the erroneous proper noun.
- **`add_sessions` only from the last search hits** and only after a deliberate sweep; for N-item enumeration tasks, verify the bag count matches the question's cardinality before `done`.
- **Do not treat repeated mentions across sessions as one visit** — the same museum may appear in multiple sessions; each gold session may still hold distinct dating evidence.
- **Ignore self-corrected mistakes in notes** (e.g., "I apologize… I got my museums mixed up") when choosing retrieval queries; prefer corrected exhibition facts over retracted venue names.
- **Reformulate once** with person names or event types (`guided tour`, `lecture series`, `behind-the-scenes`) if a proper-noun grep returns fewer sessions than the question implies.

## Abstention / thin-notes note (if any)

**Not an abstention case** — `notes_coverage: full`, all six gold sessions have rich notes.

**Thin-venue caveat:** Session 3 documents the visit via **exhibition artifacts** (`Ancient Egyptian Artifacts`, Tutankhamun mask) rather than a reliable museum name after the user retracts the Met claim. Retrieval must lean on exhibition/keyphrase cues, not Met grep. Cross-session Met mentions in later sessions are **recollections**, not additional visit anchors.
