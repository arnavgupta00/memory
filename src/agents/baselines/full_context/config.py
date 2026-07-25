from typing import Literal

from pydantic import BaseModel, ConfigDict


class FullContextConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    chain_of_note: bool = True
    history_format: Literal["json", "text"] = "json"
    prompt_template: str = "prompts/full_history.yaml"
