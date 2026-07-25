from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from collections.abc import Iterable, Sequence

from agents.current.contracts.models import (
    BatchRecord,
    GraphState,
    QueryPlan,
    RetrievalCandidate,
)
from longmemeval.api import TimestampedSession

_TOKEN = re.compile(r"[a-z0-9]+")


def _tokens(text: str) -> list[str]:
    return _TOKEN.findall(text.casefold())


def _session_text(session: TimestampedSession) -> str:
    return " ".join(turn.content for turn in session.turns)


def build_documents(
    graph: GraphState,
    batches: Sequence[BatchRecord],
    sessions: Sequence[TimestampedSession],
) -> list[RetrievalCandidate]:
    documents: list[RetrievalCandidate] = []
    for entity in graph.entities.values():
        documents.append(
            RetrievalCandidate(
                id=entity.id,
                kind="entity",
                text=" ".join(
                    [entity.kind, entity.canonical_name, *entity.aliases]
                    + [f"{key} {value}" for key, value in entity.properties.items()]
                ),
                session_ids=list(dict.fromkeys(item.session_id for item in entity.provenance)),
            )
        )
    for claim in graph.claims.values():
        subject = graph.entities.get(claim.subject_id)
        documents.append(
            RetrievalCandidate(
                id=claim.id,
                kind="claim",
                text=f"{subject.canonical_name if subject else claim.subject_id} "
                f"{claim.predicate} {claim.value} {claim.status}",
                session_ids=list(dict.fromkeys(item.session_id for item in claim.provenance)),
            )
        )
    for relation in graph.relations.values():
        source = graph.entities.get(relation.source_id)
        target = graph.entities.get(relation.target_id)
        documents.append(
            RetrievalCandidate(
                id=relation.id,
                kind="relation",
                text=f"{source.canonical_name if source else relation.source_id} "
                f"{relation.predicate} {target.canonical_name if target else relation.target_id} "
                f"{relation.status}",
                session_ids=list(dict.fromkeys(item.session_id for item in relation.provenance)),
            )
        )
    for event in graph.events.values():
        names = [
            graph.entities[item].canonical_name if item in graph.entities else item
            for item in event.participant_ids
        ]
        documents.append(
            RetrievalCandidate(
                id=event.id,
                kind="event",
                text=f"{event.event_type} {' '.join(names)} {event.occurred_at or ''} "
                f"{event.properties}",
                session_ids=list(dict.fromkeys(item.session_id for item in event.provenance)),
            )
        )
    for batch in batches:
        documents.append(
            RetrievalCandidate(
                id=batch.batch_id,
                kind="batch",
                text=batch.summary,
                session_ids=batch.session_ids,
            )
        )
    for session in sessions:
        documents.append(
            RetrievalCandidate(
                id=session.session_id,
                kind="session",
                text=f"{session.date} {_session_text(session)}",
                session_ids=[session.session_id],
            )
        )
    return documents


def _bm25(query: Sequence[str], documents: Sequence[RetrievalCandidate]) -> list[str]:
    if not query or not documents:
        return []
    tokenized = [_tokens(document.text) for document in documents]
    average_length = sum(len(item) for item in tokenized) / max(len(tokenized), 1)
    document_frequency = Counter(
        token for tokens in tokenized for token in set(tokens) if token in query
    )
    scores: list[tuple[float, str]] = []
    for document, tokens in zip(documents, tokenized, strict=True):
        frequencies = Counter(tokens)
        score = 0.0
        for token in query:
            count = frequencies[token]
            if not count:
                continue
            inverse = math.log(
                1
                + (len(documents) - document_frequency[token] + 0.5)
                / (document_frequency[token] + 0.5)
            )
            denominator = count + 1.2 * (0.25 + 0.75 * len(tokens) / max(average_length, 1))
            score += inverse * count * 2.2 / denominator
        if score > 0:
            scores.append((score, document.id))
    return [item[1] for item in sorted(scores, reverse=True)]


def _matching_ids(documents: Sequence[RetrievalCandidate], terms: Iterable[str]) -> list[str]:
    normalized = [term.casefold() for term in terms if term.strip()]
    return [
        document.id
        for document in documents
        if any(term in document.text.casefold() for term in normalized)
    ]


def _two_hop(graph: GraphState, seeds: set[str]) -> list[str]:
    reached = set(seeds)
    relation_ids: list[str] = []
    for _ in range(2):
        next_ids: set[str] = set()
        for relation in graph.relations.values():
            if relation.source_id in reached or relation.target_id in reached:
                relation_ids.append(relation.id)
                next_ids.update((relation.source_id, relation.target_id))
        reached.update(next_ids)
    return list(dict.fromkeys([*seeds, *relation_ids, *reached]))


def _rrf(channels: dict[str, list[str]], k: int) -> dict[str, tuple[float, list[str]]]:
    scores: defaultdict[str, float] = defaultdict(float)
    sources: defaultdict[str, list[str]] = defaultdict(list)
    for channel, ranked in channels.items():
        for rank, candidate_id in enumerate(ranked, start=1):
            scores[candidate_id] += 1.0 / (k + rank)
            sources[candidate_id].append(channel)
    return {item: (score, sources[item]) for item, score in scores.items()}


def retrieve_candidates(
    graph: GraphState,
    batches: Sequence[BatchRecord],
    sessions: Sequence[TimestampedSession],
    plan: QueryPlan,
    question: str,
    *,
    limit: int,
    rrf_k: int,
    latest_count: int,
) -> list[RetrievalCandidate]:
    documents = build_documents(graph, batches, sessions)
    by_id = {document.id: document for document in documents}
    entity_matches = _matching_ids(
        [item for item in documents if item.kind == "entity"], plan.entity_hints
    )
    predicate_matches = _matching_ids(documents, plan.predicates)
    batch_matches = _matching_ids(
        [item for item in documents if item.kind == "batch"],
        [*plan.lexical_terms, *plan.entity_hints],
    )
    temporal_matches = _matching_ids(documents, plan.temporal_constraints)
    latest = [session.session_id for session in sessions[-latest_count:]][::-1]
    channels = {
        "bm25": _bm25(_tokens(" ".join([question, *plan.lexical_terms])), documents),
        "entity": entity_matches,
        "predicate": predicate_matches,
        "graph": _two_hop(graph, set(entity_matches)) if plan.likely_hops else entity_matches,
        "temporal": temporal_matches,
        "batch_summary": batch_matches,
        "latest_session": latest,
    }
    fused = _rrf(channels, rrf_k)
    ordered = sorted(fused.items(), key=lambda item: (-item[1][0], item[0]))[:limit]
    results: list[RetrievalCandidate] = []
    for candidate_id, (score, sources) in ordered:
        candidate = by_id.get(candidate_id)
        if candidate is None:
            continue
        results.append(candidate.model_copy(update={"fused_score": score, "channels": sources}))
    return results
