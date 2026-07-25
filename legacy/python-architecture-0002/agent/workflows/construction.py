from __future__ import annotations

import json
from contextlib import suppress
from pathlib import Path
from typing import cast

from agents.current.artifacts.recorder import EventRecorder
from agents.current.config import CurrentArchitectureConfig
from agents.current.contracts.models import BatchRecord, ConsolidationOutput, GraphState
from agents.current.memory.buffer import SessionBuffer
from agents.current.memory.reducer import TemporalGraphReducer
from agents.current.prompts.loader import render_prompt
from longmemeval.api import AgentRuntime, JsonObject, JsonValue, TimestampedSession


class ConstructionWorkflow:
    def __init__(
        self,
        runtime: AgentRuntime,
        config: CurrentArchitectureConfig,
        question_id: str,
    ) -> None:
        self.runtime = runtime
        self.config = config
        self.question_id = question_id
        self.buffer = SessionBuffer(config.batch_size)
        self.reducer = TemporalGraphReducer(question_id)
        self.recorder = EventRecorder(runtime.artifacts)
        self.sessions: list[TimestampedSession] = []
        self.batches: list[BatchRecord] = []
        self._known_session_ids: set[str] = set()

    @property
    def graph(self) -> GraphState:
        return self.reducer.graph

    async def resume(self) -> None:
        archived = [
            TimestampedSession.model_validate(record)
            for record in self.runtime.artifacts.read_stream("sessions")
        ]
        self.sessions = archived
        self._known_session_ids = {session.session_id for session in archived}
        covered: set[str] = set()
        for event in self.recorder.replay():
            if event.event_type != "batch_applied":
                continue
            raw_output = event.payload.get("consolidation")
            raw_batch_id = event.payload.get("batch_id")
            raw_session_ids = event.payload.get("session_ids")
            if (
                not isinstance(raw_output, dict)
                or not isinstance(raw_batch_id, str)
                or not isinstance(raw_session_ids, list)
                or not all(isinstance(item, str) for item in raw_session_ids)
            ):
                raise ValueError("malformed batch replay event")
            session_ids = [item for item in raw_session_ids if isinstance(item, str)]
            output = ConsolidationOutput.model_validate(raw_output)
            batch = self.reducer.apply(raw_batch_id, session_ids, output)
            if batch.graph_hash != event.graph_state_hash:
                raise ValueError(f"graph replay hash mismatch after {raw_batch_id}")
            self.batches.append(batch)
            covered.update(session_ids)
        uncovered = [session for session in archived if session.session_id not in covered]
        while len(uncovered) >= self.config.batch_size:
            incomplete = uncovered[: self.config.batch_size]
            uncovered = uncovered[self.config.batch_size :]
            await self._consolidate(incomplete)
        for session in uncovered:
            self.buffer.append(session)

    async def ingest(self, session: TimestampedSession) -> None:
        if session.session_id in self._known_session_ids:
            return
        copied = session.model_copy(deep=True)
        self.sessions.append(copied)
        self._known_session_ids.add(copied.session_id)
        await self.runtime.artifacts.append("sessions", copied.model_dump(mode="json"))
        await self.recorder.record(
            "session_ingested",
            {"session_id": copied.session_id, "session_date": copied.date},
            graph_state_hash=self.batches[-1].graph_hash if self.batches else None,
        )
        batch = self.buffer.append(copied)
        if batch is not None:
            await self._consolidate(batch)

    async def flush(self) -> None:
        remainder = self.buffer.flush()
        if remainder:
            await self._consolidate(remainder)

    async def _consolidate(self, sessions: list[TimestampedSession]) -> None:
        batch_id = f"batch-{len(self.batches) + 1:04d}"
        prompt = render_prompt(
            self._prompt_path("batch_consolidator.yaml"),
            {
                "batch_id": batch_id,
                "sessions": [session.model_dump(mode="json") for session in sessions],
                "entity_catalog": [
                    {
                        "id": entity.id,
                        "kind": entity.kind,
                        "canonical_name": entity.canonical_name,
                        "aliases": cast(JsonValue, entity.aliases),
                    }
                    for entity in self.graph.entities.values()
                ],
                "active_claims": {
                    "claims": [
                        claim.model_dump(mode="json")
                        for claim in self.graph.claims.values()
                        if claim.status == "active"
                    ],
                    "relations": [
                        relation.model_dump(mode="json")
                        for relation in self.graph.relations.values()
                        if relation.status == "active"
                    ],
                },
            },
            output_contract="consolidation_output_v1",
        )
        response = await self.runtime.models.generate_structured(
            self.config.batch_role,
            prompt,
            ConsolidationOutput,
        )
        session_ids = [session.session_id for session in sessions]
        record = self.reducer.apply(batch_id, session_ids, response.value)
        self.batches.append(record)
        payload: JsonObject = {
            "batch_id": batch_id,
            "session_ids": cast(JsonValue, session_ids),
            "consolidation": response.value.model_dump(mode="json"),
            "batch_record": record.model_dump(mode="json"),
        }
        await self.recorder.record(
            "batch_applied",
            payload,
            graph_state_hash=record.graph_hash,
        )
        with suppress(FileExistsError):
            await self.runtime.artifacts.write_once(
                f"batches/{batch_id}.json", record.model_dump(mode="json")
            )

    def _prompt_path(self, name: str) -> Path:
        directory = Path(self.config.prompt_directory)
        if not directory.is_absolute():
            directory = Path(__file__).resolve().parents[1] / directory
        return directory / name

    def overview(self) -> str:
        return json.dumps(
            {
                "entities": [
                    {
                        "id": entity.id,
                        "kind": entity.kind,
                        "name": entity.canonical_name,
                        "aliases": entity.aliases,
                    }
                    for entity in self.graph.entities.values()
                ],
                "active_predicates": sorted(
                    {
                        claim.predicate
                        for claim in self.graph.claims.values()
                        if claim.status == "active"
                    }
                    | {
                        relation.predicate
                        for relation in self.graph.relations.values()
                        if relation.status == "active"
                    }
                ),
                "batch_summaries": [batch.summary for batch in self.batches],
            },
            ensure_ascii=False,
            sort_keys=True,
        )
