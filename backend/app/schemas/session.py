from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.models.enums import MessageRole, ProviderName, SessionCategory
from app.services.user_categories import RESERVED_CATEGORY_NAMES, extract_user_categories, normalize_user_category_name, visible_custom_tags


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
    pile_slug: str | None = None
    is_discarded: bool = False
    discarded_reason: str | None = None
    custom_tags: list[str] = Field(default_factory=list)
    user_categories: list[str] = Field(default_factory=list)
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
    pile_outputs: dict[str, Any] | None = None
    created_at: datetime
    messages: list[MessageRead]
    triplets: list[TripletRead]


class SessionUserCategoriesUpdate(BaseModel):
    user_categories: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def normalize_categories(self) -> "SessionUserCategoriesUpdate":
        normalized: dict[str, str] = {}
        for raw in self.user_categories:
            cleaned = normalize_user_category_name(raw)
            if not cleaned:
                continue
            if cleaned.casefold() in RESERVED_CATEGORY_NAMES:
                raise ValueError(f"'{cleaned}' is reserved for the default system categories.")
            normalized[cleaned.casefold()] = cleaned
        self.user_categories = sorted(normalized.values(), key=str.casefold)
        return self


class UserCategorySummary(BaseModel):
    name: str
    count: int


def build_session_list_item(session) -> SessionListItem:  # type: ignore[no-untyped-def]
    return SessionListItem(
        id=session.id,
        provider=session.provider,
        external_session_id=session.external_session_id,
        title=session.title,
        category=session.category,
        pile_slug=session.pile.slug if session.pile else None,
        is_discarded=session.is_discarded,
        discarded_reason=session.discarded_reason,
        custom_tags=visible_custom_tags(session.custom_tags),
        user_categories=extract_user_categories(session.custom_tags),
        markdown_path=session.markdown_path,
        share_post=session.share_post,
        updated_at=session.updated_at,
        last_captured_at=session.last_captured_at,
        last_processed_at=session.last_processed_at,
    )


def build_session_read(session) -> SessionRead:  # type: ignore[no-untyped-def]
    return SessionRead(
        **build_session_list_item(session).model_dump(),
        source_url=session.source_url,
        classification_reason=session.classification_reason,
        journal_entry=session.journal_entry,
        todo_summary=session.todo_summary,
        idea_summary=session.idea_summary,
        pile_outputs=session.pile_outputs,
        created_at=session.created_at,
        messages=[MessageRead.model_validate(message) for message in session.messages],
        triplets=[TripletRead.model_validate(triplet) for triplet in session.triplets],
    )
