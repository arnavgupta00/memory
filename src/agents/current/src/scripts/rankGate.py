#!/usr/bin/env python3
"""
Offline BM25 ranking gate for LongMemEval canary slices.

Reproduces src/agents/current BM25 + tokenize (validated against run artifacts)
and reports case-level top-N gold coverage, median gold rank, Recall@5, NDCG@5.

Usage:
  python3 src/agents/current/src/scripts/rankGate.py \\
    --run runs/architecture-0005.4.4-canary1-breadth \\
    --variant baseline \\
    --slice answerable

  python3 src/agents/current/src/scripts/rankGate.py --sweep-phase1 --slice answerable
  python3 src/agents/current/src/scripts/rankGate.py --variant useronly --annotations path/to/cache \\
    --expansion facts-anchored --slice hard50
"""
from __future__ import annotations

import argparse
import json
import math
import re
import statistics as st
import sys
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

PROJECT_ROOT = Path(__file__).resolve().parents[5]
DEFAULT_DATASET = PROJECT_ROOT / "data/raw/longmemeval_s_cleaned.json"
DEFAULT_ORACLE = PROJECT_ROOT / "data/raw/longmemeval_oracle.json"
DEFAULT_RUN = PROJECT_ROOT / "runs/architecture-0005.4.4-canary1-breadth"

STOP = {
    "a", "an", "and", "are", "as", "at", "be", "by", "did", "do", "does", "for",
    "from", "had", "has", "have", "how", "i", "in", "is", "it", "many", "me",
    "my", "of", "on", "or", "the", "to", "was", "were", "what", "when", "where",
    "which", "who", "with",
}
TEMP = {
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    "january", "february", "march", "april", "may", "june", "july", "august",
    "september", "october", "november", "december", "today", "yesterday", "tomorrow",
}
TOK_RE = re.compile(r"[^\W_]+", re.UNICODE)


# ---------------------------------------------------------------------------
# Stemmers
# ---------------------------------------------------------------------------

def stem_simple(token: str) -> str:
    """Matches tokenize.ts stemEnglish."""
    if len(token) > 5 and token.endswith("ies"):
        return f"{token[:-3]}y"
    if len(token) > 5 and token.endswith("ing"):
        return token[:-3]
    if len(token) > 4 and token.endswith("ed"):
        return token[:-2]
    if len(token) > 4 and token.endswith("s"):
        return token[:-1]
    return token


def _porter_step1a(w: str) -> str:
    if w.endswith("sses"):
        return w[:-2]
    if w.endswith("ies"):
        return w[:-2]
    if w.endswith("ss"):
        return w
    if w.endswith("s"):
        return w[:-1]
    return w


def _porter_m(stem: str) -> int:
    """Measure of a stem (Porter): VC count."""
    form = []
    for ch in stem:
        form.append("V" if ch in "aeiou" or (ch == "y" and form and form[-1] == "C") else "C")
    s = "".join(form)
    # collapse runs
    compact = []
    for ch in s:
        if not compact or compact[-1] != ch:
            compact.append(ch)
    text = "".join(compact)
    # count VC pairs
    m = 0
    i = 0
    if text.startswith("C"):
        i = 1
    while i + 1 < len(text):
        if text[i] == "V" and text[i + 1] == "C":
            m += 1
            i += 2
        else:
            i += 1
    return m


def _porter_has_vowel(stem: str) -> bool:
    for i, ch in enumerate(stem):
        if ch in "aeiou":
            return True
        if ch == "y" and i > 0:
            return True
    return False


def _porter_cvc(stem: str) -> bool:
    if len(stem) < 3:
        return False
    a, b, c = stem[-3], stem[-2], stem[-1]
    if c in "aeiouwxy":
        return False
    if b not in "aeiou" and not (b == "y" and len(stem) > 3):
        return False
    # second-to-last is vowel; last is consonant not wxy; first of triple is consonant
    if a in "aeiou":
        return False
    return True


def stem_porter(token: str) -> str:
    """Porter stemmer (English), compact implementation."""
    w = token
    if len(w) <= 2:
        return w
    w = _porter_step1a(w)
    # step 1b
    if w.endswith("eed"):
        stem = w[:-3]
        if _porter_m(stem) > 0:
            w = stem + "ee"
    elif w.endswith("ed"):
        stem = w[:-2]
        if _porter_has_vowel(stem):
            w = stem
            if w.endswith(("at", "bl", "iz")):
                w += "e"
            elif len(w) >= 2 and w[-1] == w[-2] and w[-1] not in "lsz":
                w = w[:-1]
            elif _porter_m(w) == 1 and _porter_cvc(w):
                w += "e"
    elif w.endswith("ing"):
        stem = w[:-3]
        if _porter_has_vowel(stem):
            w = stem
            if w.endswith(("at", "bl", "iz")):
                w += "e"
            elif len(w) >= 2 and w[-1] == w[-2] and w[-1] not in "lsz":
                w = w[:-1]
            elif _porter_m(w) == 1 and _porter_cvc(w):
                w += "e"
    # step 1c
    if w.endswith("y") and _porter_has_vowel(w[:-1]):
        w = w[:-1] + "i"
    # step 2
    step2 = [
        ("ational", "ate"), ("tional", "tion"), ("enci", "ence"), ("anci", "ance"),
        ("izer", "ize"), ("abli", "able"), ("alli", "al"), ("entli", "ent"),
        ("eli", "e"), ("ousli", "ous"), ("ization", "ize"), ("ation", "ate"),
        ("ator", "ate"), ("alism", "al"), ("iveness", "ive"), ("fulness", "ful"),
        ("ousness", "ous"), ("aliti", "al"), ("iviti", "ive"), ("biliti", "ble"),
    ]
    for suf, rep in step2:
        if w.endswith(suf):
            stem = w[: -len(suf)]
            if _porter_m(stem) > 0:
                w = stem + rep
            break
    # step 3
    step3 = [
        ("icate", "ic"), ("ative", ""), ("alize", "al"), ("iciti", "ic"),
        ("ical", "ic"), ("ful", ""), ("ness", ""),
    ]
    for suf, rep in step3:
        if w.endswith(suf):
            stem = w[: -len(suf)]
            if _porter_m(stem) > 0:
                w = stem + rep
            break
    # step 4
    step4 = [
        "al", "ance", "ence", "er", "ic", "able", "ible", "ant", "ement", "ment",
        "ent", "ou", "ism", "ate", "iti", "ous", "ive", "ize",
    ]
    for suf in step4:
        if w.endswith(suf):
            stem = w[: -len(suf)]
            if _porter_m(stem) > 1:
                w = stem
            break
    else:
        if w.endswith("ion") and len(w) > 3 and w[-4] in "st":
            stem = w[:-3]
            if _porter_m(stem) > 1:
                w = stem
    # step 5a
    if w.endswith("e"):
        stem = w[:-1]
        m = _porter_m(stem)
        if m > 1 or (m == 1 and not _porter_cvc(stem)):
            w = stem
    # step 5b
    if _porter_m(w) > 1 and len(w) >= 2 and w[-1] == w[-2] == "l":
        w = w[:-1]
    return w


# ---------------------------------------------------------------------------
# Tokenize / BM25
# ---------------------------------------------------------------------------

def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).lower().replace("_", " ")
    text = text.replace("\u2018", "'").replace("\u2019", "'")
    text = text.replace("\u201c", '"').replace("\u201d", '"')
    text = text.replace("\u2013", "-").replace("\u2014", "-")
    return text


def tokenize(text: str, stemmer: str = "simple") -> list[str]:
    stem_fn = stem_porter if stemmer == "porter" else stem_simple
    out: list[str] = []
    for match in TOK_RE.findall(normalize(text)):
        token = stem_fn(match)
        if len(token) > 1 and token not in STOP:
            out.append(token)
    return out


def temporal_terms(tokens: Iterable[str]) -> set[str]:
    return {t for t in tokens if t in TEMP or any(ch.isdigit() for ch in t)}


@dataclass
class WindowDoc:
    session_id: str
    start_turn: int
    end_turn: int
    tf: Counter
    length: int
    temporal: set[str]


@dataclass
class RankConfig:
    name: str = "baseline"
    stemmer: str = "simple"  # simple | porter
    turn_mode: str = "all"  # all | useronly | userx3
    session_agg: str = "max"  # max | top3 | sum
    k1: float = 1.2
    b: float = 0.75
    temporal_boost: float = 0.15
    window_turns: int = 2
    window_stride: int = 1
    expansion: str = "none"  # none | facts-session | facts-anchored | keyphrases | facts-keyphrases
    top_k_windows: int = 96


def build_windows(
    sessions: list[tuple[str, str, list[dict]]],
    cfg: RankConfig,
    annotations: dict[str, dict] | None = None,
) -> list[WindowDoc]:
    docs: list[WindowDoc] = []
    for session_id, date, turns in sessions:
        n = len(turns)
        if n == 0:
            continue
        if n <= cfg.window_turns:
            ranges = [(0, n - 1)]
        else:
            ranges = []
            for start in range(0, n, cfg.window_stride):
                end = min(start + cfg.window_turns - 1, n - 1)
                ranges.append((start, end))
                if end == n - 1:
                    break

        ann = (annotations or {}).get(session_id) or {}
        facts = ann.get("facts") or []
        keyphrases = ann.get("keyphrases") or []

        for start, end in ranges:
            lines = [f"[session_date] {date}"]
            for i in range(start, end + 1):
                turn = turns[i]
                role = turn.get("role", "user")
                content = turn.get("content") or ""
                if cfg.turn_mode == "useronly" and role != "user":
                    continue
                if cfg.turn_mode == "userx3" and role == "user":
                    lines.append(f"[{role}] {content}")
                    lines.append(f"[{role}] {content}")
                    lines.append(f"[{role}] {content}")
                else:
                    lines.append(f"[{role}] {content}")

            # Expansion append
            extra: list[str] = []
            if cfg.expansion in ("facts-session", "facts-keyphrases"):
                for fact in facts:
                    text = fact.get("text") if isinstance(fact, dict) else str(fact)
                    if text:
                        extra.append(text)
            if cfg.expansion == "facts-anchored":
                for fact in facts:
                    if not isinstance(fact, dict):
                        continue
                    src = fact.get("turn_index")
                    text = fact.get("text") or ""
                    if text and src is not None and start <= int(src) <= end:
                        extra.append(text)
            if cfg.expansion in ("keyphrases", "facts-keyphrases"):
                if keyphrases:
                    extra.append(" ".join(str(k) for k in keyphrases))

            if extra:
                lines.append("[expansion] " + " | ".join(extra))

            text = "\n".join(lines)
            tokens = tokenize(text, cfg.stemmer)
            if cfg.turn_mode == "useronly" and len(tokens) <= len(tokenize(f"[session_date] {date}", cfg.stemmer)):
                # window with no user content — skip
                continue
            docs.append(
                WindowDoc(
                    session_id=session_id,
                    start_turn=start,
                    end_turn=end,
                    tf=Counter(tokens),
                    length=len(tokens),
                    temporal=temporal_terms(tokens),
                )
            )
    return docs


def search_windows(docs: list[WindowDoc], question: str, cfg: RankConfig) -> list[tuple[float, str, WindowDoc]]:
    n = len(docs)
    if n == 0:
        return []
    df: Counter = Counter()
    for d in docs:
        df.update(d.tf.keys())
    avg = sum(d.length for d in docs) / n
    q_tokens = list(dict.fromkeys(tokenize(question, cfg.stemmer)))
    q_temp = temporal_terms(tokenize(question, cfg.stemmer))
    scored: list[tuple[float, int, str, WindowDoc]] = []
    for d in docs:
        score = 0.0
        matched = 0
        for term in q_tokens:
            freq = d.tf.get(term, 0)
            if freq == 0:
                continue
            matched += 1
            idf = math.log(1 + (n - df[term] + 0.5) / (df[term] + 0.5))
            length_ratio = 0.0 if avg == 0 else d.length / avg
            denom = freq + cfg.k1 * (1 - cfg.b + cfg.b * length_ratio)
            score += idf * ((freq * (cfg.k1 + 1)) / denom)
        if q_temp:
            score += cfg.temporal_boost * len(q_temp & d.temporal)
        if score > 0:
            scored.append((score, matched, d.session_id, d))
    scored.sort(key=lambda r: (-r[0], -r[1], r[2]))
    return [(s, sid, d) for s, _m, sid, d in scored[: cfg.top_k_windows]]


def session_ranks(window_hits: list[tuple[float, str, WindowDoc]], cfg: RankConfig) -> dict[str, int]:
    by_session: dict[str, list[float]] = {}
    for score, sid, _d in window_hits:
        by_session.setdefault(sid, []).append(score)
    session_scores: list[tuple[float, str]] = []
    for sid, scores in by_session.items():
        scores.sort(reverse=True)
        if cfg.session_agg == "sum":
            agg = sum(scores)
        elif cfg.session_agg == "top3":
            agg = sum(scores[:3])
        else:
            agg = scores[0]
        session_scores.append((agg, sid))
    session_scores.sort(key=lambda r: (-r[0], r[1]))
    return {sid: i + 1 for i, (_s, sid) in enumerate(session_scores)}


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

def ndcg_at_k(golds: set[str], ranking: list[str], k: int) -> float:
    dcg = 0.0
    for i, sid in enumerate(ranking[:k]):
        if sid in golds:
            dcg += 1.0 / math.log2(i + 2)
    ideal = sum(1.0 / math.log2(i + 2) for i in range(min(k, len(golds))))
    return 0.0 if ideal == 0 else dcg / ideal


@dataclass
class CaseResult:
    question_id: str
    question_type: str
    gold_count: int
    found: int
    worst_rank: int | None
    gold_ranks: list[int]
    recall5: float
    ndcg5: float


@dataclass
class AggregateReport:
    name: str
    n: int
    cov3: float
    cov5: float
    cov10: float
    median_rank: float | None
    mean_rank: float | None
    recall5: float
    ndcg5: float
    miss_count: int
    cases: list[CaseResult] = field(default_factory=list)


def evaluate_case(
    case: dict,
    gold_ids: list[str],
    cfg: RankConfig,
    annotations: dict[str, dict] | None,
) -> CaseResult:
    sessions = list(
        zip(case["haystack_session_ids"], case["haystack_dates"], case["haystack_sessions"])
    )
    docs = build_windows(sessions, cfg, annotations)
    hits = search_windows(docs, case["question"], cfg)
    ranks = session_ranks(hits, cfg)
    ranking = [sid for sid, _ in sorted(ranks.items(), key=lambda kv: kv[1])]
    gold_set = set(gold_ids)
    gold_ranks = [ranks[g] for g in gold_ids if g in ranks]
    found = len(gold_ranks)
    worst = max(gold_ranks) if found == len(gold_ids) else None
    top5 = set(ranking[:5])
    recall5 = len(gold_set & top5) / max(len(gold_set), 1)
    return CaseResult(
        question_id=case["question_id"],
        question_type=case.get("question_type", ""),
        gold_count=len(gold_ids),
        found=found,
        worst_rank=worst,
        gold_ranks=gold_ranks,
        recall5=recall5,
        ndcg5=ndcg_at_k(gold_set, ranking, 5),
    )


def aggregate(name: str, results: list[CaseResult]) -> AggregateReport:
    n = len(results)
    ranks_all = [r for c in results for r in c.gold_ranks]
    complete = [c for c in results if c.worst_rank is not None]
    miss = n - len(complete)

    def cov(threshold: int) -> float:
        return sum(1 for c in complete if c.worst_rank is not None and c.worst_rank <= threshold) / max(n, 1)

    return AggregateReport(
        name=name,
        n=n,
        cov3=cov(3),
        cov5=cov(5),
        cov10=cov(10),
        median_rank=st.median(ranks_all) if ranks_all else None,
        mean_rank=st.mean(ranks_all) if ranks_all else None,
        recall5=st.mean([c.recall5 for c in results]) if results else 0.0,
        ndcg5=st.mean([c.ndcg5 for c in results]) if results else 0.0,
        miss_count=miss,
        cases=results,
    )


def format_report(rep: AggregateReport) -> str:
    med = f"{rep.median_rank:.1f}" if rep.median_rank is not None else "n/a"
    mean = f"{rep.mean_rank:.2f}" if rep.mean_rank is not None else "n/a"
    return (
        f"{rep.name:42s}  n={rep.n:3d}  "
        f"top3={100*rep.cov3:5.1f}%  top5={100*rep.cov5:5.1f}%  top10={100*rep.cov10:5.1f}%  "
        f"medRank={med:>5s}  meanRank={mean:>5s}  "
        f"R@5={100*rep.recall5:5.1f}%  NDCG@5={rep.ndcg5:.3f}  miss={rep.miss_count}"
    )


# ---------------------------------------------------------------------------
# Data loading / slices
# ---------------------------------------------------------------------------

def load_json(path: Path) -> Any:
    return json.loads(path.read_text())


def artifact_session_order(run_dir: Path, qid: str) -> dict[str, int] | None:
    path = run_dir / "agent-artifacts/cases" / qid / "retrieval.json"
    if not path.exists():
        return None
    best: dict[str, int] = {}
    for span in load_json(path).get("spans") or []:
        sid = span["session_id"]
        best[sid] = min(best.get(sid, 9999), span.get("best_rank", 9999))
    return {sid: i + 1 for i, (sid, _) in enumerate(sorted(best.items(), key=lambda kv: kv[1]))}


def hard_question_ids(run_dir: Path, dataset: dict[str, dict], oracle: dict[str, dict], qids: list[str]) -> list[str]:
    hard: list[tuple[str, int]] = []
    good: list[str] = []
    for q in qids:
        if q.endswith("_abs"):
            continue
        order = artifact_session_order(run_dir, q)
        if not order or q not in oracle:
            continue
        gold = oracle[q]["answer_session_ids"]
        ranks = [order.get(g, 999) for g in gold]
        if len(ranks) < len(gold):
            hard.append((q, 999))
            continue
        worst = max(ranks)
        if worst > 5:
            hard.append((q, worst))
        else:
            good.append(q)
    hard.sort(key=lambda x: -x[1])
    return [q for q, _ in hard], good


def resolve_slice(
    name: str,
    run_dir: Path,
    dataset: dict[str, dict],
    oracle: dict[str, dict],
    all_qids: list[str],
) -> list[str]:
    answerable = [q for q in all_qids if not q.endswith("_abs")]
    hard, good = hard_question_ids(run_dir, dataset, oracle, answerable)
    if name == "answerable":
        return answerable
    if name == "hard":
        return hard
    if name == "hard12":
        return hard[:12]
    if name == "hard50":
        # 33 hard + 17 good
        return hard + good[:17]
    if name == "all":
        return list(all_qids)
    raise SystemExit(f"unknown slice: {name}")


def load_annotations(path: Path | None) -> dict[str, dict]:
    if path is None or not path.exists():
        return {}
    if path.is_file():
        data = load_json(path)
        if isinstance(data, dict) and "sessions" in data:
            return data["sessions"]
        return data
    # Prefer combined index written by sessionAnnotate.ts
    index = path / "_index.json"
    if index.exists():
        data = load_json(index)
        if isinstance(data, dict) and "sessions" in data:
            return data["sessions"]
    out: dict[str, dict] = {}
    for file in path.glob("*.json"):
        if file.name.startswith("_"):
            continue
        payload = load_json(file)
        # Files store session_id + annotation fields
        sid = payload.get("session_id") or file.stem
        out[sid] = {
            "facts": payload.get("facts") or [],
            "keyphrases": payload.get("keyphrases") or [],
            "events": payload.get("events") or [],
        }
    return out


def parse_config(args: argparse.Namespace) -> RankConfig:
    return RankConfig(
        name=args.variant,
        stemmer=args.stemmer,
        turn_mode=args.turn_mode,
        session_agg=args.session_agg,
        k1=args.k1,
        b=args.b,
        temporal_boost=args.temporal_boost,
        expansion=args.expansion,
    )


VARIANT_PRESETS: dict[str, dict[str, Any]] = {
    "baseline": {},
    "useronly": {"turn_mode": "useronly"},
    "userx3": {"turn_mode": "userx3"},
    "top3agg": {"session_agg": "top3"},
    "useronly-top3": {"turn_mode": "useronly", "session_agg": "top3"},
    "porter": {"stemmer": "porter"},
    "useronly-porter": {"turn_mode": "useronly", "stemmer": "porter"},
    # Phase-1 landed winner
    "phase1": {"turn_mode": "useronly", "k1": 1.5, "b": 0.9},
}


def apply_preset(name: str, base: RankConfig) -> RankConfig:
    preset = VARIANT_PRESETS.get(name)
    if preset is None and name not in ("custom",):
        # allow name to be a free label with flags already set
        cfg = RankConfig(**{**base.__dict__})
        cfg.name = name
        return cfg
    cfg = RankConfig(**{**base.__dict__, **(preset or {})})
    cfg.name = name
    return cfg


def run_eval(
    qids: list[str],
    dataset: dict[str, dict],
    oracle: dict[str, dict],
    cfg: RankConfig,
    annotations: dict[str, dict],
) -> AggregateReport:
    results: list[CaseResult] = []
    for q in qids:
        case = dataset.get(q)
        gold_case = oracle.get(q)
        if not case or not gold_case:
            continue
        if q.endswith("_abs"):
            continue
        results.append(evaluate_case(case, gold_case["answer_session_ids"], cfg, annotations))
    return aggregate(cfg.name, results)


def phase1_sweep(
    qids: list[str],
    dataset: dict[str, dict],
    oracle: dict[str, dict],
) -> list[AggregateReport]:
    reports: list[AggregateReport] = []
    # Named lexical variants
    for name in (
        "baseline",
        "useronly",
        "userx3",
        "top3agg",
        "useronly-top3",
        "porter",
        "useronly-porter",
    ):
        cfg = apply_preset(name, RankConfig())
        reports.append(run_eval(qids, dataset, oracle, cfg, {}))

    # k1/b grid on top of useronly (best so far from prior probe)
    for k1 in (0.9, 1.2, 1.5, 1.8):
        for b in (0.5, 0.75, 0.9):
            cfg = RankConfig(
                name=f"useronly-k1={k1}-b={b}",
                turn_mode="useronly",
                k1=k1,
                b=b,
            )
            reports.append(run_eval(qids, dataset, oracle, cfg, {}))
    return reports


def validate_against_artifacts(run_dir: Path, dataset: dict[str, dict], oracle: dict[str, dict], qids: list[str], n: int = 12) -> None:
    cfg = RankConfig(name="baseline")
    checked = 0
    matched = 0
    for q in qids:
        if checked >= n:
            break
        case = dataset.get(q)
        art = artifact_session_order(run_dir, q)
        if not case or not art or q not in oracle:
            continue
        result = evaluate_case(case, oracle[q]["answer_session_ids"], cfg, None)
        # Compare gold ranks only (order of all sessions may differ on ties beyond gold)
        mine = result.gold_ranks
        theirs = [art.get(g) for g in oracle[q]["answer_session_ids"]]
        # Filter None for missing
        if None in theirs:
            continue
        checked += 1
        ok = mine == theirs
        matched += int(ok)
        status = "OK" if ok else "DIFF"
        print(f"  validate {q:16s} mine={mine} artifact={theirs} {status}")
    print(f"  match {matched}/{checked}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Offline BM25 ranking gate")
    parser.add_argument("--run", type=Path, default=DEFAULT_RUN)
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--oracle", type=Path, default=DEFAULT_ORACLE)
    parser.add_argument("--slice", default="answerable", help="answerable|hard|hard12|hard50|all")
    parser.add_argument("--variant", default="baseline")
    parser.add_argument("--stemmer", default="simple", choices=["simple", "porter"])
    parser.add_argument("--turn-mode", default="all", choices=["all", "useronly", "userx3"])
    parser.add_argument("--session-agg", default="max", choices=["max", "top3", "sum"])
    parser.add_argument("--k1", type=float, default=1.2)
    parser.add_argument("--b", type=float, default=0.75)
    parser.add_argument("--temporal-boost", type=float, default=0.15)
    parser.add_argument("--expansion", default="none",
                        choices=["none", "facts-session", "facts-anchored", "keyphrases", "facts-keyphrases"])
    parser.add_argument("--annotations", type=Path, default=None)
    parser.add_argument("--sweep-phase1", action="store_true")
    parser.add_argument("--validate", action="store_true")
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--date-filter", action="store_true",
                        help="Phase 3: apply question date-range filter with fallback")
    parser.add_argument("--date-pad-days", type=int, default=7)
    parser.add_argument("--date-ranges", type=Path, default=None,
                        help="Optional LLM-inferred question date ranges (_index.json or dir)")
    args = parser.parse_args()

    run_dir = args.run if args.run.is_absolute() else PROJECT_ROOT / args.run
    dataset_list = load_json(args.dataset if args.dataset.is_absolute() else PROJECT_ROOT / args.dataset)
    oracle_list = load_json(args.oracle if args.oracle.is_absolute() else PROJECT_ROOT / args.oracle)
    dataset = {c["question_id"]: c for c in dataset_list}
    oracle = {c["question_id"]: c for c in oracle_list}
    manifest = load_json(run_dir / "manifest.json")
    all_qids = manifest["selected_question_ids"]
    qids = resolve_slice(args.slice, run_dir, dataset, oracle, all_qids)

    if args.validate:
        print("=== validate scorer vs artifacts ===")
        validate_against_artifacts(run_dir, dataset, oracle, [q for q in all_qids if not q.endswith("_abs")])
        return

    annotations = load_annotations(
        args.annotations if args.annotations is None or args.annotations.is_absolute()
        else PROJECT_ROOT / args.annotations
    )

    if args.sweep_phase1:
        print(f"=== Phase 1 sweep  slice={args.slice}  n={len(qids)} ===")
        reports = phase1_sweep(qids, dataset, oracle)
        reports.sort(key=lambda r: (-r.cov5, -r.cov3, -r.recall5))
        for rep in reports:
            print(format_report(rep))
        best = reports[0]
        print(f"\nBEST: {best.name}  top5={100*best.cov5:.1f}%")
        if args.out:
            payload = {
                "slice": args.slice,
                "best": best.name,
                "reports": [
                    {
                        "name": r.name,
                        "n": r.n,
                        "cov3": r.cov3,
                        "cov5": r.cov5,
                        "cov10": r.cov10,
                        "median_rank": r.median_rank,
                        "mean_rank": r.mean_rank,
                        "recall5": r.recall5,
                        "ndcg5": r.ndcg5,
                        "miss_count": r.miss_count,
                    }
                    for r in reports
                ],
            }
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(json.dumps(payload, indent=2))
            print(f"wrote {args.out}")
        return

    base = parse_config(args)
    cfg = apply_preset(args.variant, base) if args.variant in VARIANT_PRESETS else base
    if args.variant not in VARIANT_PRESETS:
        cfg.name = args.variant
    # Ensure CLI overrides apply on top of preset
    if args.expansion != "none":
        cfg.expansion = args.expansion
    if args.annotations:
        # keep expansion as requested
        pass

    if args.date_filter:
        cfg.name = f"{cfg.name}+datefilter"
        date_ranges = load_date_ranges(
            args.date_ranges if args.date_ranges is None or args.date_ranges.is_absolute()
            else PROJECT_ROOT / args.date_ranges
        )
        rep = run_eval_with_date_filter(
            qids, dataset, oracle, cfg, annotations, args.date_pad_days, date_ranges,
        )
    else:
        rep = run_eval(qids, dataset, oracle, cfg, annotations)
    print(f"=== rank gate  slice={args.slice}  variant={cfg.name}  expansion={cfg.expansion} ===")
    print(format_report(rep))
    if args.out:
        payload = {
            "slice": args.slice,
            "config": cfg.__dict__,
            "aggregate": {
                "n": rep.n,
                "cov3": rep.cov3,
                "cov5": rep.cov5,
                "cov10": rep.cov10,
                "median_rank": rep.median_rank,
                "mean_rank": rep.mean_rank,
                "recall5": rep.recall5,
                "ndcg5": rep.ndcg5,
                "miss_count": rep.miss_count,
            },
            "cases": [
                {
                    "question_id": c.question_id,
                    "question_type": c.question_type,
                    "worst_rank": c.worst_rank,
                    "gold_ranks": c.gold_ranks,
                    "recall5": c.recall5,
                    "ndcg5": c.ndcg5,
                }
                for c in rep.cases
            ],
        }
        out = args.out if args.out.is_absolute() else PROJECT_ROOT / args.out
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(payload, indent=2))
        print(f"wrote {out}")


def parse_session_date(raw: str):
    from datetime import datetime
    try:
        return datetime.strptime(raw.split(" (")[0], "%Y/%m/%d")
    except Exception:
        return None


def load_date_ranges(path: Path | None) -> dict[str, dict]:
    if path is None or not path.exists():
        return {}
    if path.is_file():
        data = load_json(path)
        return data.get("ranges", data)
    index = path / "_index.json"
    if index.exists():
        return load_json(index).get("ranges", {})
    out: dict[str, dict] = {}
    for file in path.glob("*.json"):
        if file.name.startswith("_"):
            continue
        payload = load_json(file)
        qid = payload.get("question_id") or file.stem
        out[qid] = payload
    return out


def infer_question_date_range(question: str, question_date: str, pad_days: int):
    """Heuristic date-range inference from question text + question_date (no LLM)."""
    from datetime import datetime, timedelta
    import calendar

    q_date = parse_session_date(question_date)
    if q_date is None:
        return None
    q = question.lower()
    months = {m.lower(): i for i, m in enumerate(calendar.month_name) if m}
    months.update({m.lower(): i for i, m in enumerate(calendar.month_abbr) if m})

    # Explicit month (+ optional year)
    found_months = []
    for name, idx in months.items():
        if re.search(rf"\b{re.escape(name)}\b", q):
            found_months.append(idx)
    year_match = re.search(r"\b(20\d{2})\b", q)
    year = int(year_match.group(1)) if year_match else q_date.year

    if found_months:
        lo_m = min(found_months)
        hi_m = max(found_months)
        lo = datetime(year, lo_m, 1)
        last = calendar.monthrange(year, hi_m)[1]
        hi = datetime(year, hi_m, last)
        return lo - timedelta(days=pad_days), hi + timedelta(days=pad_days)

    # Relative phrases
    if "last week" in q or "past week" in q:
        return q_date - timedelta(days=14 + pad_days), q_date + timedelta(days=pad_days)
    if "last month" in q or "past month" in q:
        return q_date - timedelta(days=45 + pad_days), q_date + timedelta(days=pad_days)
    if "last year" in q or "past year" in q:
        return q_date - timedelta(days=400 + pad_days), q_date + timedelta(days=pad_days)
    if "yesterday" in q:
        return q_date - timedelta(days=2 + pad_days), q_date + timedelta(days=pad_days)
    if "today" in q:
        return q_date - timedelta(days=pad_days), q_date + timedelta(days=pad_days)

    # No temporal cue — do not filter
    return None


def resolve_date_range(
    qid: str,
    question: str,
    question_date: str,
    pad_days: int,
    llm_ranges: dict[str, dict],
):
    from datetime import datetime, timedelta

    llm = llm_ranges.get(qid)
    if llm and llm.get("has_temporal_constraint") and llm.get("start_date") and llm.get("end_date"):
        try:
            lo = datetime.strptime(str(llm["start_date"])[:10], "%Y-%m-%d")
            hi = datetime.strptime(str(llm["end_date"])[:10], "%Y-%m-%d")
            return lo - timedelta(days=pad_days), hi + timedelta(days=pad_days)
        except Exception:
            pass
    return infer_question_date_range(question, question_date, pad_days)


def run_eval_with_date_filter(
    qids: list[str],
    dataset: dict[str, dict],
    oracle: dict[str, dict],
    cfg: RankConfig,
    annotations: dict[str, dict],
    pad_days: int,
    llm_ranges: dict[str, dict] | None = None,
) -> AggregateReport:
    results: list[CaseResult] = []
    llm_ranges = llm_ranges or {}
    for q in qids:
        case = dataset.get(q)
        gold_case = oracle.get(q)
        if not case or not gold_case or q.endswith("_abs"):
            continue
        sessions = list(
            zip(case["haystack_session_ids"], case["haystack_dates"], case["haystack_sessions"])
        )
        docs = build_windows(sessions, cfg, annotations)
        hits = search_windows(docs, case["question"], cfg)
        ranks_full = session_ranks(hits, cfg)
        ranking_full = [sid for sid, _ in sorted(ranks_full.items(), key=lambda kv: kv[1])]

        date_range = resolve_date_range(
            q, case["question"], case["question_date"], pad_days, llm_ranges,
        )
        if date_range is None:
            ranks = ranks_full
            ranking = ranking_full
        else:
            lo, hi = date_range
            date_by_id = {
                sid: parse_session_date(date)
                for sid, date, _ in sessions
            }
            filtered = [
                sid for sid in ranking_full
                if date_by_id.get(sid) is not None and lo <= date_by_id[sid] <= hi  # type: ignore[operator]
            ]
            # Fallback: if filter empties or shrinks too hard (<3), keep full
            if len(filtered) < 3:
                ranks = ranks_full
                ranking = ranking_full
            else:
                ranks = {sid: i + 1 for i, sid in enumerate(filtered)}
                ranking = filtered

        gold_ids = gold_case["answer_session_ids"]
        gold_set = set(gold_ids)
        gold_ranks = [ranks[g] for g in gold_ids if g in ranks]
        found = len(gold_ranks)
        worst = max(gold_ranks) if found == len(gold_ids) else None
        top5 = set(ranking[:5])
        results.append(
            CaseResult(
                question_id=q,
                question_type=case.get("question_type", ""),
                gold_count=len(gold_ids),
                found=found,
                worst_rank=worst,
                gold_ranks=gold_ranks,
                recall5=len(gold_set & top5) / max(len(gold_set), 1),
                ndcg5=ndcg_at_k(gold_set, ranking, 5),
            )
        )
    return aggregate(cfg.name, results)


if __name__ == "__main__":
    main()
