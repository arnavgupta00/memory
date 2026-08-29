# Structured-event ingestion v1 — closed post-fix repair checklist

This checklist freezes the only blockers accepted after the 2026-08-11 cold
post-fix review. It does not add product requirements or move semantic judgment
from the LLM into deterministic code.

A repair is complete only when its deterministic fixture exists. No additional
finding may block L0 unless it demonstrates a reachable crash, silent evidence
loss/corruption, false pass/freeze/certification, spend-control bypass, or a
direct violation of an already-frozen non-negotiable in the v1 specification.

## Losslessness and lifecycle

- [ ] A repaired parent quarantine must end as a materialized same-root object
  or a child quarantine that cites it; it cannot become
  `no_semantic_content` and disappear.
- [ ] Attempt materialization results are finalized once, after host postchecks,
  so a preservation failure cannot retain an `accepted` result.
- [ ] Semantic-judge and adjudicator attempts are bound to the record they
  judge; the adjudicator cites exactly the two judge attempts as parents.
- [ ] Enriched searchable text contains allowlisted field labels/surfaces, never
  mention IDs or other internal identifiers.

## Evaluation truthfulness

- [ ] Development bounded rungs use a precision census. Certification cannot
  make a population claim until a cluster/design-aware method is implemented.
- [ ] Exact gates are frozen and evaluated for every obligation denominator ×
  criticality × stratum cell; critical misses cannot be offset by standard rows.
- [ ] Multiple confidence occurrences remain valid lineage and are represented
  without crashing or silently selecting an optimistic value.
- [ ] Accounting measures the serialized raw lexical index, separates real
  role/plane dimensions, reports indexed compact targets, distinguishes active
  quarantine backlog from history, and includes post-link provenance storage.
- [ ] Evaluation initializes cost from the frozen semantic-plus-link cost
  artifact, never a mutable convenience result.
- [ ] Combined readiness requires explicit semantic and link verdicts; an absent
  stage cannot count as success.

## Verification and governance

- [ ] L0 compares traceability against an independent frozen requirement-ID
  catalog and checks a fixture marker tied to each mapped requirement group.
- [ ] L1 covers active-versus-historical aggregation and support-enforced
  positive entailment.
- [ ] User acceptance preserves the exact result hash of the preceding passed
  transition, and L1 validates the complete prerequisite ledger chain.

## Explicitly non-blocking

- Style, naming, refactoring preferences, speculative future scale concerns,
  additional hardening, alternative architectures, and deterministic semantic
  classification are out of scope for this repair pass.
