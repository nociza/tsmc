from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import DateTime, JSON, String, Text, UniqueConstraint
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin
from app.models.enums import ProviderName, SessionCategory


class ChatSession(TimestampMixin, Base):
    __tablename__ = "chat_sessions"
    __table_args__ = (
        UniqueConstraint(
            "provider",
            "external_session_id",
            name="uq_chat_session_provider_external_id",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    provider: Mapped[ProviderName] = mapped_column(
        SAEnum(ProviderName, native_enum=False),
        nullable=False,
        index=True,
    )
    external_session_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    title: Mapped[str | None] = mapped_column(Text)
    source_url: Mapped[str | None] = mapped_column(Text)
    markdown_path: Mapped[str | None] = mapped_column(Text)
    category: Mapped[SessionCategory | None] = mapped_column(
        SAEnum(SessionCategory, native_enum=False),
        index=True,
    )
    custom_tags: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    classification_reason: Mapped[str | None] = mapped_column(Text)
    journal_entry: Mapped[str | None] = mapped_column(Text)
    todo_summary: Mapped[str | None] = mapped_column(Text)
    idea_summary: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    share_post: Mapped[str | None] = mapped_column(Text)
    last_captured_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    last_processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)

    messages = relationship(
        "ChatMessage",
        back_populates="session",
        cascade="all, delete-orphan",
        order_by="ChatMessage.sequence_index",
    )
    triplets = relationship(
        "FactTriplet",
        back_populates="session",
        cascade="all, delete-orphan",
    )
    sync_events = relationship(
        "SyncEvent",
        back_populates="session",
        cascade="all, delete-orphan",
    )
