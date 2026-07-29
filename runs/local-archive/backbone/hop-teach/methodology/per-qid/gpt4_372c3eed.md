# gpt4_372c3eed

## Question gist
Total years of formal education from high school through Bachelor's completion — needs every education-stage session (HS years, any pre-Bachelor credential, Bachelor duration/grad year), not a single school mention.

## Gold sessions and cue phrases (from notes or user turns)
- `answer_35c5419d_1`: Arcadia High School 2010–2014; UCLA undergrad; Arcadia California
- `answer_35c5419d_2`: Associate's degree Computer Science Pasadena City College (PCC) May 2016; joined UCLA after Associate's
- `answer_35c5419d_3`: Bachelor's Computer Science UCLA 2020; four years to complete Bachelor's; high school robotics (weaker HS cue)

## Correct hop path (ordered tool calls with example queries/patterns)
1. `bm25_notes(query="high school Bachelor's degree UCLA", top_k=10)` — surface HS + Bachelor timeline notes; expect hits including `answer_35c5419d_1` and `answer_35c5419d_3` (and possibly UCLA-adjacent sessions).
2. `add_sessions` — add any of those gold IDs present in the last hits (typically `_1` and `_3`).
3. `bm25_notes(query="Associate's degree UCLA Computer Science", top_k=10)` — reformulate for the middle credential not named in the question endpoints; expect `answer_35c5419d_2`.
4. `add_sessions(["answer_35c5419d_2"])` if it appears in the last hits (and any still-missing gold from step 1).
5. If `_2` still missing: `grep_notes(patterns=["Pasadena City College", "Associate's degree", "PCC"])` then `add_sessions` from those hits.
6. `done` once the bag holds all three gold IDs (HS span, Associate bridge, Bachelor four-years/2020).

## Failure modes if agent searches wrong
- Stops after Bachelor's-only hits (`_3`) and never searches Associate's / community-college cues → missing `_2`.
- Queries only AI/ML coursework language from the haystack (YOLO, Coursera, explainable AI) → buries education timeline notes.
- Treats "high school robotics" as enough HS evidence and skips the dated Arcadia High School session (`_1`).
- Uses vague "education years" BM25 without institution/degree nouns → weak ranking among 45 sessions.
- Calls `done` with bag < 3 education-stage sessions when the question asks for a multi-stage total.

## Reusable rules (3–7 bullets, generalist wording — no qid names)
- For span/total-years questions that name stage endpoints (e.g. high school → Bachelor's), retrieve **each** intermediate credential/stage, not only the named endpoints.
- First hop: BM25 with stage + institution nouns from the question; immediately `add_sessions` for any hit that carries dated enrollment or degree-completion facts.
- After an early hit names a school or degree title, reformulate the next BM25 with those proper nouns rather than repeating the raw question.
- Use `grep_notes` on distinctive school/degree strings (proper nouns, "Associate's", year+institution) when a middle stage is absent from the bag.
- Do not let topical distractors (coursework, research interests) replace education-timeline queries; keep hops anchored on schools, degrees, and year spans.
- Never `done` until the bag covers every education stage needed to compute the asked total; prefer one more reformulate/grep hop over early stop.

## Abstention / thin-notes note (if any)
Not abstention; `notes_coverage` is full. All three gold sessions have strong user-derived degree/school/year facts in notes — no thin-notes blocker if hops stay on education entities.
