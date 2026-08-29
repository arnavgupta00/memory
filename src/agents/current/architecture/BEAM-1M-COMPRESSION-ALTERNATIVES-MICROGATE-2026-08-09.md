# BEAM-1M alternative compression micro-gate — 2026-08-09

## Status

Implemented, locally certified, and tested with live GPT-5.6 Luna-medium calls
on the frozen four-case development micro-gate. The adaptive coverage explorer
passed. The conservative session router and global story compiler failed for
opposite reasons.

The prior Luna-plan plus Nano-claim compressor retained 29/75 evidence atoms
and 0/12 complete stories even though discovery contained 74/75 atoms and
11/12 complete stories. These alternatives remove generated claims from the
evidence path. Models emit only opaque source addresses; deterministic code
copies original turns or sessions byte-for-byte.

## Arm 1 — conservative session router

GPT-5.6 Luna-medium reads every discovery session in whole-session shards below
180,000 estimated tokens. One structured response applies two separate
relevance lenses: direct answer support and indirect contextual support. A
session is discarded only if both lenses mark its opaque handle safe to drop.
Missing or malformed shard output retains the entire shard.

The approved cold-agent design proposed two API passes. The micro-gate combines
the two lenses into one call per shard. The semantic discard rule remains a
two-lens intersection, but this screen does not test independence across two
model samples.

Output evidence consists of complete retained raw sessions. No quotations,
summaries, claims, or plan identifiers are generated.

## Arm 2 — global source-pointer story compiler

One Luna-medium call per question reads the entire discovery union and emits a
set of story branches containing only opaque session and turn coordinates.
Deterministic code validates the coordinates, adds a two-turn context halo,
merges overlapping ranges, and copies original turns. It upgrades dispersed or
large selections to the complete source session. Any invalid coordinate fails
open to the complete union, which preserves recall but fails the compression
budget.

## Arm 3 — adaptive coverage explorer

1. Luna-medium creates a question-only obligation ledger.
2. Parallel Luna-medium shard scouts inspect every discovery session and emit
   only raw-source coordinates plus routing labels.
3. A global auditor receives the provisional raw evidence and a deterministic
   shard catalog. It checks every obligation and requests repair shards.
4. Repair scouts re-read at most 35% of the discovery-union token estimate.
5. Initial and repair pointers are unioned and rehydrated from original turns.

Generated obligation descriptions and routing labels never count as evidence.
A failed or unparseable scout retains its affected raw shard. Invalid individual
pointers are rejected and logged without changing the original evidence. A
failed global audit retains the complete discovery union.

## Frozen micro cohort

`beam-1m-compression-micro4-v1.json` contains four certified,
discovery-complete development questions: one summarization, one multi-session
reasoning, one information-extraction, and one instruction-following case.
Selection is SHA-256 based within the declared strata and excludes the sealed
holdout, answers, gold-session positions, and prior compressor results.

This is a falsification screen, not an estimate of the population score.

## Advancement gate

Each arm must satisfy all of:

- 4/4 complete recertified evidence stories;
- at least 97% evidence-atom recall;
- at most 50% of discovery tokens retained on every case;
- at most 0.5% rejected invalid source-pointer suggestions.

Cost is recorded for observability but is not an advancement condition. Runtime
calls use generous output ceilings because reasoning exhaustion or truncated
structured output must not be misclassified as an architecture failure.

A passing arm only earns a later 12-case development run. It does not authorize
use of the sealed holdout or establish the permanent 85% target.

## Live micro-gate results

| Arm | Complete stories | Atom recall | Mean retained | Worst retained | Result |
|---|---:|---:|---:|---:|---|
| Session router | 4/4 | 100% | 87.46% | 95.02% | Fail: almost no compression |
| Story compiler | 1/4 | 80% | 11.17% | 18.08% | Fail: evidence loss |
| Coverage explorer | 4/4 | 100% | 35.62% | 40.93% | **Pass** |

The coverage explorer preserved all 25/25 certified evidence atoms and all
12/12 gold sessions. Its per-case retained fractions were 40.93%, 39.84%,
29.95%, and 31.75%, or 2.81x average context compression. It proposed two
invalid opaque pointers among roughly 621 suggestions (0.322%); both were
rejected mechanically and neither caused evidence loss or a fail-open case.

Successful-call costs were $0.5242 for the router, $1.0204 for the compiler, and
$1.1168 for the explorer. These are measurements only. The selected architecture
is the coverage explorer; the sealed holdout remains untouched.

## Implementation map

- Gate: `src/scripts/beamCompressionAlternativesGate.ts`
- Schemas and lossless materialization:
  `src/compression/beamCompressionAlternatives.ts`
- Prompts: `prompts/beam-compression-session-router-v1.yaml`,
  `prompts/beam-compression-story-compiler-v1.yaml`,
  `prompts/beam-compression-coverage-ledger-v1.yaml`,
  `prompts/beam-compression-shard-scout-v1.yaml`, and
  `prompts/beam-compression-coverage-audit-v1.yaml`
- Cohort: `eval-slices/beam-1m/beam-1m-compression-micro4-v1.json`
- Tests: `tests/beamCompressionAlternatives.test.ts`
