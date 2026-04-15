from __future__ import annotations

import time
from typing import Any

from playwright.async_api import Locator, Page

from app.services.browser_proxy.errors import BrowserProxyServiceError
from app.services.browser_proxy.helpers import normalize_whitespace, pick_likely_text
from app.services.browser_proxy.providers import ProviderUIAdapter


async def wait_for_input(page: Page, adapter: ProviderUIAdapter, *, timeout_seconds: float) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if await locate_visible_input(page, adapter) is not None:
            return
        await page.wait_for_timeout(250)
    raise BrowserProxyServiceError(
        f"Could not find the {adapter.provider.value} prompt input. Log in first with 'savemycontext browser login --provider {adapter.provider.value}'."
    )


async def locate_visible_input(page: Page, adapter: ProviderUIAdapter) -> Locator | None:
    return await locate_first_visible(page, adapter.input_selectors)


async def click_send_button(page: Page, adapter: ProviderUIAdapter) -> bool:
    candidate = await locate_first_clickable(page, adapter.send_button_selectors)
    if candidate is None:
        return False
    await candidate.click()
    return True


async def disable_thinking_mode(page: Page, adapter: ProviderUIAdapter) -> None:
    if not adapter.thinking_toggle_patterns:
        return

    patterns = list(adapter.thinking_toggle_patterns)
    await page.evaluate(
        """(needlePatterns) => {
            const isVisible = (node) => {
              const style = window.getComputedStyle(node);
              const rect = node.getBoundingClientRect();
              return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
            };
            const isActive = (node) =>
              node.getAttribute("aria-pressed") === "true" ||
              node.getAttribute("aria-checked") === "true" ||
              node.getAttribute("data-state") === "on" ||
              node.getAttribute("data-selected") === "true";
            const nodes = document.querySelectorAll("button,[role='button'],[aria-pressed],[aria-checked]");
            for (const node of nodes) {
              if (!(node instanceof HTMLElement)) continue;
              if (!isVisible(node) || node.matches(":disabled,[aria-disabled='true']") || !isActive(node)) continue;
              const label = [node.getAttribute("aria-label"), node.getAttribute("title"), node.textContent || ""]
                .filter(Boolean)
                .join(" ")
                .trim()
                .toLowerCase();
              if (!label) continue;
              if (!needlePatterns.some((needle) => label.includes(needle))) continue;
              node.click();
              return;
            }
        }""",
        patterns,
    )


async def send_prompt(page: Page, adapter: ProviderUIAdapter, prompt_text: str, *, prefer_fast_mode: bool = False) -> None:
    input_locator = await locate_visible_input(page, adapter)
    if input_locator is None:
        raise BrowserProxyServiceError(f"No writable prompt input was found for {adapter.provider.value}.")

    if prefer_fast_mode:
        await disable_thinking_mode(page, adapter)

    await input_locator.click()
    tag_name = await input_locator.evaluate("(node) => node.tagName.toLowerCase()")
    is_editable = await input_locator.evaluate("(node) => !!node.isContentEditable")
    if tag_name in {"textarea", "input"}:
        await input_locator.fill("")
        await input_locator.fill(prompt_text)
    elif is_editable:
        await input_locator.evaluate(
            """(node, value) => {
                node.focus();
                node.textContent = "";
                const textNode = document.createTextNode(value);
                node.appendChild(textNode);
                node.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: value, inputType: "insertText" }));
                node.dispatchEvent(new Event("change", { bubbles: true }));
            }""",
            prompt_text,
        )
    else:
        await input_locator.fill(prompt_text)

    if await click_send_button(page, adapter):
        return
    await page.keyboard.press("Enter")


async def extract_response_from_dom(page: Page, adapter: ProviderUIAdapter) -> str | None:
    values = await page.evaluate(
        """(selectors) => {
            const isVisible = (node) => {
              const style = window.getComputedStyle(node);
              const rect = node.getBoundingClientRect();
              return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
            };
            const results = [];
            for (const selector of selectors) {
              for (const node of document.querySelectorAll(selector)) {
                if (!isVisible(node)) continue;
                const text = (node.innerText || node.textContent || "").trim();
                if (text) results.push(text);
              }
            }
            return results;
        }""",
        list(adapter.response_selectors),
    )
    if not isinstance(values, list):
        return None
    return pick_likely_text(
        [normalize_whitespace(value) for value in values if isinstance(value, str)],
        prefer_last=True,
    )


async def page_title(page: Page) -> str | None:
    title = await page.title()
    title = title.strip()
    return title or None


async def locate_first_visible(page: Page, selectors: tuple[str, ...]) -> Locator | None:
    for selector in selectors:
        locator = page.locator(selector)
        count = await locator.count()
        for index in range(count):
            candidate = locator.nth(index)
            try:
                if await candidate.is_visible():
                    return candidate
            except Exception:
                continue
    return None


async def locate_first_clickable(page: Page, selectors: tuple[str, ...]) -> Locator | None:
    for selector in selectors:
        locator = page.locator(selector)
        count = await locator.count()
        for index in range(count):
            candidate = locator.nth(index)
            try:
                if not await candidate.is_visible():
                    continue
                if await candidate.is_disabled():
                    continue
                return candidate
            except Exception:
                continue
    return None
