from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

from app.models.enums import MessageRole, ProviderName, SessionCategory


class IngestMessage(BaseModel):
    external_message_id: str = Field(min_length=1, max_length=255)
    parent_external_message_id: str | None = Field(default=None, max_length=255)
    role: MessageRole = MessageRole.UNKNOWN
    content: str = Field(min_length=1)
    occurred_at: datetime | None = None
    raw_payload: dict[str, Any] | list[Any] | None = None


class IngestDiffRequest(BaseModel):
    provider: ProviderName
    external_session_id: str = Field(min_length=1, max_length=255)
    sync_mode: Literal["incremental", "full_snapshot"] = "incremental"
    title: str | None = None
    source_url: str | None = None
    captured_at: datetime | None = None
    custom_tags: list[str] = Field(default_factory=list)
    messages: list[IngestMessage] = Field(default_factory=list)
    raw_capture: dict[str, Any] | list[Any] | None = None

    @model_validator(mode="after")
    def validate_unique_message_ids(self) -> "IngestDiffRequest":
        seen: set[str] = set()
        duplicates: set[str] = set()
        for message in self.messages:
            if message.external_message_id in seen:
                duplicates.add(message.external_message_id)
                continue
            seen.add(message.external_message_id)
        if duplicates:
            duplicate_list = ", ".join(sorted(duplicates))
            raise ValueError(f"Duplicate external_message_id values are not allowed: {duplicate_list}")
        return self


class IngestResponse(BaseModel):
    session_id: str
    category: SessionCategory | None = None
    new_message_count: int
    markdown_path: str | None = None
    processed: bool = False
