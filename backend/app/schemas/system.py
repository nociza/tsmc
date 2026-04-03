from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class SystemStatus(BaseModel):
    product: str
    version: str
    server_time: datetime
    markdown_root: str
    vault_root: str
    public_url: str | None = None
    auth_mode: str
    total_sessions: int
    total_messages: int
    total_triplets: int
