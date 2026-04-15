from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class SystemStatus(BaseModel):
    product: str
    version: str
    server_time: datetime
    markdown_root: str
    vault_root: str
    todo_list_path: str
    public_url: str | None = None
    auth_mode: str
    git_versioning_enabled: bool
    git_available: bool
    total_sessions: int
    total_messages: int
    total_triplets: int
