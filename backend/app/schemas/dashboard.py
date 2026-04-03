from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel

from app.models.enums import SessionCategory


class CategoryCount(BaseModel):
    category: SessionCategory
    count: int


class DashboardSummary(BaseModel):
    total_sessions: int
    total_messages: int
    total_triplets: int
    total_sync_events: int
    active_tokens: int
    latest_sync_at: datetime | None
    categories: list[CategoryCount]
