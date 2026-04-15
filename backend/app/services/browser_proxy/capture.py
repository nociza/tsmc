from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from typing import Any

from playwright.async_api import Page

from app.services.browser_proxy.dom import extract_response_from_dom
from app.services.browser_proxy.errors import BrowserProxyServiceError
from app.services.browser_proxy.parsers import PARSER_REGISTRY
from app.services.browser_proxy.providers import ProviderUIAdapter
from app.services.browser_proxy.types import CaptureAccumulator, CapturedBody, CapturedNetworkEvent, CapturedResponse
from app.services.browser_proxy.helpers import stable_id


def attach_response_listener(
    page: Page,
    adapter: ProviderUIAdapter,
    accumulator: CaptureAccumulator,
) -> set[asyncio.Task[Any]]:
    pending_tasks: set[asyncio.Task[Any]] = set()

    def response_listener(response) -> None:
        task = asyncio.create_task(record_response(adapter, page, accumulator, response))
        pending_tasks.add(task)
        task.add_done_callback(lambda finished: pending_tasks.discard(finished))

    page.on("response", response_listener)
    return pending_tasks


async def record_response(adapter: ProviderUIAdapter, page: Page, accumulator: CaptureAccumulator, response) -> None:
    parser = PARSER_REGISTRY[adapter.provider]
    try:
        await response.finished()
        request = response.request
        request_text = request.post_data if isinstance(request.post_data, str) else None
        request_json = None
        try:
            request_json = request.post_data_json
        except Exception:
            request_json = None

        content_type = response.headers.get("content-type")
        try:
            response_text = await response.text()
        except Exception:
            return

        response_json = None
        if content_type and "json" in content_type.lower():
            try:
                response_json = await response.json()
            except Exception:
                response_json = None

        event = CapturedNetworkEvent(
            provider_hint=adapter.provider,
            page_url=page.url,
            request_id=stable_id("req", f"{response.url}:{time.monotonic_ns()}"),
            method=request.method,
            url=response.url,
            captured_at=datetime.now(timezone.utc).isoformat(),
            request_body=CapturedBody(text=request_text, json=request_json),
            response=CapturedResponse(
                status=response.status,
                ok=response.ok,
                content_type=content_type,
                text=response_text,
                json=response_json,
            ),
        )
        if parser.matches(event):
            accumulator.events.append(event)
            accumulator.last_event_at = time.monotonic()
    except Exception:
        return


async def wait_for_reply(
    adapter: ProviderUIAdapter,
    page: Page,
    accumulator: CaptureAccumulator,
    *,
    timeout_seconds: float,
):
    parser = PARSER_REGISTRY[adapter.provider]
    deadline = time.monotonic() + timeout_seconds
    latest_snapshot = None
    latest_response_text: str | None = None
    quiet_period_seconds = 1.5

    while time.monotonic() < deadline:
        for event in accumulator.events:
            snapshot = parser.parse(event)
            if snapshot is None:
                continue
            response_text = latest_assistant_text(snapshot)
            if response_text:
                latest_snapshot = snapshot
                latest_response_text = response_text

        if latest_response_text and accumulator.last_event_at is not None and (time.monotonic() - accumulator.last_event_at) >= quiet_period_seconds:
            return latest_snapshot, latest_response_text

        await page.wait_for_timeout(250)

    dom_fallback = await extract_response_from_dom(page, adapter)
    if dom_fallback:
        return latest_snapshot, dom_fallback
    raise BrowserProxyServiceError(
        f"Timed out waiting for a {adapter.provider.value} response. The provider page may have changed or may still require login."
    )


def build_raw_capture(
    adapter: ProviderUIAdapter,
    *,
    source_url: str,
    provider_session_url: str,
    title: str | None,
    prompt_text: str,
    response_text: str,
    accumulator: CaptureAccumulator,
) -> dict[str, Any]:
    return {
        "source": "savemycontext-browser-proxy",
        "provider": adapter.provider.value,
        "model": adapter.canonical_model,
        "source_url": source_url,
        "provider_session_url": provider_session_url,
        "title": title,
        "prompt_text": prompt_text,
        "response_text": response_text,
        "matched_event_count": len(accumulator.events),
        "matched_events": [
            {
                "url": event.url,
                "method": event.method,
                "status": event.response.status,
                "captured_at": event.captured_at,
            }
            for event in accumulator.events[-10:]
        ],
    }


def latest_assistant_text(snapshot) -> str | None:
    for message in reversed(snapshot.messages):
        if message.role == "assistant" and message.content.strip():
            return message.content.strip()
    return None
