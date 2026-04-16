from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel

from app.models.enums import ProviderName, SessionCategory
from app.schemas.session import SessionRead


class LabelCount(BaseModel):
    label: str
    count: int


class ProviderCount(BaseModel):
    provider: ProviderName
    count: int


class ActivityBucket(BaseModel):
    bucket: str
    count: int


class CategoryStats(BaseModel):
    category: SessionCategory
    total_sessions: int
    total_messages: int
    total_triplets: int
    latest_updated_at: datetime | None
    avg_messages_per_session: float
    avg_triplets_per_session: float
    notes_with_share_post: int
    notes_with_idea_summary: int
    notes_with_journal_entry: int
    notes_with_todo_summary: int
    provider_counts: list[ProviderCount]
    activity: list[ActivityBucket]
    top_tags: list[LabelCount]
    top_entities: list[LabelCount]
    top_predicates: list[LabelCount]


class ExplorerGraphNode(BaseModel):
    id: str
    label: str
    kind: str
    size: int
    session_ids: list[str]
    provider: ProviderName | None = None
    category: SessionCategory | None = None
    updated_at: datetime | None = None
    note_path: str | None = None


class ExplorerGraphEdge(BaseModel):
    id: str
    source: str
    target: str
    label: str | None = None
    weight: int
    session_ids: list[str]


class CategoryGraph(BaseModel):
    category: SessionCategory
    node_count: int
    edge_count: int
    nodes: list[ExplorerGraphNode]
    edges: list[ExplorerGraphEdge]


class SessionNoteRead(SessionRead):
    raw_markdown: str | None = None
    related_entities: list[str]
    word_count: int
