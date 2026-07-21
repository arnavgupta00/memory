from __future__ import annotations

import json

from agents.current.config import CurrentArchitectureConfig
from longmemeval.api import TimestampedSession


def format_sessions(sessions: list[TimestampedSession], history_format: str) -> str:
    blocks: list[str] = []
    for index, session in enumerate(sessions, start=1):
        if history_format == "json":
            content = json.dumps([turn.model_dump() for turn in session.turns], ensure_ascii=False)
        elif history_format == "text":
            content = "\n".join(f"{turn.role}: {turn.content}" for turn in session.turns)
        else:
            raise ValueError(f"unsupported history format: {history_format}")
        blocks.append(
            f"### Session {index}:\nSession Date: {session.date}\nSession Content:\n{content}"
        )
    return "\n\n".join(blocks)


def answer_prompt(
    sessions: list[TimestampedSession],
    question: str,
    question_date: str,
    config: CurrentArchitectureConfig,
) -> str:
    history = format_sessions(sessions, config.history_format)
    introduction = (
        "I will give you several history chats between you and a user. "
        "Please answer the question based on the relevant chat history."
    )
    if config.chain_of_note:
        instruction = (
            "Answer the question step by step: first extract all the relevant information, "
            "and then reason over the information to get the answer."
        )
        suffix = "Answer (step by step):"
    else:
        instruction = ""
        suffix = "Answer:"
    return (
        f"{introduction}\n{instruction}\n\n"
        f"History Chats:\n{history}\n\n"
        f"Current Date: {question_date}\nQuestion: {question}\n{suffix}"
    )
