from __future__ import annotations

from pathlib import Path

import pytest

from app.core.config import Settings
from app.models import ProviderName
from app.schemas.processing import ClassificationResult, JournalResult
from app.services.browser_proxy.types import BrowserCompletionResult
from app.services.llm.browser_proxy_client import BrowserProxyClient


class FakeBrowserProxyService:
    def __init__(self, responses: list[BrowserCompletionResult]) -> None:
        self.responses = list(responses)
        self.calls: list[dict[str, str | None]] = []

    async def complete(self, *, model: str, prompt_text: str, provider_session_url: str | None = None) -> BrowserCompletionResult:
        self.calls.append(
            {
                "model": model,
                "prompt_text": prompt_text,
                "provider_session_url": provider_session_url,
            }
        )
        return self.responses.pop(0)


def make_completion(response_text: str, provider_session_url: str) -> BrowserCompletionResult:
    return BrowserCompletionResult(
        provider=ProviderName.GEMINI,
        model="browser-gemini",
        provider_session_url=provider_session_url,
        source_url="https://gemini.google.com/app",
        title="TSMC Processing",
        prompt_text="ignored",
        response_text=response_text,
        raw_capture={"source": "test"},
        snapshot=None,
    )


@pytest.mark.asyncio
async def test_browser_proxy_llm_client_reuses_dedicated_session_state(tmp_path: Path) -> None:
    state_path = tmp_path / "browser-llm-state.json"
    fake_browser = FakeBrowserProxyService(
        [
            make_completion(
                '{"category":"journal","reason":"Personal planning and reflection."}',
                "https://gemini.google.com/app/c_processing-thread",
            ),
            make_completion(
                '{"entry":"Captured the user context.","action_items":["Review the plan"]}',
                "https://gemini.google.com/app/c_processing-thread",
            ),
        ]
    )
    settings = Settings(
        browser_llm_model="browser-gemini",
        browser_llm_state_path=state_path,
    )
    client = BrowserProxyClient(fake_browser, settings=settings)  # type: ignore[arg-type]

    classification = await client.generate_json(
        system_prompt="Return category and reason.",
        user_prompt="USER: Plan tomorrow and reflect on today.",
        schema=ClassificationResult,
    )
    journal = await client.generate_json(
        system_prompt="Return entry and action_items.",
        user_prompt="USER: Plan tomorrow and reflect on today.",
        schema=JournalResult,
    )

    assert classification.category.value == "journal"
    assert journal.entry == "Captured the user context."
    assert fake_browser.calls[0]["provider_session_url"] is None
    assert fake_browser.calls[1]["provider_session_url"] == "https://gemini.google.com/app/c_processing-thread"
    assert "Use fast mode." in str(fake_browser.calls[0]["prompt_text"])
    assert "Use fast mode." in str(fake_browser.calls[1]["prompt_text"])
    assert state_path.exists()
    assert "c_processing-thread" in state_path.read_text(encoding="utf-8")
