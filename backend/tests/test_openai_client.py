from __future__ import annotations

from typing import Any

import httpx
import pytest
from pydantic import BaseModel

from app.core.config import get_settings
from app.services.llm.openai_client import OpenAIClient


class EchoSchema(BaseModel):
    value: str


@pytest.mark.asyncio
async def test_openai_client_uses_openai_compatible_settings_and_headers(monkeypatch) -> None:
    captured: dict[str, Any] = {}

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, object]:
            return {
                "choices": [
                    {
                        "message": {
                            "content": '{"value":"ok"}',
                        }
                    }
                ]
            }

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs) -> None:
            captured["timeout"] = kwargs.get("timeout")

        async def __aenter__(self) -> "FakeAsyncClient":
            return self

        async def __aexit__(self, exc_type, exc, tb) -> bool:
            return False

        async def post(self, url: str, *, headers: dict[str, str], json: dict[str, object]) -> FakeResponse:
            captured["url"] = url
            captured["headers"] = headers
            captured["json"] = json
            return FakeResponse()

    monkeypatch.setenv("TSMC_OPENAI_COMPATIBLE_API_KEY", "openrouter-secret")
    monkeypatch.setenv("TSMC_OPENAI_COMPATIBLE_BASE_URL", "https://openrouter.ai/api/v1")
    monkeypatch.setenv("TSMC_OPENAI_COMPATIBLE_MODEL", "openai/gpt-4.1-mini")
    monkeypatch.setenv("TSMC_OPENAI_COMPATIBLE_SITE_URL", "https://notes.example.com")
    monkeypatch.setenv("TSMC_OPENAI_COMPATIBLE_APP_NAME", "TSMC Test")
    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)
    get_settings.cache_clear()

    try:
        client = OpenAIClient()
        result = await client.generate_json(
            system_prompt="Return JSON.",
            user_prompt="Say ok.",
            schema=EchoSchema,
        )

        assert result.value == "ok"
        assert captured["url"] == "https://openrouter.ai/api/v1/chat/completions"
        assert captured["headers"]["Authorization"] == "Bearer openrouter-secret"
        assert captured["headers"]["X-Title"] == "TSMC Test"
        assert captured["headers"]["HTTP-Referer"] == "https://notes.example.com"
        assert captured["json"]["model"] == "openai/gpt-4.1-mini"
        assert captured["json"]["response_format"] == {"type": "json_object"}
    finally:
        get_settings.cache_clear()


@pytest.mark.asyncio
async def test_openai_client_accepts_generic_openai_env_names_and_openrouter_defaults(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-or-v1-test-secret")
    get_settings.cache_clear()

    try:
        settings = get_settings()
        client = OpenAIClient()

        assert settings.openai_api_key == "sk-or-v1-test-secret"
        assert settings.resolved_openai_base_url == "https://openrouter.ai/api/v1"
        assert settings.resolved_openai_model == "openai/gpt-4.1-mini"
        assert client.base_url == "https://openrouter.ai/api/v1"
        assert client.model == "openai/gpt-4.1-mini"
    finally:
        get_settings.cache_clear()


@pytest.mark.asyncio
async def test_openai_client_retries_without_response_format_when_provider_rejects_json_mode(monkeypatch) -> None:
    attempts: list[dict[str, object]] = []

    request = httpx.Request("POST", "https://openrouter.ai/api/v1/chat/completions")

    class FakeResponse:
        def __init__(self, payload: dict[str, object]) -> None:
            self._payload = payload

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, object]:
            return self._payload

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs) -> None:
            return None

        async def __aenter__(self) -> "FakeAsyncClient":
            return self

        async def __aexit__(self, exc_type, exc, tb) -> bool:
            return False

        async def post(self, url: str, *, headers: dict[str, str], json: dict[str, object]):
            attempts.append(json)
            if len(attempts) == 1:
                response = httpx.Response(
                    status_code=400,
                    request=request,
                    text='{"error":{"message":"response_format is not supported"}}',
                )
                raise httpx.HTTPStatusError("unsupported", request=request, response=response)
            return FakeResponse({"choices": [{"message": {"content": '{"value":"ok"}'}}]})

    monkeypatch.setenv("TSMC_OPENAI_COMPATIBLE_API_KEY", "openrouter-secret")
    monkeypatch.setenv("TSMC_OPENAI_COMPATIBLE_BASE_URL", "https://openrouter.ai/api/v1")
    monkeypatch.setenv("TSMC_OPENAI_COMPATIBLE_MODEL", "openai/gpt-4.1-mini")
    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)
    get_settings.cache_clear()

    try:
        client = OpenAIClient()
        result = await client.generate_json(
            system_prompt="Return JSON.",
            user_prompt="Say ok.",
            schema=EchoSchema,
        )

        assert result.value == "ok"
        assert attempts[0]["response_format"] == {"type": "json_object"}
        assert "response_format" not in attempts[1]
    finally:
        get_settings.cache_clear()
