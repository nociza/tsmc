from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

from app.models.enums import ProviderName
from app.services.browser_proxy.helpers import stable_id


@dataclass(frozen=True)
class ProviderUIAdapter:
    provider: ProviderName
    canonical_model: str
    aliases: tuple[str, ...]
    start_url: str
    input_selectors: tuple[str, ...]
    send_button_selectors: tuple[str, ...]
    response_selectors: tuple[str, ...]
    thinking_toggle_patterns: tuple[str, ...] = ()

    def matches_model(self, model: str) -> bool:
        candidate = model.strip().lower()
        return candidate == self.canonical_model or candidate in self.aliases

    def proxy_session_id_for_url(self, page_url: str) -> str:
        parsed = urlparse(page_url)
        segments = [segment for segment in parsed.path.split("/") if segment]
        provider_key = self.provider.value
        def normalize(segment: str) -> str:
            if self.provider is ProviderName.GEMINI and segment.startswith("c_"):
                return segment[2:]
            return segment
        if self.provider is ProviderName.GEMINI:
            if len(segments) >= 4 and segments[0] == "u" and segments[1].isdigit() and segments[2] == "app":
                return f"proxy:{provider_key}:u{segments[1]}__{normalize(segments[3])}"
            if len(segments) >= 2 and segments[0] == "app":
                return f"proxy:{provider_key}:u0__{normalize(segments[1])}"
        if len(segments) >= 2 and segments[-2] in {"c", "chat", "conversation", "conversations", "app"}:
            return f"proxy:{provider_key}:{normalize(segments[-1])}"
        if segments:
            return f"proxy:{provider_key}:{normalize(segments[-1])}"
        return f"proxy:{provider_key}:{stable_id(provider_key, page_url)}"


PROVIDER_ADAPTERS: dict[ProviderName, ProviderUIAdapter] = {
    ProviderName.CHATGPT: ProviderUIAdapter(
        provider=ProviderName.CHATGPT,
        canonical_model="browser-chatgpt",
        aliases=("chatgpt", "chatgpt-browser", "tsmc-browser-chatgpt"),
        start_url="https://chatgpt.com/",
        input_selectors=(
            "#prompt-textarea",
            "textarea[data-id]",
            "form textarea",
            "textarea",
            "div[contenteditable='true'][role='textbox']",
        ),
        send_button_selectors=(
            "button[data-testid='send-button']",
            "button[aria-label*='Send']",
            "form button[type='submit']",
        ),
        response_selectors=(
            "article div[data-message-author-role='assistant']",
            "main article",
        ),
        thinking_toggle_patterns=("think", "reason", "research"),
    ),
    ProviderName.GEMINI: ProviderUIAdapter(
        provider=ProviderName.GEMINI,
        canonical_model="browser-gemini",
        aliases=("gemini", "gemini-browser", "tsmc-browser-gemini"),
        start_url="https://gemini.google.com/app",
        input_selectors=(
            "rich-textarea textarea",
            "div[contenteditable='true'][role='textbox']",
            "div.ql-editor[contenteditable='true']",
            "textarea",
        ),
        send_button_selectors=(
            "button[aria-label*='Send']",
            "button[aria-label*='Run']",
            "button[mattooltip*='Send']",
            "form button[type='submit']",
        ),
        response_selectors=(
            "message-content",
            "article model-response",
            "main article",
        ),
        thinking_toggle_patterns=("thinking", "reason", "research"),
    ),
    ProviderName.GROK: ProviderUIAdapter(
        provider=ProviderName.GROK,
        canonical_model="browser-grok",
        aliases=("grok", "grok-browser", "tsmc-browser-grok"),
        start_url="https://grok.com/",
        input_selectors=(
            "textarea",
            "div[contenteditable='true'][role='textbox']",
            "div[contenteditable='true']",
        ),
        send_button_selectors=(
            "button[aria-label*='Send']",
            "button[data-testid*='send']",
            "form button[type='submit']",
        ),
        response_selectors=(
            "article",
            "main article",
            "[data-testid*='message']",
        ),
        thinking_toggle_patterns=("think", "reason", "research", "deep search"),
    ),
}


def resolve_provider_adapter(model: str) -> ProviderUIAdapter:
    for adapter in PROVIDER_ADAPTERS.values():
        if adapter.matches_model(model):
            return adapter
    available = ", ".join(sorted(adapter.canonical_model for adapter in PROVIDER_ADAPTERS.values()))
    raise ValueError(f"Unsupported model '{model}'. Use one of: {available}.")


def openai_model_descriptors(created_at: int) -> list[dict[str, Any]]:
    return [
        {
            "id": adapter.canonical_model,
            "object": "model",
            "created": created_at,
            "owned_by": "tsmc",
        }
        for adapter in PROVIDER_ADAPTERS.values()
    ]
