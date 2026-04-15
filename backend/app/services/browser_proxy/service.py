from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from playwright.async_api import BrowserContext, Page, Playwright, async_playwright

from app.core.config import Settings, get_settings
from app.models.enums import ProviderName
from app.services.browser_proxy.capture import attach_response_listener, build_raw_capture, wait_for_reply
from app.services.browser_proxy.dom import page_title, send_prompt, wait_for_input
from app.services.browser_proxy.errors import BrowserProxyServiceError
from app.services.browser_proxy.providers import PROVIDER_ADAPTERS, ProviderUIAdapter, resolve_provider_adapter
from app.services.browser_proxy.types import BrowserCompletionResult, CaptureAccumulator


@dataclass
class BrowserLoginHandle:
    context: BrowserContext
    page: Page
    provider: ProviderName
    profile_dir: Path
    start_url: str


class BrowserProxyService:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self._playwright: Playwright | None = None
        self._playwright_manager = None
        self._locks = {provider: asyncio.Lock() for provider in PROVIDER_ADAPTERS}

    async def start(self) -> None:
        if self._playwright is not None:
            return
        self._playwright_manager = async_playwright()
        self._playwright = await self._playwright_manager.start()

    async def close(self) -> None:
        if self._playwright_manager is not None:
            await self._playwright_manager.stop()
        self._playwright = None
        self._playwright_manager = None

    async def open_login_browser(self, provider: ProviderName) -> BrowserLoginHandle:
        await self.start()
        adapter = PROVIDER_ADAPTERS[provider]
        context = await self._launch_context(adapter, headless=False)
        page = context.pages[0] if context.pages else await context.new_page()
        await page.goto(adapter.start_url, wait_until="domcontentloaded", timeout=self._timeout_ms)
        return BrowserLoginHandle(
            context=context,
            page=page,
            provider=provider,
            profile_dir=self._profile_dir(adapter.provider),
            start_url=adapter.start_url,
        )

    async def complete(
        self,
        *,
        model: str,
        prompt_text: str,
        provider_session_url: str | None = None,
    ) -> BrowserCompletionResult:
        adapter = resolve_provider_adapter(model)
        prompt_text = prompt_text.strip()
        if not prompt_text:
            raise BrowserProxyServiceError("The browser proxy prompt is empty.")

        await self.start()
        lock = self._locks[adapter.provider]
        async with lock:
            context = await self._launch_context(adapter, headless=self.settings.browser_headless)
            try:
                page = context.pages[0] if context.pages else await context.new_page()
                accumulator = CaptureAccumulator()
                pending_tasks = attach_response_listener(page, adapter, accumulator)

                target_url = provider_session_url or adapter.start_url
                await page.goto(target_url, wait_until="domcontentloaded", timeout=self._timeout_ms)
                await wait_for_input(page, adapter, timeout_seconds=self.settings.browser_timeout_seconds)
                await send_prompt(page, adapter, prompt_text, prefer_fast_mode=True)
                snapshot, response_text = await wait_for_reply(
                    adapter,
                    page,
                    accumulator,
                    timeout_seconds=self.settings.browser_timeout_seconds,
                )
                if pending_tasks:
                    await asyncio.gather(*pending_tasks, return_exceptions=True)

                final_url = page.url or target_url
                title = await page_title(page)
                raw_capture = build_raw_capture(
                    adapter,
                    source_url=target_url,
                    provider_session_url=final_url,
                    title=title,
                    prompt_text=prompt_text,
                    response_text=response_text,
                    accumulator=accumulator,
                )

                return BrowserCompletionResult(
                    provider=adapter.provider,
                    model=adapter.canonical_model,
                    provider_session_url=final_url,
                    source_url=target_url,
                    title=title,
                    prompt_text=prompt_text,
                    response_text=response_text,
                    raw_capture=raw_capture,
                    snapshot=snapshot,
                )
            finally:
                await context.close()

    async def _launch_context(self, adapter: ProviderUIAdapter, *, headless: bool) -> BrowserContext:
        if self._playwright is None:
            raise BrowserProxyServiceError("Playwright is not initialized.")

        profile_dir = self._profile_dir(adapter.provider)
        profile_dir.mkdir(parents=True, exist_ok=True)
        launch_kwargs: dict[str, Any] = {
            "user_data_dir": str(profile_dir),
            "headless": headless,
            "args": [
                "--disable-blink-features=AutomationControlled",
            ],
        }
        if self.settings.browser_channel:
            launch_kwargs["channel"] = self.settings.browser_channel
        if self.settings.browser_executable_path:
            launch_kwargs["executable_path"] = self.settings.browser_executable_path

        try:
            return await self._playwright.chromium.launch_persistent_context(**launch_kwargs)
        except Exception as exc:  # pragma: no cover - surfaced by runtime environment
            raise BrowserProxyServiceError(
                "Unable to launch the managed browser. Run 'savemycontext browser install' and 'savemycontext browser login --provider ...' first."
            ) from exc

    def _profile_dir(self, provider: ProviderName) -> Path:
        return self.settings.resolved_browser_profile_dir / provider.value

    @property
    def _timeout_ms(self) -> int:
        return int(self.settings.browser_timeout_seconds * 1000)
