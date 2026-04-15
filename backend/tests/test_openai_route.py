from __future__ import annotations

from httpx import ASGITransport, AsyncClient
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.routes_openai import router as openai_router
from app.core.config import get_settings
from app.db.session import get_db_session
from app.models import ProviderName
from app.models.base import Base
from app.services.browser_proxy.providers import resolve_provider_adapter
from app.services.browser_proxy.types import BrowserCompletionResult


class FakeBrowserProxyService:
    async def complete(self, *, model: str, prompt_text: str, provider_session_url: str | None = None) -> BrowserCompletionResult:
        adapter = resolve_provider_adapter(model)
        return BrowserCompletionResult(
            provider=adapter.provider,
            model=model,
            provider_session_url=provider_session_url or adapter.start_url,
            source_url=adapter.start_url,
            title="Test Session",
            prompt_text=prompt_text,
            response_text="Proxy reply from the fake browser service.",
            raw_capture={"source": "test"},
            snapshot=None,
        )


@pytest.mark.asyncio
async def test_openai_compatible_models_route_is_disabled_by_default(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-openai-models-route-disabled.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    get_settings.cache_clear()
    app = FastAPI()
    app.include_router(openai_router, prefix="/v1")

    async def override_db_session():
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_db_session] = override_db_session

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:18888") as client:
        response = await client.get("/v1/models")

    assert response.status_code == 503
    assert "Experimental browser automation is disabled" in response.text

    await engine.dispose()


@pytest.mark.asyncio
async def test_openai_compatible_models_route_lists_all_supported_models(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-openai-models-route.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_EXPERIMENTAL_BROWSER_AUTOMATION", "true")
    get_settings.cache_clear()
    app = FastAPI()
    app.include_router(openai_router, prefix="/v1")
    app.state.browser_proxy_service = FakeBrowserProxyService()

    async def override_db_session():
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_db_session] = override_db_session

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:18888") as client:
        response = await client.get("/v1/models")

    assert response.status_code == 200
    payload = response.json()
    assert payload["object"] == "list"
    assert {item["id"] for item in payload["data"]} == {
        "browser-chatgpt",
        "browser-gemini",
        "browser-grok",
    }

    await engine.dispose()
    get_settings.cache_clear()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("model", "expected_provider"),
    [
        ("browser-chatgpt", "chatgpt"),
        ("browser-gemini", "gemini"),
        ("browser-grok", "grok"),
    ],
)
async def test_openai_compatible_route_returns_chat_completion_shape(
    tmp_path,
    model: str,
    expected_provider: str,
    monkeypatch,
) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-openai-route.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_EXPERIMENTAL_BROWSER_AUTOMATION", "true")
    get_settings.cache_clear()
    app = FastAPI()
    app.include_router(openai_router, prefix="/v1")
    app.state.browser_proxy_service = FakeBrowserProxyService()

    async def override_db_session():
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_db_session] = override_db_session

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:18888") as client:
        response = await client.post(
            "/v1/chat/completions",
            json={
                "model": model,
                "messages": [
                    {"role": "user", "content": "Summarize the deployment plan."}
                ],
                "store": False,
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["object"] == "chat.completion"
    assert payload["choices"][0]["message"]["role"] == "assistant"
    assert payload["choices"][0]["message"]["content"] == "Proxy reply from the fake browser service."
    assert payload["savemycontext"]["provider"] == expected_provider
    assert payload["savemycontext"]["store"] is False

    await engine.dispose()
    get_settings.cache_clear()
