from __future__ import annotations

import asyncio
import json
from collections.abc import Mapping
from pathlib import Path
from typing import cast

from longmemeval.artifacts import redact_json
from longmemeval.config import AgentConfig, ProviderConfig
from longmemeval.constants import PROJECT_ROOT
from longmemeval.models import (
    AnswerResult,
    CaseMetadata,
    JsonObject,
    JsonValue,
    MemoryAgent,
    ModelCallRecord,
    TimestampedSession,
)

PROTOCOL_VERSION = 1


class NodeAgentError(RuntimeError):
    pass


class NodeAgentHost:
    def __init__(
        self,
        process: asyncio.subprocess.Process,
        stderr_task: asyncio.Task[None],
    ) -> None:
        self._process = process
        self._stderr_task = stderr_task
        self._reader_task = asyncio.create_task(self._read_responses())
        self._write_lock = asyncio.Lock()
        # Serialize full request/response cycles. Concurrent reset/answer replies can
        # each be hundreds of KB; overlapping stdout writes deadlocked the pipe.
        self._request_lock = asyncio.Lock()
        self._pending: dict[str, asyncio.Future[JsonValue]] = {}
        self._next_id = 0

    @classmethod
    async def start(
        cls,
        *,
        run_path: Path,
        config: AgentConfig,
        answer: ProviderConfig,
        capture_model_io: bool,
        auto_export_final_svg: bool,
    ) -> NodeAgentHost:
        entrypoint = (PROJECT_ROOT / config.entrypoint).resolve()
        if PROJECT_ROOT.resolve() not in entrypoint.parents:
            raise ValueError("Node agent entrypoint must be inside the project")
        if entrypoint.suffix != ".js":
            raise ValueError("Node agent entrypoint must be a compiled JavaScript file")
        if not entrypoint.exists():
            raise FileNotFoundError(
                f"Node agent is not built: {entrypoint}. Run `pnpm agent:build`."
            )
        # Reset/answer payloads can be multi‑MB (full resumed sessions). The default
        # asyncio StreamReader limit is 64KiB; exceeding it kills the reader task and
        # permanently hangs the pending RPC.
        process = await asyncio.create_subprocess_exec(
            "node",
            str(entrypoint),
            cwd=PROJECT_ROOT,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=16 * 1024 * 1024,
        )
        stderr_task = asyncio.create_task(_capture_stderr(process, run_path / "agent-host.log"))
        host = cls(process, stderr_task)
        roles: JsonObject = {
            name: cast(JsonObject, role.model_dump(mode="json", exclude_none=False))
            for name, role in config.models.items()
        }
        roles["answer"] = cast(
            JsonObject,
            answer.model_dump(mode="json", exclude_none=False) | {"kind": "generation"},
        )
        answer_limit = next(
            (
                limit
                for limit in config.provider_model_limits
                if limit.provider == answer.provider and limit.model == answer.model
            ),
            None,
        )
        if answer_limit is None:
            raise ValueError(
                f"Node answer role is missing provider/model rate limit: "
                f"{answer.provider}/{answer.model}"
            )
        provider_model_limits: list[JsonValue] = [
            cast(JsonObject, limit.model_dump(mode="json"))
            for limit in config.provider_model_limits
        ]
        await host.request(
            "initialize",
            {
                "runId": run_path.name,
                "runRoot": str(run_path.resolve()),
                "roles": roles,
                "providerModelLimits": provider_model_limits,
                "options": dict(config.options),
                "captureModelIo": capture_model_io,
                "autoExportFinalSvg": auto_export_final_svg,
            },
        )
        return host

    async def request(self, method: str, params: JsonObject) -> JsonValue:
        if self._process.returncode is not None:
            raise NodeAgentError(f"Node agent host exited with code {self._process.returncode}")
        async with self._request_lock:
            self._next_id += 1
            request_id = str(self._next_id)
            loop = asyncio.get_running_loop()
            future: asyncio.Future[JsonValue] = loop.create_future()
            self._pending[request_id] = future
            request = {
                "protocolVersion": PROTOCOL_VERSION,
                "id": request_id,
                "method": method,
                "params": params,
            }
            stdin = self._process.stdin
            if stdin is None:
                raise NodeAgentError("Node agent host stdin is unavailable")
            async with self._write_lock:
                stdin.write((json.dumps(request, separators=(",", ":")) + "\n").encode())
                await stdin.drain()
            return await future

    async def close(self) -> None:
        if self._process.returncode is None:
            try:
                await asyncio.wait_for(self.request("shutdown", {}), timeout=5)
            except (TimeoutError, NodeAgentError):
                self._process.terminate()
        try:
            await asyncio.wait_for(self._process.wait(), timeout=10)
        except TimeoutError:
            self._process.kill()
            await self._process.wait()
        await asyncio.gather(self._reader_task, self._stderr_task, return_exceptions=True)

    async def _read_responses(self) -> None:
        stdout = self._process.stdout
        if stdout is None:
            return
        try:
            while line := await stdout.readline():
                try:
                    response = json.loads(line)
                    request_id = str(response["id"])
                    future = self._pending.pop(request_id, None)
                    if future is None:
                        continue
                    if response.get("protocolVersion") != PROTOCOL_VERSION:
                        future.set_exception(
                            NodeAgentError("Node agent protocol version mismatch")
                        )
                    elif response.get("ok") is True:
                        future.set_result(response.get("result"))
                    else:
                        error = response.get("error") or {}
                        future.set_exception(
                            NodeAgentError(
                                f"{error.get('type', 'NodeAgentError')}: "
                                f"{error.get('message', 'unknown Node agent failure')}"
                            )
                        )
                except Exception as exc:
                    for future in self._pending.values():
                        if not future.done():
                            future.set_exception(
                                NodeAgentError(f"invalid Node host response: {exc}")
                            )
                    self._pending.clear()
        except Exception as exc:
            error = NodeAgentError(f"Node agent host stdout reader failed: {exc}")
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(error)
            self._pending.clear()
            return
        if self._pending:
            error = NodeAgentError(
                f"Node agent host closed stdout with code {self._process.returncode}"
            )
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(error)
            self._pending.clear()


class NodeMemoryAgent(MemoryAgent):
    def __init__(self, host: NodeAgentHost) -> None:
        self._host = host
        self._case_id: str | None = None
        self._model_calls: list[ModelCallRecord] = []
        self._processed_sessions: list[TimestampedSession] = []
        self._resume_cursor = 0

    async def reset(self, case: CaseMetadata) -> None:
        self._case_id = case.question_id
        # Benchmark question types remain in the Python reporting layer. The active
        # agent receives only an opaque case ID, so category labels cannot influence
        # construction, retrieval, reading, or answering.
        result = await self._host.request("reset", {"case": {"question_id": case.question_id}})
        if not isinstance(result, Mapping):
            raise NodeAgentError("Node reset response must be an object")
        raw_sessions = result.get("processedSessions")
        if not isinstance(raw_sessions, list):
            raise NodeAgentError("Node reset response is missing processedSessions")
        self._processed_sessions = [
            TimestampedSession.model_validate(item) for item in raw_sessions
        ]
        self._resume_cursor = 0

    async def ingest(self, session: TimestampedSession) -> None:
        await self._host.request(
            "ingest",
            {
                "caseId": self._require_case_id(),
                "session": session.model_dump(mode="json"),
            },
        )

    async def answer(self, question: str, question_date: str) -> AnswerResult:
        result = await self._host.request(
            "answer",
            {
                "caseId": self._require_case_id(),
                "question": question,
                "questionDate": question_date,
            },
        )
        if not isinstance(result, Mapping):
            raise NodeAgentError("Node answer response must be an object")
        answer = AnswerResult.model_validate(result.get("answer"))
        raw_calls = result.get("modelCalls")
        if not isinstance(raw_calls, list):
            raise NodeAgentError("Node answer response is missing modelCalls")
        self._model_calls = [ModelCallRecord.model_validate(item) for item in raw_calls]
        return answer

    def finish_model_calls(self) -> list[ModelCallRecord]:
        calls = self._model_calls
        self._model_calls = []
        return calls

    def should_ingest(self, session: TimestampedSession) -> bool:
        """Skip the durable session prefix while resuming a partially completed case."""

        if self._resume_cursor >= len(self._processed_sessions):
            return True
        expected = self._processed_sessions[self._resume_cursor]
        if expected != session:
            raise NodeAgentError(
                f"session changed at resume position {self._resume_cursor}"
            )
        self._resume_cursor += 1
        return False

    def _require_case_id(self) -> str:
        if self._case_id is None:
            raise RuntimeError("reset must be called before ingest or answer")
        return self._case_id


async def _capture_stderr(process: asyncio.subprocess.Process, path: Path) -> None:
    stderr = process.stderr
    if stderr is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    while line := await stderr.readline():
        sanitized = redact_json(line.decode(errors="replace"))
        with path.open("a") as handle:
            handle.write(str(sanitized))
