# Hop-Retriever Teacher-Swarm — Handoff

> Companion transcript: `/Users/arnav/Downloads/context_cursor_2.md` (full chat).
> This doc is the durable summary; the transcript has the blow-by-blow.

**Repo:** `/Users/arnav/programming/projects/memory`
**Last updated:** 2026-07-30
**Status:** Wave A (teachers) + Wave B (corpus) **complete**. Wave C (synthesis → v2 prompt) and the Luna re-gate are **not started**.

---

## 1. What this project is trying to do

We have a **bounded "hop" retriever agent** for LongMemEval. Given a question, it searches over per-session **notes** (written by `session-annotate-v1` from USER turns only) using a small tool loop and collects a "bag" of candidate sessions. Downstream answer-quality depends on whether the gold sessions land in that bag.

**The retriever's tool loop (contract — do not change the JSON shapes):**
- `bm25_notes(query, top_k∈{5,10,20})` — lexical BM25 over notes
- `grep_notes(patterns[1..5])` — exact/substring match over notes
- `add_sessions(session_ids)` — add IDs **from the last search hits only**; bag capped at `BAG_MAX = 12`
- `done(reason)` — stop early when the bag covers the question

**Primary metric:** *case-level full gold ⊆ bag* — every gold session for a question is present in the final bag. Secondary: mean gold recall, mean hops, bag size.

**Why we care:** improving the retriever's full-gold rate directly unblocks downstream answer flips. The hop agent is the lever we're tuning.

---

## 2. How we test (the offline gate)

Everything runs **offline** against frozen notes — no storer re-run needed to iterate on the retriever.

**Script:** `src/agents/current/src/scripts/hopRetrieveGate.ts`
**Prompt (current):** `src/agents/current/prompts/hop-retrieve-v1.yaml`
**Notes index code:** `src/agents/current/src/retrieval/notesIndex.ts`

**Inputs:**
- `--ids runs/local-archive/backbone/hop27-ids.json` — the frozen **hop27** eval slice (27 cases, stratified hard/mid/easy)
- `--annotations runs/local-archive/backbone/session-annotations-v1` — frozen notes
- dataset: `data/raw/longmemeval_s_cleaned.json`; gold: `data/raw/longmemeval_oracle.json`
- phase-1 baseline ranks: `runs/local-archive/backbone/rank-gate-answerable-phase1-none.json`

**Run examples:**
```bash
# baselines only (no LLM): notes-BM25 top-5/top-12 + phase-1 window BM25
pnpm --dir src/agents/current exec node --import tsx \
  src/scripts/hopRetrieveGate.ts --baselines-only \
  --out runs/local-archive/backbone/hop-gate-baselines.json

# a live hop run (model + hop budget)
pnpm --dir src/agents/current exec node --import tsx \
  src/scripts/hopRetrieveGate.ts \
  --ids runs/local-archive/backbone/hop27-ids.json \
  --annotations runs/local-archive/backbone/session-annotations-v1 \
  --hops 6 --model gpt-5.6-luna --reasoning low --concurrency 8 \
  --out runs/local-archive/backbone/hop-gate-luna-h6.json
```

**Key flags:** `--hops` (budget), `--model`, `--reasoning none|low|medium|high`, `--concurrency`, `--stratum`, `--limit`, `--ids_filter`, `--baselines-only`, and **`--prompt <name>`** (defaults to `hop-retrieve-v1`; this is the hook for swapping in v2).

**Harness notes / gotchas (already fixed, keep in mind):**
- `temperature` is **not supported** by the nano model via the Responses API — do not re-add it.
- Notes index dedupes `sessionIds` (via `new Set(...)`) in `buildNotesDocuments`/`grepNotes` to avoid `duplicate retrieval document ID` crashes.
- Over-budget searches are rejected with a nudge to `add_sessions`/`done`; two rejections ⇒ `hop_budget_exhausted`.
- `TokenBudgetGate` throttles to a 200k-token / 60s window at the chosen concurrency.
- Output JSON has `aggregate` (per-stratum + `all`) and full per-case `steps` traces.

---

## 3. Gate results so far (hop27, v1 prompt)

Full gold ⊆ bag, ALL = 27 cases; HARD = 17 cases.

| Run | Model | Hops | Reason | ALL full-gold | mean recall | HARD full-gold |
|---|---|---|---|---|---|---|
| baselines | none | — | — | 0/27* | 0.000 | 0/17 |
| nano-h3 | gpt-5.4-nano | 3 | medium | 16/27 | 0.783 | 9/17 |
| nano-h6 | gpt-5.4-nano | 6 | medium | 18/27 | 0.789 | 10/17 |
| nano-h9 | gpt-5.4-nano | 9 | medium | 17/27 | 0.812 | 9/17 |
| luna-h3 | gpt-5.6-luna | 3 | low | 21/27 | 0.886 | 12/17 |
| **luna-h6** | **gpt-5.6-luna** | **6** | **low** | **22/27** | **0.894** | **13/17** |
| luna-h9 | gpt-5.6-luna | 9 | low | 23/27 | 0.957 | 13/17 |

\* baselines-only does not run the agent (bag stays empty by design). The useful baseline signal is the notes-BM25 reference: **HARD notes-BM25 full-gold top-12 = 7/17**, phase-1 window top-12 = 9/17. So the Luna hop agent (13/17 hard) is clearly beating plain notes-BM25 and window BM25 on the hard slice.

**Takeaway:** Luna is the strong retriever; H=6 is the balanced operating point (H=9 only adds one case at higher cost). v1 already beats baselines. The teacher-swarm exists to squeeze the remaining hard misses via a better prompt (v2).

---

## 4. The teacher-swarm approach (why + how)

**Goal:** improve `hop-retrieve-v1.yaml` → `v2` using two independent evidence sources, then re-gate. Deliberately **anti-overfit**: rules must generalize, never name specific `question_id`s.

Two waves of **cold subagents** (fresh context, no chat bias), then a synthesis wave.

### Data prep — `buildHopTeacherPacks.ts`
Script: `src/agents/current/src/scripts/buildHopTeacherPacks.ts` (run via `pnpm --dir src/agents/current gate:hop-packs`).
Outputs under `runs/local-archive/backbone/hop-teach/`:
- `packs/<qid>.json` — **500** self-contained packs (question, notes, gold, haystack) — one per LongMemEval question.
- `ids-teach38.json` — the **38-question teach slice**: 27 hop27 ids + 11 hard misses from outside hop27 (`hard_outside_ids`).
- `batches-500.json` — 20 stratified batches (~25 qids each) covering all 500 for the corpus survey.

### Subagent definitions (`.cursor/agents/`)
- `hop-path-teacher.md` — reads ONE pack, writes the ideal hop path + reusable rules for that qid.
- `hop-corpus-surveyor.md` — reads one batch (~25 packs), writes one-line paths per qid + cross-cutting generalist rules.
- `hop-methodology-synthesizer.md` — merges everything into `SYNTHESIS.md` + `hop-retrieve-v2.yaml` (Wave C — not yet run).

### Wave A — 38 cold path teachers (DONE)
- Output: `runs/local-archive/backbone/hop-teach/methodology/per-qid/<qid>.md` (**38/38 present, all validated**).
- Each file has: Question gist / Gold sessions & cue phrases / Correct hop path / Failure modes / Reusable rules / Abstention note.
- Composition: hop27 (18 hard, 4 mid, 5 easy) + 11 hard-outside.

### Wave B — 20 corpus surveyors over all 500 (DONE)
- Output: `runs/local-archive/backbone/hop-teach/methodology/corpus/batch-01..20.md` (**20/20 present, all validated**, each ≥ ~25 qid bullets).
- Each has: Coverage / Per-qid paths / Cross-cutting rules / Anti-patterns.
- A stray `corpus/_batch16_raw.json` scratch file can be ignored/deleted.

---

## 5. What we did *just now* (this session)

1. **Validated the already-completed outputs** — confirmed the 34 teacher files + 17 corpus files that finished earlier were *complete* (all required sections, clean endings, real content — not truncated/stopped).
2. **Finished the 7 missing files** that had failed earlier on subagent usage limits, using cold subagents per the user's "Grok 4.5 only, fall back as needed" instruction:
   - Teachers (4): `81507db6`, `2318644b`, `2e6d26dc`, `32260d93` — via **Grok 4.5** (`cursor-grok-4.5-high-fast`).
   - Corpus (3): `batch-05`, `batch-16` — via **Composer 2.5**; `batch-09` — via **GPT-5.6** (Grok/Composer quota was exhausted mid-run).
3. **Final completeness check:** teach 38/38 (0 bad), corpus 20/20 (0 bad). Waves A & B marked complete.

> Model-availability caveat: only `cursor-grok-4.5-high-fast` is exposed as a Grok 4.5 slug in this environment (no "4.5 medium slow" variant). Usage limits were hit repeatedly, hence the mixed-model fallback for the last 3 batches.

---

## 6. What to continue (next steps, in order)

### Step 1 — Wave C: synthesize v2 (todo id `wave-c-synth`)
Run the `hop-methodology-synthesizer` subagent (cold). Point it at:
- `runs/local-archive/backbone/hop-teach/methodology/per-qid/*.md`
- `runs/local-archive/backbone/hop-teach/methodology/corpus/batch-*.md`
- `src/agents/current/prompts/hop-retrieve-v1.yaml`

It must write:
- `runs/local-archive/backbone/hop-teach/methodology/SYNTHESIS.md` — Must/Should/Avoid rules with evidence counts (seen in N/38 teach, M/20 corpus), plus type-specific addenda only where strongly supported.
- `src/agents/current/prompts/hop-retrieve-v2.yaml` — **same** `schema_version`, `required_variables`, and tool contract as v1; only juice STRATEGY / RULES / EXAMPLES. Generalist wording, **no qids**.

Guardrails: keep the storer/notes contract identical; drop any teach-only rule that contradicts corpus evidence; don't wire live retrieval code.

### Step 2 — Re-gate Luna H=6 on v2 (todo id `regate-luna`)
`--prompt` already exists in the gate. Run:
```bash
pnpm --dir src/agents/current exec node --import tsx \
  src/scripts/hopRetrieveGate.ts \
  --ids runs/local-archive/backbone/hop27-ids.json \
  --annotations runs/local-archive/backbone/session-annotations-v1 \
  --hops 6 --model gpt-5.6-luna --reasoning low --concurrency 8 \
  --prompt hop-retrieve-v2 \
  --out runs/local-archive/backbone/hop-gate-luna-h6-v2.json
```
Compare `aggregate.all.full_gold_in_bag` and `aggregate.hard.full_gold_in_bag` vs v1 luna-h6 (**22/27, hard 13/17**). Write a short results note recording the v1→v2 delta. Only "ship" v2 if hard full-gold improves without regressing easy/mid.

### Recurring themes to fold into v2 (from the methodology files)
- Prefer **entity/date/amount-shaped** queries over abstract labels ("preference comparison" is bad).
- **grep proper nouns** first for person→place / named-entity questions; notes often co-locate name+attribute in one fact.
- **add_sessions before done** — seeing a hit ≠ coverage; an empty bag with unused hits is the most common failure.
- Multi-session numeric/aggregate questions: retrieve *complementary facets* and de-dupe restated numbers.
- Temporal-delta questions need *both* endpoint sessions + dates.
- Recognize **no-evidence-in-notes** early (gold cue lives only in assistant turns) instead of looping; abstain when targeted evidence is truly absent.

---

## 7. File map (quick reference)

```
src/agents/current/
  prompts/hop-retrieve-v1.yaml          # current prompt (v2 goes beside it)
  src/scripts/hopRetrieveGate.ts        # offline gate (supports --prompt)
  src/scripts/buildHopTeacherPacks.ts   # builds packs / teach38 / batches-500
  src/retrieval/notesIndex.ts           # BM25 + grep over notes

.cursor/agents/
  hop-path-teacher.md
  hop-corpus-surveyor.md
  hop-methodology-synthesizer.md

runs/local-archive/backbone/
  hop27-ids.json                        # frozen 27-case eval slice
  hop-gate-*.json                       # gate results (nano/luna × h3/h6/h9, baselines)
  session-annotations-v1/               # frozen notes
  hop-teach/
    ids-teach38.json                    # 27 hop27 + 11 hard-outside
    batches-500.json                    # 20 stratified batches
    packs/<qid>.json                    # 500 packs
    methodology/
      per-qid/<qid>.md                  # Wave A — 38/38 DONE
      corpus/batch-01..20.md            # Wave B — 20/20 DONE
      SYNTHESIS.md                      # Wave C — TODO
      _batch16_raw.json                 # scratch, ignorable
```
