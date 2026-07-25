from __future__ import annotations

import hashlib
import json
import re
from typing import cast

from agents.current.contracts.models import (
    AddAliasOperation,
    AssertClaimOperation,
    AssertRelationOperation,
    BatchRecord,
    Claim,
    ConsolidationOutput,
    CreateEntityOperation,
    DraftProperty,
    GraphDiff,
    GraphState,
    MemoryEvent,
    OperationDecision,
    RecordEventOperation,
    Relation,
    SetEntityPropertyOperation,
    SupersedeClaimOperation,
    SupersedeRelationOperation,
    TemporalWindow,
)
from agents.current.memory.resolver import EntityResolver
from longmemeval.api import JsonValue

_SNAKE_CASE = re.compile(r"^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$")


def graph_hash(graph: GraphState) -> str:
    payload = json.dumps(graph.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


def _pointer(*parts: str) -> str:
    escaped = [part.replace("~", "~0").replace("/", "~1") for part in parts]
    return "/" + "/".join(escaped)


def _properties(items: list[DraftProperty]) -> dict[str, JsonValue]:
    result: dict[str, JsonValue] = {}
    for item in items:
        if not _SNAKE_CASE.fullmatch(item.key):
            raise ValueError(f"property key must be snake_case: {item.key}")
        if item.key in result:
            raise ValueError(f"duplicate property key: {item.key}")
        result[item.key] = cast(JsonValue, item.value)
    return result


class TemporalGraphReducer:
    def __init__(self, question_id: str, graph: GraphState | None = None) -> None:
        self.graph = graph or GraphState()
        self.resolver = EntityResolver(question_id, self.graph)

    def apply(
        self,
        batch_id: str,
        session_ids: list[str],
        output: ConsolidationOutput,
    ) -> BatchRecord:
        decisions: list[OperationDecision] = []
        warnings: list[str] = []
        diffs: list[GraphDiff] = []
        session_set = set(session_ids)
        for index, operation in enumerate(output.operations):
            if operation.provenance.session_id not in session_set:
                decisions.append(
                    OperationDecision(
                        operation_index=index,
                        accepted=False,
                        reason="provenance session is outside the current batch",
                    )
                )
                continue
            try:
                ids, operation_diffs, warning = self._apply_one(batch_id, index, operation)
                decisions.append(
                    OperationDecision(
                        operation_index=index,
                        accepted=True,
                        canonical_ids=ids,
                    )
                )
                diffs.extend(operation_diffs)
                if warning:
                    warnings.append(warning)
            except (KeyError, ValueError) as exc:
                decisions.append(
                    OperationDecision(
                        operation_index=index,
                        accepted=False,
                        reason=str(exc),
                    )
                )
        return BatchRecord(
            batch_id=batch_id,
            session_ids=session_ids,
            summary=output.summary,
            decisions=decisions,
            warnings=warnings,
            diffs=diffs,
            graph_hash=graph_hash(self.graph),
        )

    def _apply_one(
        self,
        batch_id: str,
        index: int,
        operation: (
            CreateEntityOperation
            | AddAliasOperation
            | SetEntityPropertyOperation
            | AssertClaimOperation
            | SupersedeClaimOperation
            | AssertRelationOperation
            | SupersedeRelationOperation
            | RecordEventOperation
        ),
    ) -> tuple[list[str], list[GraphDiff], str | None]:
        if isinstance(operation, CreateEntityOperation):
            self._validate_snake(operation.kind, "entity kind")
            properties = _properties(operation.properties)
            entity_id, created, warning = self.resolver.resolve_or_create(
                ref=operation.ref,
                kind=operation.kind,
                canonical_name=operation.canonical_name,
                aliases=operation.aliases,
                properties=properties,
                provenance=operation.provenance,
            )
            diffs = (
                [
                    GraphDiff(
                        op="add",
                        path=_pointer("entities", entity_id),
                        new_value=self.graph.entities[entity_id].model_dump(mode="json"),
                    )
                ]
                if created
                else []
            )
            return [entity_id], diffs, warning
        if isinstance(operation, AddAliasOperation):
            entity_id = self._entity(operation.entity_ref)
            entity = self.graph.entities[entity_id]
            if operation.alias not in entity.aliases:
                old: JsonValue = list(entity.aliases)
                entity.aliases.append(operation.alias)
                entity.provenance.append(operation.provenance)
                return (
                    [entity_id],
                    [
                        GraphDiff(
                            op="replace",
                            path=_pointer("entities", entity_id, "aliases"),
                            old_value=old,
                            new_value=list(entity.aliases),
                        )
                    ],
                    None,
                )
            return [entity_id], [], None
        if isinstance(operation, SetEntityPropertyOperation):
            self._validate_snake(operation.key, "property key")
            entity_id = self._entity(operation.entity_ref)
            entity = self.graph.entities[entity_id]
            old = entity.properties.get(operation.key)
            value = cast(JsonValue, operation.value)
            entity.properties[operation.key] = value
            entity.provenance.append(operation.provenance)
            return (
                [entity_id],
                [
                    GraphDiff(
                        op="replace" if old is not None else "add",
                        path=_pointer("entities", entity_id, "properties", operation.key),
                        old_value=old,
                        new_value=value,
                    )
                ],
                None,
            )
        if isinstance(operation, AssertClaimOperation):
            self._validate_snake(operation.predicate, "claim predicate")
            subject_id = self._entity(operation.subject_ref)
            value = cast(JsonValue, operation.value)
            claim_id = self.resolver.deterministic_id("claim", batch_id, index)
            contradiction_diffs: list[GraphDiff] = []
            for claim in self.graph.claims.values():
                if (
                    claim.subject_id == subject_id
                    and claim.predicate == operation.predicate
                    and claim.status == "active"
                    and claim.value != value
                ):
                    old_valid_to = claim.temporal.valid_to
                    claim.status = "contradicted"
                    claim.temporal.valid_to = operation.valid_from
                    contradiction_diffs.extend(
                        [
                            GraphDiff(
                                op="replace",
                                path=_pointer("claims", claim.id, "status"),
                                old_value="active",
                                new_value="contradicted",
                            ),
                            GraphDiff(
                                op="replace" if old_valid_to is not None else "add",
                                path=_pointer("claims", claim.id, "temporal", "valid_to"),
                                old_value=old_valid_to,
                                new_value=operation.valid_from,
                            ),
                        ]
                    )
            self.graph.claims[claim_id] = Claim(
                id=claim_id,
                subject_id=subject_id,
                predicate=operation.predicate,
                value=value,
                temporal=TemporalWindow(
                    valid_from=operation.valid_from,
                    valid_to=operation.valid_to,
                    observed_at=operation.provenance.session_date,
                ),
                provenance=[operation.provenance],
            )
            return (
                [claim_id],
                [
                    *contradiction_diffs,
                    GraphDiff(
                        op="add",
                        path=_pointer("claims", claim_id),
                        new_value=self.graph.claims[claim_id].model_dump(mode="json"),
                    ),
                ],
                None,
            )
        if isinstance(operation, SupersedeClaimOperation):
            claim = self.graph.claims[operation.claim_id]
            old = claim.status
            claim.status = operation.status
            claim.temporal.valid_to = operation.provenance.session_date
            claim.provenance.append(operation.provenance)
            return (
                [claim.id],
                [
                    GraphDiff(
                        op="replace",
                        path=_pointer("claims", claim.id, "status"),
                        old_value=old,
                        new_value=claim.status,
                    )
                ],
                None,
            )
        if isinstance(operation, AssertRelationOperation):
            self._validate_snake(operation.predicate, "relation predicate")
            source_id = self._entity(operation.source_ref)
            target_id = self._entity(operation.target_ref)
            relation_id = self.resolver.deterministic_id("relation", batch_id, index)
            self.graph.relations[relation_id] = Relation(
                id=relation_id,
                source_id=source_id,
                predicate=operation.predicate,
                target_id=target_id,
                temporal=TemporalWindow(
                    valid_from=operation.valid_from,
                    valid_to=operation.valid_to,
                    observed_at=operation.provenance.session_date,
                ),
                provenance=[operation.provenance],
            )
            return (
                [relation_id],
                [
                    GraphDiff(
                        op="add",
                        path=_pointer("relations", relation_id),
                        new_value=self.graph.relations[relation_id].model_dump(mode="json"),
                    )
                ],
                None,
            )
        if isinstance(operation, SupersedeRelationOperation):
            relation = self.graph.relations[operation.relation_id]
            old = relation.status
            relation.status = operation.status
            relation.temporal.valid_to = operation.provenance.session_date
            relation.provenance.append(operation.provenance)
            return (
                [relation.id],
                [
                    GraphDiff(
                        op="replace",
                        path=_pointer("relations", relation.id, "status"),
                        old_value=old,
                        new_value=relation.status,
                    )
                ],
                None,
            )
        event_id = self.resolver.deterministic_id("event", batch_id, index)
        participant_ids = [self._entity(ref) for ref in operation.participant_refs]
        self._validate_snake(operation.event_type, "event type")
        self.graph.events[event_id] = MemoryEvent(
            id=event_id,
            event_type=operation.event_type,
            participant_ids=participant_ids,
            occurred_at=operation.occurred_at,
            properties=_properties(operation.properties),
            provenance=[operation.provenance],
        )
        return (
            [event_id],
            [
                GraphDiff(
                    op="add",
                    path=_pointer("events", event_id),
                    new_value=self.graph.events[event_id].model_dump(mode="json"),
                )
            ],
            None,
        )

    def _entity(self, ref: str) -> str:
        entity_id = self.resolver.resolve(ref)
        if entity_id is None:
            raise KeyError(f"unknown entity reference: {ref}")
        return entity_id

    @staticmethod
    def _validate_snake(value: str, label: str) -> None:
        if not _SNAKE_CASE.fullmatch(value):
            raise ValueError(f"{label} must be snake_case: {value}")
