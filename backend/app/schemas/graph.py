from __future__ import annotations

from pydantic import BaseModel


class GraphNode(BaseModel):
    id: str
    label: str
    kind: str
    degree: int
    note_path: str | None = None


class GraphEdge(BaseModel):
    id: str
    source: str
    target: str
    predicate: str
    support_count: int
    session_ids: list[str]
