from __future__ import annotations

from typing import cast

from agents.current.contracts.models import GraphState
from longmemeval.api import JsonObject, JsonValue


def context_tree(graph: GraphState) -> JsonObject:
    entities: JsonObject = {}
    for entity in sorted(
        graph.entities.values(), key=lambda item: (item.kind, item.canonical_name)
    ):
        claims: JsonObject = {}
        for claim in graph.claims.values():
            if claim.subject_id == entity.id:
                values = claims.setdefault(claim.predicate, [])
                if isinstance(values, list):
                    values.append(
                        {
                            "id": claim.id,
                            "value": claim.value,
                            "status": claim.status,
                            "valid_from": claim.temporal.valid_from,
                            "valid_to": claim.temporal.valid_to,
                        }
                    )
        relations: list[JsonValue] = []
        for relation in graph.relations.values():
            if relation.source_id == entity.id:
                target = graph.entities.get(relation.target_id)
                relations.append(
                    {
                        "id": relation.id,
                        "predicate": relation.predicate,
                        "target": target.canonical_name if target else relation.target_id,
                        "target_id": relation.target_id,
                        "status": relation.status,
                    }
                )
        kind_bucket = entities.setdefault(entity.kind, {})
        if isinstance(kind_bucket, dict):
            kind_bucket[entity.id] = {
                "canonical_name": entity.canonical_name,
                "aliases": cast(JsonValue, entity.aliases),
                "properties": entity.properties,
                "claims": claims,
                "relations": relations,
            }
    return {
        "entities": entities,
        "events": [event.model_dump(mode="json") for event in graph.events.values()],
    }
