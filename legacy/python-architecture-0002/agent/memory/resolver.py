from __future__ import annotations

import re
import uuid

from agents.current.contracts.models import Entity, GraphState, ProvenanceReference
from longmemeval.api import JsonObject

_SPACE = re.compile(r"\s+")
_PUNCTUATION = re.compile(r"[^a-z0-9 ]+")


def normalize_identity(value: str) -> str:
    lowered = _PUNCTUATION.sub(" ", value.casefold())
    return _SPACE.sub(" ", lowered).strip()


class EntityResolver:
    """Conservative exact alias resolution with stable case-local UUIDv5 IDs."""

    def __init__(self, question_id: str, graph: GraphState) -> None:
        self.namespace = uuid.uuid5(uuid.NAMESPACE_URL, f"longmemeval:{question_id}")
        self.graph = graph
        self._refs: dict[str, str] = {}

    def register_existing(self, ref: str, entity_id: str) -> None:
        if entity_id not in self.graph.entities:
            raise KeyError(f"unknown entity ID: {entity_id}")
        self._refs[ref] = entity_id

    def resolve(self, ref: str) -> str | None:
        if ref in self.graph.entities:
            return ref
        return self._refs.get(ref)

    def resolve_or_create(
        self,
        *,
        ref: str,
        kind: str,
        canonical_name: str,
        aliases: list[str],
        properties: JsonObject,
        provenance: ProvenanceReference,
    ) -> tuple[str, bool, str | None]:
        target_names = {
            normalize_identity(canonical_name),
            *(normalize_identity(a) for a in aliases),
        }
        exact: list[str] = []
        for entity in self.graph.entities.values():
            if entity.kind != kind:
                continue
            known = {
                normalize_identity(entity.canonical_name),
                *(normalize_identity(alias) for alias in entity.aliases),
            }
            if target_names & known:
                exact.append(entity.id)
        if len(exact) == 1:
            entity_id = exact[0]
            self._refs[ref] = entity_id
            return entity_id, False, None
        warning = None
        if len(exact) > 1:
            warning = f"ambiguous exact identity for {kind}:{canonical_name}; kept separate"
        identity = f"{kind}:{normalize_identity(canonical_name)}"
        entity_id = str(uuid.uuid5(self.namespace, identity))
        if entity_id in self.graph.entities:
            suffix = str(len(self.graph.entities))
            entity_id = str(uuid.uuid5(self.namespace, f"{identity}:{suffix}"))
        self.graph.entities[entity_id] = Entity(
            id=entity_id,
            kind=kind,
            canonical_name=canonical_name,
            aliases=list(dict.fromkeys(aliases)),
            properties=properties,
            provenance=[provenance],
        )
        self._refs[ref] = entity_id
        return entity_id, True, warning

    def deterministic_id(self, family: str, batch_id: str, operation_index: int) -> str:
        return str(uuid.uuid5(self.namespace, f"{family}:{batch_id}:{operation_index}"))
