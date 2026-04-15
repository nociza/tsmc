from __future__ import annotations

from pydantic import BaseModel


class TodoListRead(BaseModel):
    title: str
    markdown_path: str
    content: str
    git_versioning_enabled: bool
    git_available: bool
