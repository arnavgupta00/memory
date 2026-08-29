# BEAM-1M atomic ingestion v0 results

## Decision

**Do not advance v0 to graph construction or retrieval.** The audited card set improves preservation
over Nano-only extraction, but fails the predeclared preservation, fidelity, and compression gates by
large margins. The primary canary failed, so the predeclared shadow conversation was not opened.

## Isolation and run

- Primary development conversation: BEAM-1M chat 18.
- Complete chronological source: 929 sessions, 2,612 turns, 1,220,778 `o200k_base` tokens.
- Ingestion input: raw sessions plus at most two preceding sessions; no question, answer, oracle,
  retrieval trace, or prior prediction was read before freeze.
- Extractor: `gpt-5.4-nano-2026-03-17`, low reasoning.
- Independent auditor: `gpt-5.6-luna`, medium reasoning.
- Semantic preservation judge: `gpt-5.6-luna`, high reasoning.
- Ingestion calls: 929 extractor plus 929 auditor calls.
- Recorded ingestion cost: **$13.8879**.
- Recorded valid evaluation cost: **$0.3187**; one quarantined invalid judge call cost $0.0019.

Frozen run:
`runs/beam-1m-atomic-ingestion-v0-20260809/primary/freeze-manifest.json`

## Card production and mechanical validation

| Metric | Nano only | Nano + Luna audit |
|---|---:|---:|
| Accepted cards | 18,591 | 29,978 |
| Accepted cards / session | 20.0 | 32.3 |
| Quarantined drafts or repairs | 12,805 | 3,158 |
| Quarantine rate | 40.79% | 9.53% |
| Accepted cards without exact provenance | 0 | 0 |
| Certified evidence atoms with a represented source turn | 32/41 | **41/41** |
| Certified stories with every source turn represented | 9/12 | **12/12** |
| Turn-disposition error sessions | 97 | 15 |
| Audit-index error sessions | n/a | 3 |

Accepted-card provenance is mechanically valid. The high quarantine rate is mostly caused by model
quote selectors whose prefix/suffix did not exactly match the source, followed by ambiguous quotes
and fabricated/non-verbatim quote text. The Luna audit repairs much of this, but does not eliminate
semantic loss or meaning-changing normalization.

## Semantic preservation

Two scopes are retained rather than choosing the more favorable result after the fact:

1. **Quote scoped:** the judge sees cards whose exact anchors overlap the recertified oracle quote.
2. **Turn scoped:** the judge sees every card anchored in the exact certified source turn. This is the
   fairer preservation measure because several recertified atom descriptions contain adjacent detail
   omitted from their quoted excerpt. It still never exposes another turn or session unless that turn
   is a certified source.

| Arm | Atom preservation | Complete stories | Critical contradiction/update/temporal stories |
|---|---:|---:|---:|
| Nano, quote scoped | 12/41 = 29.27% | 3/12 | 2/6 |
| Audited, quote scoped | 17/41 = 41.46% | 3/12 | 2/6 |
| Nano, turn scoped | 16/41 = 39.02% | 4/12 | 2/6 |
| **Audited, turn scoped** | **25/41 = 60.98%** | **5/12** | **4/6** |

Predeclared advancement requirements were at least 97% atoms, at least 11/12 complete stories, and
6/6 critical stories. No arm is close.

Among the 16 audited turn-scoped missed atoms:

- 11 are direct ingestion losses: omitted qualifiers, broken coreference, missing entity/relation
  binding, wrong actual/planned stance, or incomplete list/summary details;
- 3 require derived arithmetic or date differences that the query-blind cards do not represent;
- 2 require explicit chronological linking between earlier and later states.

Even if all five derived/chronological cases were credited to a future reasoning/link layer, the
optimistic ceiling would be only 30/41 = 73.17%, still far below the preservation gate.

On the 450 audited cards exposed to the turn-scoped judge, 17 unique cards were flagged as materially
unsupported by their displayed exact source quote: an observed support-fidelity rate of 96.22% on
this relevant-card sample, below the 99% target. Several failures change modality or attach a fact to
an entity/relation not entailed by the quoted span.

## Compression

The full immutable card artifact intentionally stores hashes, derivation metadata, and exact quote
anchors, so its size is reported separately from possible query-time projections.

| Audited representation | Tokens | Fraction of raw | Compression |
|---|---:|---:|---:|
| Normalized card text only | 487,181 | 39.91% | 2.51x |
| Compact text + routing metadata + source coordinates | 1,655,866 | 135.64% | 0.74x |
| Full canonical JSONL with provenance | 11,601,511 | 950.34% | 0.11x |

The predeclared searchable-index target was at most 25% of raw. Even the impossible production
lower bound—normalized text with no identifiers, provenance, type, time, or routing metadata—uses
39.91%. V0 therefore does not provide adequate context compression.

## What this establishes

The immutable raw archive plus exact source-span contract is sound and should be retained. Flat,
query-blind, exhaustive atomicization is not sufficient as the main reusable representation:

- atomizing every assistant list item causes card explosion;
- local two-session context does not reliably resolve long-range entities and temporal state;
- normalized cards can preserve a quote while changing its stance or binding;
- cross-session relations and derived facts are absent;
- an auditor that adds cards improves recall but worsens index size and still leaves direct losses.

This does not prove that graphs are ineffective. It proves that a graph built on this v0 card set
would inherit missing or distorted nodes, while increasing complexity. Per the stop condition, the
next ingestion design must repair the representation/extraction boundary before links are added.

## Artifacts

- Frozen ingestion: `runs/beam-1m-atomic-ingestion-v0-20260809/primary/freeze-manifest.json`
- Quote-scoped comparison: `runs/beam-1m-atomic-ingestion-v0-20260809/primary/evaluation/comparison.json`
- Turn-scoped comparison: `runs/beam-1m-atomic-ingestion-v0-20260809/primary/evaluation/comparison-turn.json`
- Nano cards: `runs/beam-1m-atomic-ingestion-v0-20260809/primary/cards-nano.jsonl`
- Audited cards: `runs/beam-1m-atomic-ingestion-v0-20260809/primary/cards-audited.jsonl`
