from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from app.models.enums import ProviderName


MessageRole = Literal["system", "user", "assistant", "tool", "unknown"]


@dataclass(frozen=True)
class CapturedBody:
    text: str | None = None
    json: Any | None = None


@dataclass(frozen=True)
class CapturedResponse:
    status: int
    ok: bool
    content_type: str | None
    text: str
    json: Any | None = None


@dataclass(frozen=True)
class CapturedNetworkEvent:
    provider_hint: ProviderName | None
    page_url: str
    request_id: str
    method: str
    url: str
    captured_at: str
    request_body: CapturedBody | None
    response: CapturedResponse
    capture_mode: Literal["incremental", "full_snapshot"] = "incremental"


@dataclass(frozen=True)
class NormalizedMessage:
    id: str
    role: MessageRole
    content: str
    parent_id: str | None = None
    occurred_at: str | None = None
    raw: Any | None = None


@dataclass(frozen=True)
class NormalizedSessionSnapshot:
    provider: ProviderName
    external_session_id: str
    title: str | None
    source_url: str
    captured_at: str
    messages: list[NormalizedMessage]


@dataclass(frozen=True)
class BrowserCompletionResult:
    provider: ProviderName
    model: str
    provider_session_url: str
    source_url: str
    title: str | None
    prompt_text: str
    response_text: str
    raw_capture: dict[str, Any]
    snapshot: NormalizedSessionSnapshot | None = None


@dataclass
class CaptureAccumulator:
    events: list[CapturedNetworkEvent] = field(default_factory=list)
    last_event_at: float | None = None
