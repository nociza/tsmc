from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class TokenVerifyResponse(BaseModel):
    valid: bool
    token_name: str | None = None
    scopes: list[str] = Field(default_factory=list)
    username: str | None = None


class APITokenRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    token_prefix: str
    scopes: list[str]
    is_active: bool
    last_used_at: datetime | None
    revoked_at: datetime | None
    created_at: datetime
    updated_at: datetime


class UserRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    username: str
    is_admin: bool
    is_active: bool
    created_at: datetime
    updated_at: datetime
