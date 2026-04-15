from __future__ import annotations

from pydantic import BaseModel, Field

from app.models.enums import SessionCategory


class ClassificationResult(BaseModel):
    category: SessionCategory
    reason: str = Field(min_length=1)


class JournalResult(BaseModel):
    entry: str = Field(min_length=1)
    action_items: list[str] = Field(default_factory=list)


class TodoResult(BaseModel):
    summary: str = Field(min_length=1)
    updated_markdown: str = Field(min_length=1)


class TripletResult(BaseModel):
    subject: str = Field(min_length=1)
    predicate: str = Field(min_length=1)
    object: str = Field(min_length=1)
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)


class IdeaResult(BaseModel):
    core_idea: str = Field(min_length=1)
    pros: list[str] = Field(default_factory=list)
    cons: list[str] = Field(default_factory=list)
    next_steps: list[str] = Field(default_factory=list)
    share_post: str = Field(min_length=1, max_length=280)
