from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict

from app.models.enums import MessageRole, ProviderName, SessionCategory


class MessageRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    external_message_id: str
    parent_external_message_id: str | None
    role: MessageRole
    content: str
    sequence_index: int
    occurred_at: datetime | None
    raw_payload: dict[str, Any] | list[Any] | None
    created_at: datetime


class TripletRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    subject: str
    predicate: str
    object: str
    confidence: float | None
    created_at: datetime


class SessionListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    provider: ProviderName
    external_session_id: str
    title: str | None
    category: SessionCategory | None
    custom_tags: list[str]
    markdown_path: str | None
    share_post: str | None
    updated_at: datetime
    last_captured_at: datetime | None
    last_processed_at: datetime | None


class SessionRead(SessionListItem):
    source_url: str | None
    classification_reason: str | None
    journal_entry: str | None
    todo_summary: str | None
    idea_summary: dict[str, Any] | None
    created_at: datetime
    messages: list[MessageRead]
    triplets: list[TripletRead]
