from __future__ import annotations

import json
from collections.abc import Sequence
from typing import cast

from agents.current.contracts.models import BatchRecord, GraphState, RetrievalCandidate
from agents.current.memory.projection import context_tree
from longmemeval.api import JsonObject, JsonValue, TimestampedSession


def _session_payload(session: TimestampedSession) -> JsonObject:
    return {
        "session_id": session.session_id,
        "date": session.date,
        "turns": [turn.model_dump(mode="json") for turn in session.turns],
    }


def compile_context(
    graph: GraphState,
    batches: Sequence[BatchRecord],
    sessions: Sequence[TimestampedSession],
    selected: Sequence[RetrievalCandidate],
    *,
    latest_count: int,
    historical_limit: int,
    character_budget: int,
) -> JsonObject:
    selected_ids = {candidate.id for candidate in selected}
    selected_session_ids = list(
        dict.fromkeys(session_id for item in selected for session_id in item.session_ids)
    )[:historical_limit]
    latest_ids = {session.session_id for session in sessions[-latest_count:]}
    historical = [
        _session_payload(session)
        for session in sessions
        if session.session_id in selected_session_ids and session.session_id not in latest_ids
    ]
    package: JsonObject = {
        "master_context_overview": {
            "entity_count": len(graph.entities),
            "claim_count": len(graph.claims),
            "relation_count": len(graph.relations),
            "event_count": len(graph.events),
        },
        "query_graph_projection": context_tree(graph),
        "batch_index": cast(
            JsonValue,
            [
                {
                    "batch_id": batch.batch_id,
                    "session_ids": batch.session_ids,
                    "summary": batch.summary,
                }
                for batch in batches
            ],
        ),
        "relevant_batches": [
            batch.model_dump(mode="json") for batch in batches if batch.batch_id in selected_ids
        ],
        "retrieved_historical_sessions": cast(JsonValue, historical),
        "latest_sessions": [_session_payload(session) for session in sessions[-latest_count:]],
        "selected_candidates": [item.model_dump(mode="json") for item in selected],
        "contradictions": [
            claim.model_dump(mode="json")
            for claim in graph.claims.values()
            if claim.status == "contradicted"
        ],
    }
    encoded = json.dumps(package, ensure_ascii=False, sort_keys=True)
    if len(encoded) <= character_budget:
        return package
    package["query_graph_projection"] = {
        "entities": [
            entity.model_dump(mode="json")
            for entity in graph.entities.values()
            if entity.id in selected_ids
        ],
        "claims": [
            claim.model_dump(mode="json")
            for claim in graph.claims.values()
            if claim.id in selected_ids
        ],
        "relations": [
            relation.model_dump(mode="json")
            for relation in graph.relations.values()
            if relation.id in selected_ids
        ],
    }
    package["context_truncated"] = True
    return package
