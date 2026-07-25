from __future__ import annotations

from contextlib import suppress
from pathlib import Path
from typing import cast

from agents.current.config import CurrentArchitectureConfig
from agents.current.contracts.models import (
    FinalAnswerOutput,
    QueryPlan,
    RerankOutput,
    RetrievalCandidate,
)
from agents.current.prompts.loader import render_prompt
from agents.current.retrieval.context import compile_context
from agents.current.retrieval.search import retrieve_candidates
from agents.current.workflows.construction import ConstructionWorkflow
from longmemeval.api import (
    AgentRuntime,
    AnswerResult,
    EvidenceReference,
    JsonObject,
    JsonValue,
)


class AnsweringWorkflow:
    def __init__(
        self,
        runtime: AgentRuntime,
        config: CurrentArchitectureConfig,
        memory: ConstructionWorkflow,
    ) -> None:
        self.runtime = runtime
        self.config = config
        self.memory = memory

    async def answer(self, question: str, question_date: str) -> AnswerResult:
        planner_prompt = render_prompt(
            self._prompt_path("query_planner.yaml"),
            {
                "question": question,
                "question_date": question_date,
                "graph_overview": self.memory.overview(),
            },
            output_contract="query_plan_v1",
        )
        planned = await self.runtime.models.generate_structured(
            self.config.planner_role, planner_prompt, QueryPlan
        )
        candidates = retrieve_candidates(
            self.memory.graph,
            self.memory.batches,
            self.memory.sessions,
            planned.value,
            question,
            limit=self.config.candidate_limit,
            rrf_k=self.config.rrf_k,
            latest_count=self.config.latest_session_count,
        )
        rerank_prompt = render_prompt(
            self._prompt_path("evidence_reranker.yaml"),
            {
                "question": question,
                "question_date": question_date,
                "candidates": [item.model_dump(mode="json") for item in candidates],
                "evidence_limit": self.config.evidence_limit,
            },
            output_contract="rerank_output_v1",
        )
        reranked = await self.runtime.models.generate_structured(
            self.config.reranker_role, rerank_prompt, RerankOutput
        )
        selected, invalid_reranker_ids = self._validate_selection(candidates, reranked.value)
        context = compile_context(
            self.memory.graph,
            self.memory.batches,
            self.memory.sessions,
            selected,
            latest_count=self.config.latest_session_count,
            historical_limit=self.config.historical_session_limit,
            character_budget=self.config.context_character_budget,
        )
        with suppress(FileExistsError):
            await self.runtime.artifacts.write_once("final-context.json", context)
        final_prompt = render_prompt(
            self._prompt_path("final_answer.yaml"),
            {
                "question": question,
                "question_date": question_date,
                "final_context": context,
            },
            output_contract="final_answer_output_v1",
        )
        final = await self.runtime.models.generate_structured(
            self.config.answer_role, final_prompt, FinalAnswerOutput
        )
        known_sessions = {session.session_id for session in self.memory.sessions}
        invalid_final_ids = [
            item.session_id
            for item in final.value.evidence
            if item.session_id not in known_sessions
        ]
        valid_evidence = [
            item for item in final.value.evidence if item.session_id in known_sessions
        ]
        trace: JsonObject = {
            "architecture_id": "0002-temporal-context-graph",
            "batch_size": self.config.batch_size,
            "session_count": len(self.memory.sessions),
            "batch_count": len(self.memory.batches),
            "candidate_count": len(candidates),
            "selected_evidence_count": len(selected),
            "support_status": final.value.support_status,
            "graph_hash": self.memory.batches[-1].graph_hash if self.memory.batches else None,
            "invalid_reranker_candidate_ids": cast(
                JsonValue, list(dict.fromkeys(invalid_reranker_ids))
            ),
            "invalid_final_evidence_session_ids": cast(
                JsonValue, list(dict.fromkeys(invalid_final_ids))
            ),
        }
        return AnswerResult(
            hypothesis=final.value.hypothesis,
            evidence=[
                EvidenceReference(session_id=item.session_id, turn_index=item.turn_index)
                for item in valid_evidence
            ],
            trace=trace,
            generation=final.generation,
        )

    def _validate_selection(
        self,
        candidates: list[RetrievalCandidate],
        reranked: RerankOutput,
    ) -> tuple[list[RetrievalCandidate], list[str]]:
        by_id = {candidate.id: candidate for candidate in candidates}
        selected: list[RetrievalCandidate] = []
        invalid: list[str] = []
        for choice in reranked.selected[: self.config.evidence_limit]:
            candidate = by_id.get(choice.candidate_id)
            if candidate is None:
                invalid.append(choice.candidate_id)
                continue
            if candidate not in selected:
                selected.append(candidate)
        if not selected:
            selected = candidates[: self.config.evidence_limit]
        return selected, invalid

    def _prompt_path(self, name: str) -> Path:
        directory = Path(self.config.prompt_directory)
        if not directory.is_absolute():
            directory = Path(__file__).resolve().parents[1] / directory
        return directory / name
