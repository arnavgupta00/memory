from __future__ import annotations

from agents.current.artifacts.svg import render_graph_svg
from agents.current.config import CurrentArchitectureConfig
from agents.current.workflows.answering import AnsweringWorkflow
from agents.current.workflows.construction import ConstructionWorkflow
from longmemeval.api import (
    AgentRuntime,
    AnswerResult,
    CaseMetadata,
    JsonValue,
    MemoryAgent,
    TimestampedSession,
)

ARCHITECTURE_ID = "0002-temporal-context-graph"


class TemporalContextGraphAgent:
    def __init__(self, runtime: AgentRuntime) -> None:
        self.runtime = runtime
        self.config = CurrentArchitectureConfig.model_validate(dict(runtime.options))
        self._case: CaseMetadata | None = None
        self._memory: ConstructionWorkflow | None = None

    async def reset(self, case: CaseMetadata) -> None:
        self._case = case
        self._memory = ConstructionWorkflow(self.runtime, self.config, case.question_id)
        await self._memory.resume()

    async def ingest(self, session: TimestampedSession) -> None:
        if self._memory is None:
            raise RuntimeError("reset must be called before ingest")
        await self._memory.ingest(session)

    async def answer(self, question: str, question_date: str) -> AnswerResult:
        if self._memory is None or self._case is None:
            raise RuntimeError("reset must be called before answer")
        await self._memory.flush()
        workflow = AnsweringWorkflow(self.runtime, self.config, self._memory)
        result = await workflow.answer(question, question_date)
        await self._write_final_artifacts(result)
        return result

    async def _write_final_artifacts(self, result: AnswerResult) -> None:
        if self._memory is None:
            return
        artifacts: list[tuple[str, JsonValue | str]] = [
            ("final-graph.json", self._memory.graph.model_dump(mode="json")),
            ("answer.json", result.model_dump(mode="json", exclude_none=True)),
            ("final.svg", render_graph_svg(self._memory.graph)),
        ]
        for name, value in artifacts:
            try:
                await self.runtime.artifacts.write_once(name, value)
            except FileExistsError:
                continue


def create_agent(runtime: AgentRuntime) -> MemoryAgent:
    return TemporalContextGraphAgent(runtime)
