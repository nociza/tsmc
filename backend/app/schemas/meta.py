from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


AuthMode = Literal["bootstrap_local", "app_token"]


class CapabilityFeatureSet(BaseModel):
    ingest: bool = True
    search: bool = True
    graph: bool = True
    obsidian_vault: bool = True
    knowledge_graph_files: bool = True
    agent_api: bool = True
    todo_list: bool = True
    git_versioning: bool = True
    browser_proxy: bool = False
    openai_compatible_api: bool = False


class CapabilityStorage(BaseModel):
    markdown_root: str
    vault_root: str
    public_url: str | None = None


class CapabilityAuth(BaseModel):
    mode: AuthMode
    token_verify_path: str
    local_unauthenticated_access: bool
    remote_requires_token: bool = True


class CapabilityExtension(BaseModel):
    min_version: str
    auth_mode: AuthMode


class CapabilityResponse(BaseModel):
    product: str
    version: str
    api_prefix: str
    server_time: datetime
    auth: CapabilityAuth
    extension: CapabilityExtension
    features: CapabilityFeatureSet = Field(default_factory=CapabilityFeatureSet)
    storage: CapabilityStorage
