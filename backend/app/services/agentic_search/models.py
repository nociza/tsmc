from __future__ import annotations

from dataclasses import dataclass

from pydantic import BaseModel, Field


@dataclass(slots=True)
class VaultSearchHit:
    path: str
    score: int
    snippet: str
    line_number: int | None = None


class AgenticSearchCandidate(BaseModel):
    path: str
    reason: str
    snippet: str = ""


class AgenticSearchResponse(BaseModel):
    results: list[AgenticSearchCandidate] = Field(default_factory=list)
