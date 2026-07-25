from __future__ import annotations

from openai.lib._pydantic import to_strict_json_schema

from agents.current.contracts.models import ConsolidationOutput, ProvenanceReference
from agents.current.memory.reducer import TemporalGraphReducer, graph_hash


def provenance(session_id: str, batch_id: str, date: str = "2025/01/01") -> ProvenanceReference:
    return ProvenanceReference(
        session_id=session_id,
        turn_index=0,
        session_date=date,
        batch_id=batch_id,
        supporting_excerpt="supported",
    )


def test_identity_reuse_and_append_only_contradiction() -> None:
    reducer = TemporalGraphReducer("question-1")
    first = ConsolidationOutput.model_validate(
        {
            "summary": "Jason moved to Pune.",
            "operations": [
                {
                    "op": "create_entity",
                    "ref": "jason",
                    "kind": "person",
                    "canonical_name": "Jason",
                    "aliases": ["Jase"],
                    "provenance": provenance("s1", "batch-0001").model_dump(),
                },
                {
                    "op": "assert_claim",
                    "subject_ref": "jason",
                    "predicate": "lives_in",
                    "value": "Pune",
                    "valid_from": "2025/01/01",
                    "provenance": provenance("s1", "batch-0001").model_dump(),
                },
            ],
        }
    )
    first_record = reducer.apply("batch-0001", ["s1"], first)
    entity_id = next(iter(reducer.graph.entities))
    claim_id = next(iter(reducer.graph.claims))
    assert all(decision.accepted for decision in first_record.decisions)

    second = ConsolidationOutput.model_validate(
        {
            "summary": "Jase moved to Delhi.",
            "operations": [
                {
                    "op": "create_entity",
                    "ref": "same-person",
                    "kind": "person",
                    "canonical_name": "Jase",
                    "provenance": provenance("s2", "batch-0002", "2025/02/01").model_dump(),
                },
                {
                    "op": "assert_claim",
                    "subject_ref": "same-person",
                    "predicate": "lives_in",
                    "value": "Delhi",
                    "valid_from": "2025/02/01",
                    "provenance": provenance("s2", "batch-0002", "2025/02/01").model_dump(),
                },
            ],
        }
    )
    reducer.apply("batch-0002", ["s2"], second)
    assert list(reducer.graph.entities) == [entity_id]
    assert reducer.graph.claims[claim_id].status == "contradicted"
    assert len(reducer.graph.claims) == 2
    assert {claim.value for claim in reducer.graph.claims.values()} == {"Pune", "Delhi"}


def test_bad_provenance_is_rejected_without_mutating_graph() -> None:
    reducer = TemporalGraphReducer("question-2")
    output = ConsolidationOutput.model_validate(
        {
            "summary": "Unsupported.",
            "operations": [
                {
                    "op": "create_entity",
                    "ref": "x",
                    "kind": "person",
                    "canonical_name": "X",
                    "provenance": provenance("outside", "batch-0001").model_dump(),
                }
            ],
        }
    )
    before = graph_hash(reducer.graph)
    record = reducer.apply("batch-0001", ["s1"], output)
    assert record.decisions[0].accepted is False
    assert graph_hash(reducer.graph) == before
    assert not reducer.graph.entities


def test_dynamic_property_records_are_reduced_into_graph_maps() -> None:
    reducer = TemporalGraphReducer("question-properties")
    output = ConsolidationOutput.model_validate(
        {
            "summary": "Jason has two interests.",
            "operations": [
                {
                    "op": "create_entity",
                    "ref": "jason",
                    "kind": "person",
                    "canonical_name": "Jason",
                    "properties": [
                        {"key": "favorite_color", "value": "blue"},
                        {"key": "interests", "value": ["music", "cycling"]},
                    ],
                    "provenance": provenance("s1", "batch-0001").model_dump(),
                }
            ],
        }
    )
    record = reducer.apply("batch-0001", ["s1"], output)
    entity = next(iter(reducer.graph.entities.values()))
    assert record.decisions[0].accepted is True
    assert entity.properties == {
        "favorite_color": "blue",
        "interests": ["music", "cycling"],
    }


def test_consolidation_contract_has_no_open_ended_object_schemas() -> None:
    schema = to_strict_json_schema(ConsolidationOutput)

    def visit(value: object) -> None:
        if isinstance(value, dict):
            assert "oneOf" not in value
            if value.get("type") == "object":
                assert "properties" in value
                assert value.get("additionalProperties") is False
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(schema)


def test_invalid_dynamic_property_rejects_only_its_operation() -> None:
    reducer = TemporalGraphReducer("question-invalid-property")
    output = ConsolidationOutput.model_validate(
        {
            "summary": "One invalid property followed by one valid entity.",
            "operations": [
                {
                    "op": "create_entity",
                    "ref": "invalid",
                    "kind": "person",
                    "canonical_name": "Invalid",
                    "properties": [{"key": "Not_Snake", "value": "value"}],
                    "provenance": provenance("s1", "batch-0001").model_dump(),
                },
                {
                    "op": "create_entity",
                    "ref": "valid",
                    "kind": "person",
                    "canonical_name": "Valid",
                    "provenance": provenance("s1", "batch-0001").model_dump(),
                },
            ],
        }
    )
    record = reducer.apply("batch-0001", ["s1"], output)
    assert [decision.accepted for decision in record.decisions] == [False, True]
    assert len(reducer.graph.entities) == 1
