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
| `0004-session-retrieval-backbone` | Frozen (prior) | [ARCHITECTURE.md](../ARCHITECTURE.md) · [checkpoint](0004-CHECKPOINT-2026-07-26.md) | canary-2: **27/60** (`answer.yaml`) then **35/60** (`answer-v2-simple`) with `gpt-5.4-nano-2026-03-17` | Offline recall W2/S1/K48/80k → session hit 99.4%, answer-turn complete 87.0%. Oracle-context control on the 33 original wrongs stayed low (5/33), so the bottleneck was the answer prompt, not haystack size. `dev-60-v1` A/B: baseline 36.7% / simple 56.7% / rules 46.7%; winner `answer-v2-simple`. Preference remains weak (2/10 on canary-2). Config `configs/architecture-0004-canary2-simple.yaml` |
| `0004.1-evidence-medium` | Frozen (prior) | [ARCHITECTURE.md](../ARCHITECTURE.md) · [checkpoint](0004.1-CHECKPOINT-2026-07-26.md) · [evolution](0004.1-EVOLUTION.md) | canary-2: **51/60 (85.0%)**; `dev-60-v1` (contaminated): **54/60 (90.0%)** | Same BM25 backbone. Ladder on `dev-60-v1`: simple/none 56.7% → simple/low 76.7% → simple/medium 88.3% → evidenceTable/medium **90.0%**. Canary-2 confirmation with `answer-v2-evidence` + medium: **51/60** vs prior simple/none **35/60**. Configs: `architecture-0004-dev60-evidence.yaml`, `architecture-0004-canary2-evidence-medium.yaml` |
| `0004.2-map-fix-evidence` | Frozen (prior) | [ARCHITECTURE.md](../ARCHITECTURE.md) · [checkpoint](0004.2-CHECKPOINT-2026-07-27.md) | canary-2: **54/60 (90.0%)**; pop-weighted **86.0%**; abstention **10/10** | Keep non-empty hypothesis when `insufficient`; tighten evidenceTable (dated/exhaustive/entity match); allow assistant turns for assistant-recall. Fix1 overcorrected to user-only and broke assistant (10→6); fix2 restored. Run `20260726T210601.195536Z-architecture-0004-canary2-evidence-medium`. Residual: multi-session aggregation, incomplete temporal sets, preference meta-gold. |
| `0005-context-service` | Active / measured | [ARCHITECTURE.md](../ARCHITECTURE.md) · [design](0005-context-service.md) | canary-2: **50/60 (83.3%)**; pop-weighted **83.2%**; package sufficiency **48/60 (80%)** vs bundle ceiling **54/60 (90%)**; package ~1.9k tokens (~8.8× compact vs 16.6k) | Broad BM25 → `selectContext` (catalog + completeness expansion) → `answer-v3-package`. Accuracy −4 vs 0004.2 is a tie at n=60. Outsider audit: Call 1→2 handoff poisoned (84% expansion filler; completenessNote pre-answers). |
| `0005.1-tiered-package` | Measured (prior) | [ARCHITECTURE.md](../ARCHITECTURE.md) · [design](0005.1-tiered-package.md) | canary-2: **50/60 (83.3%)**; abs **9/10**; pop-weighted **86.9%**; package sufficiency **44/60 (73%)**; selected-tier **35/60 (58%)**; ~1.0k package tokens | Handoff repair hit abstention target. Multi-session 10/10, KU 9/10. Sufficiency below ceiling (selector under-picks; supporting tier still needed). Preference 5/10. Run `20260726T234539.240142Z-architecture-0005.1-canary2-tiered-package`. Config `architecture-0005.1-canary2-tiered-package.yaml`. |
| `0005.2-select-complete` | Frozen (prior) | [ARCHITECTURE.md](../ARCHITECTURE.md) · [design](0005.2-select-complete.md) · [checkpoint](0005.2-CHECKPOINT-2026-07-27.md) | canary-2: **50/60 (83.3%)**; abs **9/10**; pop-weighted **78.9%**; package sufficiency **46/60 (77%)**; selected-tier **38/60 (63%)**; ~1.2k package tokens | Closed Call2 false-abstention hole (handed+refused 4→0; answerable abstentions 7→3). Preference 7/10, user 10/10. Lost multi-session/temporal set cases; Call 1 still under-covers aggregate sets. Run `20260727T002519.742566Z-architecture-0005.2-canary2-select-complete`. Config `architecture-0005.2-canary2-select-complete.yaml`. |
| `0005.3-session-first` | Frozen (prior) | [ARCHITECTURE.md](../ARCHITECTURE.md) · [design](0005.3-session-first.md) · [checkpoint](0005.3-CHECKPOINT-2026-07-27.md) | canary-2: **54/60 (90.0%)**; abs **10/10**; pop-weighted **92.0%**; package sufficiency **49/60 (82%)**; ~1.6k package tokens; **~$0.29** | Sibling-session SUPPORTING for aggregate/order + select-v4. Ties 0004.2 freeze (+$0.05, ~10× smaller answer context, +6 pp pop-weighted). Residual preference + `gpt4_7fce9456`. Run `20260727T012805.980741Z-architecture-0005.3-canary2-session-first`. |
| `0005.4-full-session` | Frozen (prior) | [ARCHITECTURE.md](../ARCHITECTURE.md) · [design](0005.4-full-session.md) · [checkpoint](0005.4-CHECKPOINT-2026-07-28.md) | canary-1: **124/150 (82.7%)**; abs **14/15**; pop-weighted **83.3%**; package sufficiency **86.3%**; **~$0.75** | Full-session reach for sessions already in the BM25 bundle. Answer = nano medium + `answer-v5-package`. Config `architecture-0005.4-canary1-full-session.yaml`. |
| `0005.4 + Luna low` | Measured / rolled back | [checkpoint](0005.4-CHECKPOINT-2026-07-28.md) | canary-1: **127/150 (84.7%)**; abs **13/15**; **~$1.35** | Call-2 only swap to `gpt-5.6-luna` / low. Best package-era Call-2 so far; not active after medium regress + operator rollback to nano. Run `20260728T105145.159710Z-architecture-0005.4-canary1-answer-luna`. |
| `0005.4 + Luna medium` | Measured / rejected | [checkpoint](0005.4-CHECKPOINT-2026-07-28.md) | canary-1: **124/150 (82.7%)**; abs **14/15**; **~$1.41** | −3 vs Luna low. Run `20260728T122948.376668Z-architecture-0005.4-canary1-answer-luna-medium`. |
| `0007 format middle-agent` | Killed (canary-2) | [checkpoint](0005.4-CHECKPOINT-2026-07-28.md) | replacement **51/60**; additive **52/60** (lost 3 each vs free 53/60) | Nano formatter + digest/hybrid answer prompts. Code gated off (`format_enabled: false`). |
| `0005.5-answer-v6` | Preserved / measured | [design](0005.5-answer-v6.md) · [checkpoint](0005.5-CHECKPOINT-2026-07-27.md) | canary-2: **54/60**; abs **10/10**; canary-1: **124/150**; abs **13/15** | Call-2 enumerate-then-count + date arithmetic. Tied accuracy; abstention −1. Kept on disk, not active. |
| `0006-session-routing` | Preserved / measured | [design](0006-session-routing.md) · [checkpoint](0006-CHECKPOINT-2026-07-28.md) | canary-2: **50/60**; canary-1: **122/150 (81.3%)**; abs **14/15**; **~$1.21** | Session index + series expand + expandSessions. Offline series gate 8/8; live below 0005.4. Kept on disk, not active. |
| `U-WINDOW` | Killed | [checkpoint](0005.4.3-CHECKPOINT-2026-07-29.md) | slice 13/20 → 11/20 | `window_turns` 2→5; span char-budget collapse. |
| `U-FLOOR` | Measured / not pass | [checkpoint](0005.4.3-CHECKPOINT-2026-07-29.md) | slice 13/18 → 14/18 (+1/−0) | Lexical BM25 supporting floor; empty-package only. Kept off. |
| `0005.4.3-preference` | Preserved / frozen | [design](0005.4.3-preference.md) · [checkpoint](0005.4.3-CHECKPOINT-2026-07-29.md) | slice **25/28** pref **14/15**; canary-1 answer-replay **126/150** pref **11/15** abs **15/15** (+4/−2) | Call-2 `answer-v8-preference` on K48/80k package. |
| `select-v6-sweep` | Killed | [checkpoint](0005.4.4-CHECKPOINT-2026-07-29.md) | slice **11/19 → 10/19** (+0/−1) | Prompt-only catalog-sweep selector (U-SETFILL probe). Selector picks ~2.1 of ~24.8 offered sessions and the sweep instruction moved that by +0.1 — under-picking is not prompt-addressable. Separately measured: complete gold coverage **10/11** correct vs incomplete **1/8**, so the bucket is real and needs a non-prompt lever. |
| `0005.4.4-breadth` | **Active / frozen 2026-07-29** | [ARCHITECTURE.md](../ARCHITECTURE.md) · [design](0005.4.4-breadth.md) · [freeze](0005.4.4-CHECKPOINT-2026-07-29.md) · [**resume**](0005.4.4-RESUME-CHECKPOINT-2026-07-29.md) | canary-1 **126/150** pref **12/15** abs **13/15** (+9/−7 vs 0005.4; tied vs v8-replay); offline **132/135**; slice **12/14** | U-BREADTH + U-PREF. Run `architecture-0005.4.4-canary1-breadth`. Abs watched. Next: forced-coverage before U-SETFILL. |

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
