from __future__ import annotations

from uuid import uuid4

from sqlalchemy import String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class PromptTemplate(TimestampMixin, Base):
    __tablename__ = "prompt_templates"
    __table_args__ = (UniqueConstraint("key", name="uq_prompt_template_key"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    key: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    system_prompt: Mapped[str] = mapped_column(Text, nullable=False)
    user_prompt: Mapped[str] = mapped_column(Text, nullable=False)
