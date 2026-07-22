# Preserved baseline runs

The top level of this directory contains only definitive benchmark runs. Superseded, aborted,
diagnostic, and preflight runs are retained under `archive/` for auditability. Mutable future runs
remain ignored by Git; the files listed in `CHECKSUMS.sha256` are intentionally tracked as an
immutable audit trail.

## Definitive baseline

`baseline-canary-2-gpt-5-nano-20260722-v3` is the completed 60-case LongMemEval-S Canary-2
baseline:

- answer model: `gpt-5-nano-2025-08-07`
- canonical judge: `gpt-4o-2024-08-06`
- correct: 37/60 (61.67%)
- abstention: 8/10 (80%)
- unresolved failures: 0
- answer-generation estimate: $0.34821235

`predictions.jsonl.eval-results-gpt-4o` is the preserved interim 39-answer canonical snapshot.
`judgments.jsonl` is the authoritative final 60-answer judgment. The single entry in
`errors.jsonl` records a provider policy rejection that succeeded unchanged on resume; the final
manifest therefore correctly reports zero unresolved failures.

## Stabilization trail

The following non-definitive runs live under `archive/`:

- `baseline-preflight-openai-20260722`: GPT-4.1 credential and judging preflight.
- `baseline-canary-2-openai-20260722`: user-aborted GPT-4.1 canary attempt.
- `baseline-preflight-gpt-5-nano-20260722`: GPT-5 nano one-case canonical preflight.
- `baseline-preflight-gpt-5-nano-06878be2-20260722`: completion-budget diagnostic.
- `baseline-canary-2-gpt-5-nano-20260722`: aborted 800-token attempt.
- `baseline-canary-2-gpt-5-nano-20260722-v2`: aborted unpaced attempt.

The top-level `baseline-canary-2-gpt-5-nano-20260722-v3` directory is the definitive completed
baseline.

Verify every preserved artifact from the repository root:

```bash
shasum -a 256 -c runs/CHECKSUMS.sha256
```
