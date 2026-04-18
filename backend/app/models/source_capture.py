from __future__ import annotations

from typing import Any
from uuid import uuid4

from sqlalchemy import Boolean, ForeignKey, JSON, String, Text
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin
from app.models.enums import SessionCategory


class SourceCapture(TimestampMixin, Base):
    __tablename__ = "source_captures"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    capture_kind: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    save_mode: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    title: Mapped[str | None] = mapped_column(Text)
    source_url: Mapped[str | None] = mapped_column(Text)
    page_title: Mapped[str | None] = mapped_column(Text)
    selection_text: Mapped[str | None] = mapped_column(Text)
    source_text: Mapped[str] = mapped_column(Text, nullable=False)
    source_markdown: Mapped[str | None] = mapped_column(Text)
    cleaned_markdown: Mapped[str | None] = mapped_column(Text)
    summary: Mapped[str | None] = mapped_column(Text)
    classification_reason: Mapped[str | None] = mapped_column(Text)
    category: Mapped[SessionCategory | None] = mapped_column(
        SAEnum(SessionCategory, native_enum=False),
        index=True,
    )
    pile_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("piles.id", ondelete="SET NULL"),
        index=True,
    )
    is_discarded: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)
    markdown_path: Mapped[str | None] = mapped_column(Text)
    raw_source_path: Mapped[str | None] = mapped_column(Text)
    raw_payload: Mapped[dict[str, Any] | list[Any] | None] = mapped_column(JSON)

    pile = relationship("Pile", lazy="joined")
