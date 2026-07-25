from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from longmemeval.api import JsonObject, JsonValue

_SNAKE_CASE = re.compile(r"^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$")


def _validate_property_keys(value: JsonObject) -> JsonObject:
    invalid = sorted(key for key in value if not _SNAKE_CASE.fullmatch(key))
    if invalid:
        raise ValueError(f"property keys must be snake_case: {invalid}")
    return value


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


type DraftScalar = str | int | float | bool | None
type DraftValue = DraftScalar | list[DraftScalar]


class DraftProperty(StrictModel):
    """A dynamic key/value pair that remains valid strict JSON Schema."""

    key: str
    value: DraftValue


class ProvenanceReference(StrictModel):
    session_id: str
    turn_index: int = Field(ge=0)
    session_date: str
    batch_id: str
    supporting_excerpt: str | None = None


class TemporalWindow(StrictModel):
    valid_from: str | None = None
    valid_to: str | None = None
    observed_at: str


class Entity(StrictModel):
    id: str
    kind: str
    canonical_name: str
    aliases: list[str] = Field(default_factory=list)
    properties: JsonObject = Field(default_factory=dict)
    provenance: list[ProvenanceReference] = Field(default_factory=list)

    @field_validator("kind")
    @classmethod
    def kind_is_snake_case(cls, value: str) -> str:
        if not _SNAKE_CASE.fullmatch(value):
            raise ValueError("entity kind must be singular snake_case")
        return value

    _properties_are_snake_case = field_validator("properties")(_validate_property_keys)


class Claim(StrictModel):
    id: str
    subject_id: str
    predicate: str
    value: JsonValue
    status: Literal["active", "superseded", "contradicted"] = "active"
    temporal: TemporalWindow
    provenance: list[ProvenanceReference]

    @field_validator("predicate")
    @classmethod
    def predicate_is_snake_case(cls, value: str) -> str:
        if not _SNAKE_CASE.fullmatch(value):
            raise ValueError("claim predicate must be snake_case")
        return value


class Relation(StrictModel):
    id: str
    source_id: str
    predicate: str
    target_id: str
    status: Literal["active", "superseded", "contradicted"] = "active"
    temporal: TemporalWindow
    provenance: list[ProvenanceReference]

    @field_validator("predicate")
    @classmethod
    def predicate_is_snake_case(cls, value: str) -> str:
        if not _SNAKE_CASE.fullmatch(value):
            raise ValueError("relation predicate must be snake_case")
        return value


class MemoryEvent(StrictModel):
    id: str
    event_type: str
    participant_ids: list[str]
    occurred_at: str | None = None
    properties: JsonObject = Field(default_factory=dict)
    provenance: list[ProvenanceReference]

    @field_validator("event_type")
    @classmethod
    def event_type_is_snake_case(cls, value: str) -> str:
        if not _SNAKE_CASE.fullmatch(value):
            raise ValueError("event type must be snake_case")
        return value

    _properties_are_snake_case = field_validator("properties")(_validate_property_keys)


class CreateEntityOperation(StrictModel):
    op: Literal["create_entity"]
    ref: str
    kind: str
    canonical_name: str
    aliases: list[str] = Field(default_factory=list)
    properties: list[DraftProperty] = Field(default_factory=list)
    provenance: ProvenanceReference


class AddAliasOperation(StrictModel):
    op: Literal["add_alias"]
    entity_ref: str
    alias: str
    provenance: ProvenanceReference


class SetEntityPropertyOperation(StrictModel):
    op: Literal["set_entity_property"]
    entity_ref: str
    key: str
    value: DraftValue
    provenance: ProvenanceReference


class AssertClaimOperation(StrictModel):
    op: Literal["assert_claim"]
    subject_ref: str
    predicate: str
    value: DraftValue
    valid_from: str | None = None
    valid_to: str | None = None
    provenance: ProvenanceReference


class SupersedeClaimOperation(StrictModel):
    op: Literal["supersede_claim"]
    claim_id: str
    status: Literal["superseded", "contradicted"] = "superseded"
    provenance: ProvenanceReference


class AssertRelationOperation(StrictModel):
    op: Literal["assert_relation"]
    source_ref: str
    predicate: str
    target_ref: str
    valid_from: str | None = None
    valid_to: str | None = None
    provenance: ProvenanceReference


class SupersedeRelationOperation(StrictModel):
    op: Literal["supersede_relation"]
    relation_id: str
    status: Literal["superseded", "contradicted"] = "superseded"
    provenance: ProvenanceReference


class RecordEventOperation(StrictModel):
    op: Literal["record_event"]
    event_type: str
    participant_refs: list[str]
    occurred_at: str | None = None
    properties: list[DraftProperty] = Field(default_factory=list)
    provenance: ProvenanceReference


DraftOperation = (
    CreateEntityOperation
    | AddAliasOperation
    | SetEntityPropertyOperation
    | AssertClaimOperation
    | SupersedeClaimOperation
    | AssertRelationOperation
    | SupersedeRelationOperation
    | RecordEventOperation
)


class ConsolidationOutput(StrictModel):
    summary: str
    operations: list[DraftOperation]


class GraphState(StrictModel):
    schema_version: Literal[1] = 1
    entities: dict[str, Entity] = Field(default_factory=dict)
    claims: dict[str, Claim] = Field(default_factory=dict)
    relations: dict[str, Relation] = Field(default_factory=dict)
    events: dict[str, MemoryEvent] = Field(default_factory=dict)


class OperationDecision(StrictModel):
    operation_index: int = Field(ge=0)
    accepted: bool
    reason: str | None = None
    canonical_ids: list[str] = Field(default_factory=list)


class GraphDiff(StrictModel):
    op: Literal["add", "replace"]
    path: str
    old_value: JsonValue = None
    new_value: JsonValue


class BatchRecord(StrictModel):
    batch_id: str
    session_ids: list[str]
    summary: str
    decisions: list[OperationDecision]
    warnings: list[str]
    diffs: list[GraphDiff]
    graph_hash: str


class QueryPlan(StrictModel):
    entity_hints: list[str] = Field(default_factory=list)
    lexical_terms: list[str] = Field(default_factory=list)
    predicates: list[str] = Field(default_factory=list)
    temporal_constraints: list[str] = Field(default_factory=list)
    likely_hops: int = Field(default=1, ge=0, le=2)


class RetrievalCandidate(StrictModel):
    id: str
    kind: Literal["entity", "claim", "relation", "event", "batch", "session"]
    text: str
    session_ids: list[str] = Field(default_factory=list)
    channels: list[str] = Field(default_factory=list)
    fused_score: float = 0.0


class EvidenceChoice(StrictModel):
    candidate_id: str
    reason: str


class RerankOutput(StrictModel):
    selected: list[EvidenceChoice]


class FinalEvidence(StrictModel):
    session_id: str
    turn_index: int | None = Field(default=None, ge=0)


class FinalAnswerOutput(StrictModel):
    hypothesis: str
    evidence: list[FinalEvidence] = Field(default_factory=list)
    support_status: Literal["supported", "conflicted", "insufficient"]
