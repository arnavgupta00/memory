#!/usr/bin/env python3
"""Export session-annotations-v1 cache to documented markdown files."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[5]
SRC = PROJECT_ROOT / "runs/local-archive/backbone/session-annotations-v1/_index.json"
OUT = PROJECT_ROOT / "runs/local-archive/backbone/session-annotations-v1/docs"
CHUNK = 400


def esc(text: str) -> str:
    return (text or "").replace("\r\n", "\n").replace("\r", "\n").strip()


def render_session(sid: str, ann: dict) -> str:
    facts = ann.get("facts") or []
    kps = ann.get("keyphrases") or []
    events = ann.get("events") or []
    lines = [f"### `{sid}`", ""]
    lines.append(
        f"- Facts: **{len(facts)}** · Keyphrases: **{len(kps)}** · Events: **{len(events)}**"
    )
    lines.append("")
    if facts:
        lines.append("#### Facts")
        lines.append("")
        for i, fact in enumerate(facts, 1):
            if isinstance(fact, dict):
                text = esc(str(fact.get("text", "")))
                ti = fact.get("turn_index")
                lines.append(f"{i}. *(turn {ti})* {text}")
            else:
                lines.append(f"{i}. {esc(str(fact))}")
        lines.append("")
    if kps:
        lines.append("#### Keyphrases")
        lines.append("")
        lines.append(", ".join(f"`{esc(str(k))}`" for k in kps))
        lines.append("")
    if events:
        lines.append("#### Events")
        lines.append("")
        for i, event in enumerate(events, 1):
            if isinstance(event, dict):
                text = esc(str(event.get("text", "")))
                hint = esc(str(event.get("date_hint", "") or ""))
                ti = event.get("turn_index")
                hint_bit = f" · date_hint: `{hint}`" if hint else ""
                lines.append(f"{i}. *(turn {ti}{hint_bit})* {text}")
            else:
                lines.append(f"{i}. {esc(str(event))}")
        lines.append("")
    if not facts and not kps and not events:
        lines.append("_No facts, keyphrases, or events extracted._")
        lines.append("")
    lines.append("---")
    lines.append("")
    return "\n".join(lines)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    raw = json.loads(SRC.read_text())
    sessions: dict = raw["sessions"]
    prompt = raw.get("prompt", "session-annotate-v1")
    model = raw.get("model", "gpt-5.4-nano-2026-03-17")

    n = len(sessions)
    nf = sum(len(a.get("facts") or []) for a in sessions.values())
    nk = sum(len(a.get("keyphrases") or []) for a in sessions.values())
    ne = sum(len(a.get("events") or []) for a in sessions.values())
    empty = sum(
        1
        for a in sessions.values()
        if not (a.get("facts") or a.get("keyphrases") or a.get("events"))
    )
    fact_counts = [len(a.get("facts") or []) for a in sessions.values()]
    kp_counts = [len(a.get("keyphrases") or []) for a in sessions.values()]
    ev_counts = [len(a.get("events") or []) for a in sessions.values()]

    sorted_ids = sorted(sessions.keys())
    parts = [sorted_ids[i : i + CHUNK] for i in range(0, len(sorted_ids), CHUNK)]
    part_paths: list[tuple[str, int, str, str]] = []

    for pi, chunk in enumerate(parts, 1):
        fname = f"annotations-part-{pi:02d}-of-{len(parts):02d}.md"
        path = OUT / fname
        body = [
            f"# Session annotations — part {pi} of {len(parts)}",
            "",
            f"Sessions `{chunk[0]}` … `{chunk[-1]}` ({len(chunk)} sessions).",
            "",
            "See [README.md](README.md) for methodology and schema.",
            "",
            "---",
            "",
        ]
        for sid in chunk:
            body.append(render_session(sid, sessions[sid]))
        path.write_text("\n".join(body))
        part_paths.append((fname, len(chunk), chunk[0], chunk[-1]))
        print(f"wrote {path} ({path.stat().st_size / 1e6:.2f} MB)")

    toc = "\n".join(
        f"| [{fn}]({fn}) | {cnt} | `{a}` … `{b}` |"
        for fn, cnt, a, b in part_paths
    )
    readme = f"""# Session annotations (v1) — documentation dump

Generated: {datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")}

This folder is a human-readable export of every index-time annotation produced for
the BM25 ranking upgrade (Phase 2 document expansion).

Machine-readable source of truth remains:

- Per session: `../<session_id>.json`
- Combined index: [`../_index.json`](../_index.json)

## Methodology

**What this is:** index-time **document expansion** for BM25 — not an ontology,
taxonomy, graph, or semantic layer.

**Shared contract (storer ↔ retriever):** both sides use natural-language English
terms. The storer writes words a future question might use; the retriever still
runs plain BM25 over session text with those terms appended. No controlled
vocabulary mapping.

**Storer model:** `{model}`  
**Prompt:** `{prompt}` (`src/agents/current/prompts/session-annotate-v1.yaml`)  
**Input:** user turns only (assistant replies omitted)  
**Unit of annotation:** one chat session (one LLM call per unique session)

Each session yields three lists:

| Field | Role |
|---|---|
| `facts` | Exhaustive enumerated personal facts (not summaries), each tagged with `turn_index` |
| `keyphrases` | Short noun phrases a user might type in a question |
| `events` | Dateable event mentions with `date_hint` + `turn_index` (for optional time filtering) |

Facts are meant to be **appended into BM25 text** (key merging), either session-wide
or turn-anchored to windows containing `turn_index`.

## Corpus stats

| Metric | Value |
|---|---:|
| Unique sessions annotated | {n:,} |
| Total facts | {nf:,} |
| Total keyphrases | {nk:,} |
| Total events | {ne:,} |
| Empty sessions (no fields) | {empty:,} |
| Mean facts / session | {nf / n:.1f} |
| Mean keyphrases / session | {nk / n:.1f} |
| Mean events / session | {ne / n:.1f} |
| Median facts / session | {sorted(fact_counts)[len(fact_counts) // 2]} |
| Median keyphrases / session | {sorted(kp_counts)[len(kp_counts) // 2]} |
| Median events / session | {sorted(ev_counts)[len(ev_counts) // 2]} |

## Schema (per session)

```json
{{
  "session_id": "…",
  "prompt": "{prompt}",
  "facts": [
    {{ "text": "I have a 2015 Honda Civic.", "turn_index": 0 }}
  ],
  "keyphrases": ["2015 Honda Civic", "car upgrade"],
  "events": [
    {{ "text": "Birthday coming up", "date_hint": "April 10th", "turn_index": 6 }}
  ]
}}
```

## Offline gate outcome (context)

On canary-1 answerable (n=135), stacking these expansions on Phase-1 BM25
improved secondary metrics (mean gold rank, NDCG) but **did not move** primary
case-level top-5 coverage beyond Phase 1 alone (79.3%). Annotations are retained
for analysis and future experiments. See
[`../../BM25-RANKING-UPGRADE-RESULTS.md`](../../BM25-RANKING-UPGRADE-RESULTS.md).

## File index

Sessions are sorted by `session_id` and split into parts of up to {CHUNK} sessions.

| File | Sessions | Range |
|---|---:|---|
{toc}

## How to regenerate

```bash
# Re-annotate (disk cache; only missing sessions call the model)
pnpm --dir src/agents/current exec node --import tsx \\
  src/scripts/sessionAnnotate.ts \\
  --slice answerable \\
  --cache runs/local-archive/backbone/session-annotations-v1 \\
  --concurrency 24

# Rebuild this markdown dump
python3 src/agents/current/src/scripts/exportAnnotationsDocs.py
```
"""
    (OUT / "README.md").write_text(readme)
    print(f"wrote {OUT / 'README.md'}")

    catalog = [
        "# Annotation catalog (counts only)",
        "",
        "Quick index of every session without full text. Full content is in the part files listed in [README.md](README.md).",
        "",
        "| session_id | facts | keyphrases | events | part |",
        "|---|---:|---:|---:|---:|",
    ]
    for i, sid in enumerate(sorted_ids):
        ann = sessions[sid]
        part = i // CHUNK + 1
        catalog.append(
            f"| `{sid}` | {len(ann.get('facts') or [])} | {len(ann.get('keyphrases') or [])} | "
            f"{len(ann.get('events') or [])} | {part:02d} |"
        )
    catalog_path = OUT / "CATALOG.md"
    catalog_path.write_text("\n".join(catalog) + "\n")
    print(f"wrote {catalog_path} ({catalog_path.stat().st_size / 1e6:.2f} MB)")
    print(f"done: {len(parts)} parts, {n} sessions")


if __name__ == "__main__":
    main()
