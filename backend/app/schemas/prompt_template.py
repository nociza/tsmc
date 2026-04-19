from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class PromptTemplateVariableRead(BaseModel):
    name: str
    description: str


class PromptTemplateRead(BaseModel):
    key: str
    title: str
    group: str
    description: str
    system_prompt: str
    user_prompt: str
    default_system_prompt: str
    default_user_prompt: str
    has_override: bool
    variables: list[PromptTemplateVariableRead] = Field(default_factory=list)
    updated_at: datetime | None = None


class PromptTemplateUpdate(BaseModel):
    system_prompt: str = Field(min_length=1, max_length=40_000)
    user_prompt: str = Field(min_length=1, max_length=80_000)
