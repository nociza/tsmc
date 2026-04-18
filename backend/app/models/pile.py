from __future__ import annotations

from typing import Any
from uuid import uuid4

from sqlalchemy import Boolean, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin
from app.models.enums import PileKind


class Pile(TimestampMixin, Base):
    __tablename__ = "piles"
    __table_args__ = (UniqueConstraint("slug", name="uq_pile_slug"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    slug: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    kind: Mapped[PileKind] = mapped_column(
        SAEnum(PileKind, native_enum=False),
        nullable=False,
        index=True,
    )
    folder_label: Mapped[str] = mapped_column(String(64), nullable=False)
    attributes: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    pipeline_config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_visible_on_dashboard: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
