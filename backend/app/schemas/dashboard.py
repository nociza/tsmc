from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from app.models.enums import SessionCategory


class CategoryCount(BaseModel):
    category: SessionCategory
    count: int


class CustomCategoryCount(BaseModel):
    name: str
    count: int


class DashboardSummary(BaseModel):
    total_sessions: int
    total_messages: int
    total_triplets: int
    total_sync_events: int
    active_tokens: int
    latest_sync_at: datetime | None
    categories: list[CategoryCount]
    custom_categories: list[CustomCategoryCount] = Field(default_factory=list)
