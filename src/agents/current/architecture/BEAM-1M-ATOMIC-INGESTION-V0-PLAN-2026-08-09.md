# BEAM-1M atomic ingestion v0 plan

## Scope

This phase builds and evaluates ingestion only. It does not implement question-time retrieval,
answering, live incremental additions, or a production graph traversal. The ingester is query-blind:
it receives chronological raw sessions and never receives benchmark questions, answers, evidence
IDs, retrieval traces, or prior failure analyses.

## Decision

Use an immutable dual-plane store:

1. a byte-preserved raw episode archive;
2. immutable atomic cards with exact source-span provenance.

Sparse typed links are a later, rebuildable overlay. A card does not depend on an entity merge,
edge, graph mutation, summary, or current-state decision to survive ingestion.

This inverts Architecture 0003.2. That line made a constructed graph operationally important and
the first graph author accepted only 12/97 batches; later blind runs scored 14/18 and 11/18 without
beating the simpler baseline. The useful ideas—query-blind construction, temporal observations,
append-only provenance, and raw fallback—remain. Canonical graph mutation, semantic paths, and
model-authored whole-state changes do not.

## Alternatives considered

| Representation | Evidence | Decision |
|---|---|---|
| Session summaries | Compact and good for broad themes, but abstraction can omit exact quantities, polarity, and updates. RAPTOR reports minor hallucinations in roughly 4% of audited summaries. | Reject as canonical; optional later view. |
| Canonical entity graph | Helps connected/global questions, but extraction and entity-resolution errors cascade. The repository's 0003.x line already demonstrated write loss and missed graph evidence. | Reject as canonical. |
| Flat atomic propositions | Fine-grained propositions improved retrieval over passages in Dense X Retrieval. They remain vulnerable to non-atomic, non-standalone, or unsupported generations. | Use with exact provenance and audit. |
| Mutable personal profile | Efficient for current-state questions, but overwrites history and silently destroys contradictions or old values. | Reject. |
| Atomic cards plus optional event links | Separates retrieval anchors from immutable raw evidence and can represent updates without overwriting. AnchorMem and APEX-MEM independently support this separation. | Select. |

Primary sources:

- Dense X Retrieval: <https://arxiv.org/abs/2312.06648>
- Claimify claim-extraction methodology: <https://www.microsoft.com/en-us/research/blog/claimify-extracting-high-quality-claims-from-language-model-outputs/>
- RAPTOR: <https://arxiv.org/abs/2401.18059>
- GraphRAG indexing architecture: <https://github.com/microsoft/graphrag/blob/main/docs/index/architecture.md>
- APEX-MEM: <https://aclanthology.org/2026.acl-long.749/>
- AnchorMem: <https://aclanthology.org/2026.findings-acl.1736/>
- W3C Web Annotation source selectors: <https://www.w3.org/TR/annotation-model/>
- W3C PROV-O provenance model: <https://www.w3.org/TR/prov-o/>

## Canonical card

One card represents one independently truth-valued assertion, event, state, preference, intention,
decision, instruction, relationship, measurement, correction, or outcome. `kind` is a broad routing
hint rather than a domain ontology.

Every card records:

- standalone normalized text;
- subject, predicate, object/value, polarity, modality, and source stance;
- entities as unresolved surface mentions;
- the raw temporal phrase plus optional normalized interval and precision;
- one or more exact quote anchors into raw turns;
- assertion/session time separately from event-valid time;
- deterministic card and source hashes;
- model, prompt, schema, and run provenance.

Old values, corrections, disagreements, and duplicate reports remain separate cards. Later links
may label `UPDATES`, `SUPERSEDES`, `CONTRADICTS`, or `DUPLICATE_OF`; they never delete or rewrite a
card.

## Extraction workflow

### Stage A — deterministic raw archive

Preserve every turn exactly, assign stable host-side message IDs and SHA-256 hashes, and expose only
opaque session handles to models.

### Stage B — exhaustive card enumerator

For each target session, `gpt-5.4-nano` reads that complete session plus at most two preceding
sessions as disambiguation context. It emits cards only for the target session. Both USER and
ASSISTANT turns are eligible; questions, hypotheticals, recommendations, adopted decisions, and
reported facts retain distinct stance labels.

The model emits exact quotations, not offsets. Generous output ceilings are technical safety limits,
not desired card-count caps.

### Stage C — lossless validation

Code resolves each quote against the declared raw turn, records exact character offsets and hashes,
and quarantines unknown, missing, or ambiguous anchors. Deterministic validation never judges
semantic importance and never synthesizes a card.

### Stage D — independent coverage critic and one repair

`gpt-5.6-luna` at medium reasoning receives the source window and validated draft cards. It may
reject unsupported/non-atomic cards, replace a malformed card, and add omitted cards. Repairs pass
through the same lossless validator. Every target turn receives either card IDs or an explicit
no-card disposition.

The gate records both outputs, so Nano-only and Nano-plus-Luna can be compared on the identical
history. No best-of-run selection is allowed.

### Stage E — freeze before evaluation

Freeze source, prompt, schema, model, configuration, call-trace, accepted-card, and quarantine
hashes. Only after that freeze may the evaluator open the probe manifest and recertified evidence
oracle.

### Stage F — graph overlay deferred

No cross-session entity merge, community summary, generic `RELATED_TO` edge, current-truth winner,
or transitive closure is part of the v0 advancement gate. Missing cards cannot be repaired by a
graph. If card preservation passes, sparse typed link extraction becomes the next independently
tested ingestion substage.

## Falsifiable evaluation

The primary canary is one complete BEAM-1M development conversation selected by SHA-256 rank from
eligible Canary-A conversations using seed `beam-1m-atomic-ingestion-dev-v1`. Conversation 18 ranks
first. Conversation 3 is the predeclared shadow replication. Neither uses the existing sealed
compression holdout.

Twelve probes are selected by hash within declared ability strata using seed
`beam-1m-atomic-ingestion-probes-v1`: two each for contradiction resolution, knowledge update,
temporal reasoning, and summarization; one each for information extraction, instruction following,
multi-session reasoning, and preference following.

For each oracle atom, the evaluator first finds cards whose exact source spans overlap an accepted
oracle source. A blinded semantic judge then decides whether those cards actually express the atom.
Turn overlap alone is reported only as a compatibility metric and cannot pass the gate.

## Advancement gates

| Metric | Required |
|---|---:|
| Forbidden-input audit and complete chronological source | 100% |
| Exact provenance resolution for accepted cards | 100% |
| Strict semantic evidence-atom recall | at least 97% |
| Complete evidence stories | at least 11/12 |
| Contradiction/update/temporal complete stories | 6/6 |
| Supported-card precision on blinded sample | at least 99%; zero critical hallucinations |
| Atomicity | at least 98% |
| Entity, number, unit, polarity, and date fidelity | at least 98% each; zero critical swaps |
| Both sides of certified corrections/contradictions retained | 100% |
| Canonical card-index tokens / exact raw-history tokens | at most 25% |
| P95 serialized card size | at most 160 tokens |
| Accepted cards per million source tokens | at most 5,000 |

Cost and latency are recorded, not advancement blockers for this phase. The production question is
whether the reusable ingestion artifact supports later compact retrieval; one-time test cost is not
optimized before preservation works.

## Stop conditions

- If Nano-only passes, the Luna critic must justify itself through measurable recall or fidelity.
- If audited cards miss more than 3% of evidence atoms, do not add graph complexity; repair card
  extraction first.
- If provenance is not perfect, the run is invalid regardless of semantic scores.
- If the primary passes, freeze the design and run the predeclared shadow conversation without
  prompt changes. Only then may card linking or question-time retrieval begin.
