# BEAM-1M coverage-first compression workflow — 2026-08-08

## Status

The six-stage workflow is implemented and passes its local checks. Oracle
recertification certified 75/78 development cases and quarantined three; all
12 smoke cases have certified evidence atoms. The completed Luna-medium plus
Nano-low batch-8 smoke arm **failed** its advancement gate and remains
research-only.

The original total live-run ceiling was locked at **$10**:

- evidence-oracle recertification: at most **$2.50**;
- Luna-planner plus Nano-worker smoke test: at most **$7.50**.

The final worker resume was separately authorized with an additional ceiling
of **$4**. Successful Nano calls cost $3.1796; conservative process-level
exposure, including failed-call reservations, stayed below $3.23. The scripts
record API usage, estimated cost, latency, request ID, retry count, prompt
hash, model-visible messages, structured output, and deterministic validation
results.

## Six stages

### 1. Rebuild the measurement oracle

`recertifyBeamEvidenceOracle.ts` removes untrusted official source IDs from the
model-visible probe, retrieves candidate source messages, and asks Luna-medium
to split the expected answer into independently necessary evidence atoms with
exact message citations and verbatim quotes. A Luna-high second review is
required when the proposed sources change or the primary audit is uncertain.

Deterministic code only checks lossless facts: cited message existence, exact
quote containment, source-to-session/turn provenance, reviewer agreement, and
schema validity. It does not decide semantic relevance.

The no-cost preflight has materialized candidate packs for all **78** focused
answerable development questions. Candidate counts range from 62 to 244
(median 80; mean 87.18). The paid audit must finish before any preservation
score is treated as certified.

### 2. Seal a generalization holdout

`buildBeamCompressionCohorts.ts` creates a **40-question sealed holdout** from
the existing blind reserve: five questions for each of eight focused abilities,
spread across 17 unseen conversations. Selection is hash-based and blind to
question text, answers, rubrics, source evidence, and scores.

The holdout is not used for prompt development or the 12-case smoke decision.
Its checksum is pinned in `eval-slices/beam-1m/CHECKSUMS.sha256`.

### 3. Preserve the complete discovery union

`buildDiscoveryUnion` reconstructs every unique session returned by any sparse
or dense query in the initial or follow-up retrieval traces. It applies no
rank threshold, top-K cutoff, semantic filter, or session selection. Real
session IDs are converted to deterministic per-question opaque handles before
model calls.

This stage defines the discovery ceiling. Evidence absent here cannot be
recovered by the compressor; evidence present here is the compressor's
responsibility.

### 4. Plan compression globally with Luna

The same discovery union is tested with GPT-5.6 Luna at **medium** and **high**
reasoning. Luna receives all discovered sessions and produces a compact,
structured specification rather than the evidence package itself:

- answer contract and question mode;
- distinct story branches;
- must/should evidence facets and completion rules;
- update, contradiction, temporal, aggregate, and deduplication operations;
- worker instructions, coverage checklist, and novel-evidence policy.

The planner never selects sessions and never answers the question.

### 5. Extract in parallel with Nano workers

GPT-5.4 Nano-low workers inspect every discovery session under the global plan.
The default smoke configuration assigns one session per worker to minimize
cross-session omission; batch sizes 4 and 8 remain available for later cost
experiments. Workers return exact turn indexes, verbatim source quotes,
normalized facts, plan references, evidence type, confidence, and a flag for
relevant evidence that the plan did not anticipate.

There is no output-pool K and no relevance threshold after extraction. Every
valid grounded claim is retained.

### 6. Validate, assemble, and gate

Deterministic code is limited to exact validation and lossless assembly. It
rejects unknown sessions, unknown turns, fabricated quotes, and unknown plan
references. It does not score, rank, fuzzy-deduplicate, summarize, or truncate
claims.

The smoke test contains **12 development cases**: four summarization, four
multi-session reasoning, and four point-task controls. For both Luna-medium and
Luna-high it reports:

- discovery atom recall and complete-story coverage;
- compressed atom recall and complete-story coverage;
- represented sessions, claim count, rejected claims, characters, and tokens;
- exact token usage, cost, latency, and retry behavior.

Downstream answering remains blocked unless at least **11/12** smoke cases
preserve the complete recertified evidence story. The permanent BEAM
advancement requirement remains at least **85% complete-story preservation**
on an appropriately sized certified cohort; partial recall does not pass.

## Smoke result

The completed Luna-medium planner plus GPT-5.4 Nano-low batch-8 arm produced:

- discovery: **74/75 evidence atoms (98.67%)**, **11/12 complete stories**;
- compressed package: **29/75 evidence atoms (38.67%)**, **0/12 complete
  stories**;
- recertified gold-session preservation: **29/74 sessions (39.19%)**;
- mean pool size: 337.5 discovered sessions to 117.8 represented sessions;
- 6,436 accepted claims and 4,131 rejected claims;
- rejection causes: 2,066 non-verbatim quotes, 2,051 unknown plan references,
  and 14 invalid turn indexes;
- successful Nano-worker cost: **$3.1796**.

The evidence loss is therefore inside the Nano extraction/compression layer,
not discovery. The target required 11/12 complete stories; the observed 0/12
blocks downstream answer testing. Luna-high remains incomplete (4/12 planner
outputs saved) and was not run through Nano after the medium arm failed
decisively within the approved incremental ceiling.

## Implementation map

- Cohorts: `src/scripts/buildBeamCompressionCohorts.ts`
- Oracle recertification: `src/scripts/recertifyBeamEvidenceOracle.ts`
- Live smoke harness: `src/scripts/beamCompressionGate.ts`
- Schemas, discovery union, reducer, metrics: `src/compression/beamCompression.ts`
- API throttling, budget, logging: `src/compression/structuredCall.ts`
- Planner prompt: `prompts/beam-compression-plan-v1.yaml`
- Worker prompt: `prompts/beam-compression-worker-v1.yaml`
- Oracle prompts: `prompts/beam-evidence-recertify-v1.yaml` and
  `prompts/beam-evidence-recertify-review-v1.yaml`
- Tests: `tests/beamCompression.test.ts`

## Certification state

- Cohort construction: complete.
- Sealed-holdout checksum: complete.
- 78 oracle candidate packs: complete without model calls.
- TypeScript typecheck: passing.
- Test suite: 99/99 passing.
- Targeted lint for new files: passing.
- Paid oracle audit: 75/78 certified; three quarantined; all 12 smoke cases
  certified.
- Luna-medium plus Nano-low batch-8 smoke: complete; failed at 0/12 full-story
  preservation after compression.
- Luna-high planner: 4/12 saved; Nano-high-plan arm not started.

No prompt or architecture should be promoted from this implementation until
the paid audit and smoke result exist. A failed or sub-threshold result remains
research-only and must not be tuned against the sealed holdout.
