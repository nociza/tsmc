from __future__ import annotations

from pydantic import BaseModel

from app.models.enums import SessionCategory, ProviderName


class SearchResult(BaseModel):
    kind: str
    title: str
    snippet: str
    session_id: str | None = None
    source_id: str | None = None
    entity_id: str | None = None
    category: SessionCategory | None = None
    provider: ProviderName | None = None
    markdown_path: str | None = None


class SearchResponse(BaseModel):
    query: str
    count: int
    results: list[SearchResult]
