# BEAM-1M evidence-contract checkpoint — 2026-08-30

This checkpoint freezes the complete repository source state immediately before the BEAM
evidence-contract and final-answer-preservation implementation. Ignored run outputs, local virtual
environments, package caches, and credentials are deliberately not committed.

## Recovery references

- Pre-checkpoint HEAD: `e6c1381ce1989726d5a3a89b3c52b12814f6d45f`
- Checkpoint branch: `codex/checkpoint-beam-74p10-20260830`
- Annotated tag: `checkpoint-beam-74p10-pre-evidence-contract-20260830`
- Implementation branch: `codex/beam-evidence-contract-v1`
- Remote: `origin`

The checkpoint commit contains all 81 visible source-tree changes present at preflight—five tracked
modifications and 76 untracked code, prompt, test, evaluation-manifest, and architecture files—plus
this checkpoint manifest.

## Frozen measured state

- Official BEAM Canary A score: **74.10%**
- Paired-control score: **72.69%**
- Recertified complete-story preservation: **65/75 = 86.67%**
- Quarantined oracle cases: **3**
- Mean K=81 raw final package: **110,458 estimated tokens**
- Mean hydrated candidate sessions: **76.13**
- Final answerer: `gpt-5.6-luna`, high reasoning
- Official judged-ability evaluator: pinned BEAM judge with `gpt-4.1-mini`

## Frozen local artifact fingerprints

These files remain under the ignored `runs/` tree. Their hashes identify the exact local evidence
used by the checkpoint without forcing 7.7 GB of run data into Git.

| Artifact | SHA-256 |
|---|---|
| `runs/beam-1m-k81-downstream-20260806/retrieval/k81-mmr085-focused-answerable78.json` | `2705afb10689b7ba9073452f0e67d53e088ad3dcfbc390a97916b9a7f586612e` |
| `runs/beam-1m-k81-downstream-20260806/retrieval/k81-mmr085-claims-retry2.json` | `4dee4b3a96019b3a1bb5a53c7eb4ed9eff008d19d88800e1ec4d78f1bdc8b8d1` |
| `runs/beam-1m-k81-downstream-20260806/downstream/beam-k81-raw-focused78-r2-20260806-4/manifest.json` | `ed92514f6119aed8b72c26aa2318d14c8b775889d218d63f8601e8b0f782e452` |
| `runs/beam-1m-k81-downstream-20260806/downstream/beam-k81-raw-focused78-r2-20260806-4/predictions.jsonl` | `1c43e817d7d6242ed5e9543a696d533aa087e720c2da3adac99dea49a1a2d29a` |
| `runs/beam-1m-k81-downstream-20260806/final-prompts/manifest.json` | `ae0fef3f63c3d108d00a72d16125008ded52e39f0ff8b99594d49f82c87f8ffe` |
| `runs/beam-1m-k81-downstream-20260806/layer-diagnostic.json` | `f05e17a95f9ca9ef44a6596caedcb742590e6e872e13a28bf8278f140de801f3` |
| `runs/beam-1m-k81-downstream-20260806/beam-official-summary-raw.json` | `8097964b49d0b82206941506f9c5f6bc01c1be42497f6a07a5210def0676e3d3` |

## Baseline validation

- `git diff --check`: pass
- Secret preflight: local `.env` detected but ignored; no credential-bearing source file staged
- `pnpm --dir src/agents/current test`: pass, 32 files and 210 tests
- `pnpm --dir src/agents/current typecheck`: pre-existing fail in the uncommitted structured-event
  and compression successor work. The failures were recorded before evidence-contract implementation
  and include `structuredCall.ts`, structured-event evaluation/materialization/ingestion, and their
  tests. New work must introduce no additional typecheck errors.

## Scope after this checkpoint

The next branch changes only the answer-side contract, evidence-map presentation, and final-answer
preservation path. Frozen K=81 retrieval, fusion, ingestion, and official judge behavior remain
unchanged.
