from __future__ import annotations

import hashlib

from agents.baselines.full_context.config import FullContextConfig
from agents.baselines.full_context.prompt import answer_prompt
from longmemeval.api import (
    AgentRuntime,
    AnswerResult,
    CaseMetadata,
    EvidenceReference,
    MemoryAgent,
    TimestampedSession,
)

ARCHITECTURE_ID = "0001-full-context"


class FullContextAgent:
    def __init__(self, runtime: AgentRuntime) -> None:
        self.runtime = runtime
        self.config = FullContextConfig.model_validate(dict(runtime.options))
        self._case: CaseMetadata | None = None
        self._sessions: list[TimestampedSession] = []

    async def reset(self, case: CaseMetadata) -> None:
        self._case = case
        self._sessions = []

    async def ingest(self, session: TimestampedSession) -> None:
        if self._case is None:
            raise RuntimeError("reset must be called before ingest")
        self._sessions.append(session.model_copy(deep=True))

    async def answer(self, question: str, question_date: str) -> AnswerResult:
        if self._case is None:
            raise RuntimeError("reset must be called before answer")
        prompt = answer_prompt(self._sessions, question, question_date, self.config)
        response = await self.runtime.models.generate(self.runtime.answer_role, prompt)
        return AnswerResult(
            hypothesis=response.text,
            evidence=[EvidenceReference(session_id=item.session_id) for item in self._sessions],
            trace={
                "architecture_id": ARCHITECTURE_ID,
                "prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(),
                "context_session_ids": [item.session_id for item in self._sessions],
                "context_session_count": len(self._sessions),
            },
            generation=response,
        )


def create_agent(runtime: AgentRuntime) -> MemoryAgent:
    return FullContextAgent(runtime)
