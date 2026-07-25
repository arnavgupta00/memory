# Architecture log

Canonical forward log for the active line of work. Rows for superseded architectures link into the
package that still holds their design records and diagrams.

| ID | Status | Design | Blind result | Notes |
|---|---|---|---|---|
| `0001-full-context` | Frozen baseline | [Markdown](../../architecture-0003.2-hybrid-graph-reader/architecture/0001-full-context.md) | 37/60 (61.7%) on canary-2 | Complete raw history in one answer call; runnable from `agents.baselines.full_context` |
| `0002-temporal-context-graph` | Archived | [Markdown](../../architecture-0003.2-hybrid-graph-reader/architecture/0002-hierarchical-temporal-context-graph.md) | — | Python temporal property graph and deterministic retrieval |
| `0003-contexto-shino-langgraph` | Recorded baseline | [Markdown](../../architecture-0003.2-hybrid-graph-reader/architecture/0003-contexto-shino-langgraph.md) | 1/6 six-case | Model-authored JSON Patch accepted only 12/97 Contexto batches |
| `0003.1-contexto-semantic-memory` | Superseded | [Study](../../architecture-0003.2-hybrid-graph-reader/architecture/0003.1-contexto-semantic-memory-study.md) | 6/6 fixed panel | Typed semantic updates and a deterministic reducer; the fixed panel was development data |
| `0003.2-hybrid-graph-reader` | Preserved, superseded | [Markdown](../../architecture-0003.2-hybrid-graph-reader/architecture/0003.2-hybrid-graph-reader.md) · [checkpoint](../../architecture-0003.2-hybrid-graph-reader/architecture/0003.2-CHECKPOINT-2026-07-24.md) | 14/18 then 11/18 | Gates 0–6 passed; neither blind attempt beat the far simpler baseline |
| `0004-session-retrieval-backbone` | Frozen | [ARCHITECTURE.md](../ARCHITECTURE.md) · [checkpoint](0004-CHECKPOINT-2026-07-26.md) | canary-2: **27/60** (`answer.yaml`) then **35/60** (`answer-v2-simple`) with `gpt-5.4-nano-2026-03-17` | Offline recall W2/S1/K48/80k → session hit 99.4%, answer-turn complete 87.0%. Oracle-context control on the 33 original wrongs stayed low (5/33), so the bottleneck was the answer prompt, not haystack size. `dev-60-v1` A/B: baseline 36.7% / simple 56.7% / rules 46.7%; winner `answer-v2-simple` is the default. Preference remains weak (2/10 on canary-2). Config `configs/architecture-0004-canary2-simple.yaml` |

## What the 0003.x line established

Two results carried forward rather than the machinery that produced them.

Recall was never the bottleneck. BM25 over raw sessions found the reference session in 17 of 18
blind cases, and in several losses the constructed graph missed a reference that BM25 had found. Six
of the seven answerable losses happened after retrieval had already succeeded.

Eighteen cases cannot settle an architectural question. One answer is worth 5.6 points and the
standard error near 65% is roughly 11 points, so 14/18 and 11/18 from essentially the same system
are the same measurement. The `single-session-assistant` type swung 0/3 to 3/3 between those two
runs. Per-type thresholds at n=3 were reading noise.

## Rules

Keep previous rows and design files immutable so every benchmark result can name the exact
architecture that produced it. Status may change when an architecture is superseded; results may be
added when new evidence arrives; claims may not be quietly revised.

Development sets are named and declared. `dev-9-v1` and `dev-60-v1` are contaminated by design and
are never reported as a result.
