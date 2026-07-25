from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict

from longmemeval.api import AgentArtifactStore, JsonObject


class ArchitectureEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sequence: int
    schema_version: Literal[1] = 1
    event_type: str
    recorded_at: str
    previous_event_hash: str | None
    graph_state_hash: str | None
    payload: JsonObject
    event_hash: str


def _hash_event(data: JsonObject) -> str:
    payload = json.dumps(data, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


class EventRecorder:
    def __init__(self, artifacts: AgentArtifactStore) -> None:
        self.artifacts = artifacts

    async def record(
        self,
        event_type: str,
        payload: JsonObject,
        *,
        graph_state_hash: str | None = None,
    ) -> ArchitectureEvent:
        existing = self.artifacts.read_stream("events")
        sequence = len(existing) + 1
        previous = None
        if existing:
            prior_hash = existing[-1].get("event_hash")
            previous = prior_hash if isinstance(prior_hash, str) else None
        unsigned: JsonObject = {
            "sequence": sequence,
            "schema_version": 1,
            "event_type": event_type,
            "recorded_at": datetime.now(UTC).isoformat(),
            "previous_event_hash": previous,
            "graph_state_hash": graph_state_hash,
            "payload": payload,
        }
        event = ArchitectureEvent.model_validate({**unsigned, "event_hash": _hash_event(unsigned)})
        await self.artifacts.append("events", event.model_dump(mode="json"))
        return event

    def replay(self) -> list[ArchitectureEvent]:
        events = [
            ArchitectureEvent.model_validate(item) for item in self.artifacts.read_stream("events")
        ]
        previous: str | None = None
        for expected_sequence, event in enumerate(events, start=1):
            if event.sequence != expected_sequence or event.previous_event_hash != previous:
                raise ValueError("architecture event chain is not contiguous")
            unsigned = event.model_dump(mode="json", exclude={"event_hash"})
            if _hash_event(unsigned) != event.event_hash:
                raise ValueError(f"architecture event hash mismatch at {event.sequence}")
            previous = event.event_hash
        return events
