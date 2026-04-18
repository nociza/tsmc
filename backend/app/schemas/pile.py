from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import PileKind


class PileRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    slug: str
    name: str
    description: str | None = None
    kind: PileKind
    folder_label: str
    attributes: list[str] = Field(default_factory=list)
    pipeline_config: dict[str, Any] = Field(default_factory=dict)
    is_active: bool = True
    is_visible_on_dashboard: bool = True
    sort_order: int = 0
    created_at: datetime
    updated_at: datetime


class PileCreate(BaseModel):
    slug: str = Field(min_length=2, max_length=64)
    name: str = Field(min_length=1, max_length=128)
    description: str | None = Field(default=None, max_length=2000)
    folder_label: str | None = Field(default=None, max_length=64)
    attributes: list[str] = Field(default_factory=list)
    pipeline_config: dict[str, Any] = Field(default_factory=dict)
    sort_order: int = 100


class PileUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    description: str | None = Field(default=None, max_length=2000)
    folder_label: str | None = Field(default=None, max_length=64)
    attributes: list[str] | None = None
    pipeline_config: dict[str, Any] | None = None
    is_active: bool | None = None
    sort_order: int | None = None


class PileCount(BaseModel):
    slug: str
    name: str
    count: int


class DiscardedSessionItem(BaseModel):
    id: str
    provider: str
    external_session_id: str
    title: str | None = None
    discarded_reason: str | None = None
    last_captured_at: datetime | None = None
    updated_at: datetime
    markdown_path: str | None = None


class DiscardedSessionsResponse(BaseModel):
    count: int
    items: list[DiscardedSessionItem] = Field(default_factory=list)
