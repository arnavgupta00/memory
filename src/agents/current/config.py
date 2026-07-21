from typing import Literal

from pydantic import BaseModel


class CurrentArchitectureConfig(BaseModel):
    chain_of_note: bool = True
    history_format: Literal["json", "text"] = "json"
