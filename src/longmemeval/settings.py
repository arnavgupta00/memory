from __future__ import annotations

import os

from dotenv import load_dotenv

from longmemeval.constants import PROJECT_ROOT


def load_environment() -> None:
    """Load local development secrets without overriding the caller's environment."""

    load_dotenv(PROJECT_ROOT / ".env", override=False)


def credential_status() -> dict[str, bool]:
    return {
        "openai": bool(os.getenv("OPENAI_API_KEY")),
        "gemini": bool(os.getenv("GEMINI_API_KEY")),
    }
