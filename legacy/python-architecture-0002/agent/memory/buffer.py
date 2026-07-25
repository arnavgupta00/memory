from __future__ import annotations

from longmemeval.api import TimestampedSession


class SessionBuffer:
    def __init__(self, batch_size: int) -> None:
        self.batch_size = batch_size
        self._sessions: list[TimestampedSession] = []

    def append(self, session: TimestampedSession) -> list[TimestampedSession] | None:
        self._sessions.append(session.model_copy(deep=True))
        if len(self._sessions) < self.batch_size:
            return None
        return self.flush()

    def flush(self) -> list[TimestampedSession] | None:
        if not self._sessions:
            return None
        sessions = self._sessions
        self._sessions = []
        return sessions

    @property
    def pending_count(self) -> int:
        return len(self._sessions)
