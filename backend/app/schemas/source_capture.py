from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from app.models.enums import SessionCategory


CaptureKind = Literal["selection", "page"]
CaptureSaveMode = Literal["raw", "ai"]


class SourceCaptureRequest(BaseModel):
    capture_kind: CaptureKind
    save_mode: CaptureSaveMode
    title: str | None = None
    page_title: str | None = None
    source_url: str | None = None
    selection_text: str | None = None
    source_text: str = Field(min_length=1)
    source_markdown: str | None = None
    raw_payload: dict[str, Any] | list[Any] | None = None


class SourceCaptureResponse(BaseModel):
    source_id: str
    title: str
    capture_kind: CaptureKind
    save_mode: CaptureSaveMode
    processed: bool
    category: SessionCategory | None = None
    markdown_path: str | None = None
    raw_source_path: str | None = None
