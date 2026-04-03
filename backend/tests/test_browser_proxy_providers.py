from __future__ import annotations

import pytest

from app.models import ProviderName
from app.services.browser_proxy.providers import openai_model_descriptors, resolve_provider_adapter


@pytest.mark.parametrize(
    ("model", "provider"),
    [
        ("browser-chatgpt", ProviderName.CHATGPT),
        ("chatgpt", ProviderName.CHATGPT),
        ("browser-gemini", ProviderName.GEMINI),
        ("gemini", ProviderName.GEMINI),
        ("browser-grok", ProviderName.GROK),
        ("grok", ProviderName.GROK),
    ],
)
def test_resolve_provider_adapter_supports_all_provider_aliases(model: str, provider: ProviderName) -> None:
    adapter = resolve_provider_adapter(model)
    assert adapter.provider == provider


@pytest.mark.parametrize(
    ("model", "page_url", "expected_session_id"),
    [
        ("browser-chatgpt", "https://chatgpt.com/c/abc123", "proxy:chatgpt:abc123"),
        ("browser-gemini", "https://gemini.google.com/app/c_abc123", "proxy:gemini:u0__abc123"),
        ("browser-gemini", "https://gemini.google.com/u/2/app/c_xyz789", "proxy:gemini:u2__xyz789"),
        ("browser-grok", "https://grok.com/c/grok-session", "proxy:grok:grok-session"),
    ],
)
def test_proxy_session_ids_are_provider_specific(model: str, page_url: str, expected_session_id: str) -> None:
    adapter = resolve_provider_adapter(model)
    assert adapter.proxy_session_id_for_url(page_url) == expected_session_id


def test_openai_model_descriptors_expose_all_browser_models() -> None:
    descriptors = openai_model_descriptors(created_at=1234567890)
    assert {descriptor["id"] for descriptor in descriptors} == {
        "browser-chatgpt",
        "browser-gemini",
        "browser-grok",
    }
