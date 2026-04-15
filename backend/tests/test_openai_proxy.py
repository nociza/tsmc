from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import selectinload

from app.core.config import get_settings
from app.models import ChatSession, ProviderName
from app.models.base import Base
from app.schemas.openai_proxy import ChatCompletionMessage, ChatCompletionRequest
from app.services.browser_proxy.types import BrowserCompletionResult
from app.services.openai_proxy import OpenAIProxyService


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


@pytest.fixture(autouse=True)
def force_non_browser_processing(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "openai")
    get_settings.cache_clear()
    try:
        yield
    finally:
        get_settings.cache_clear()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("model", "provider", "provider_session_url", "expected_external_session_id"),
    [
        (
            "browser-chatgpt",
            ProviderName.CHATGPT,
            "https://chatgpt.com/c/chatgpt-proxy-session",
            "proxy:chatgpt:chatgpt-proxy-session",
        ),
        (
            "browser-gemini",
            ProviderName.GEMINI,
            "https://gemini.google.com/u/1/app/c_gemini-proxy-session",
            "proxy:gemini:u1__gemini-proxy-session",
        ),
        (
            "browser-grok",
            ProviderName.GROK,
            "https://grok.com/c/grok-proxy-session",
            "proxy:grok:grok-proxy-session",
        ),
    ],
)
async def test_openai_proxy_store_uses_provider_specific_proxy_session_ids(
    tmp_path,
    model: str,
    provider: ProviderName,
    provider_session_url: str,
    expected_external_session_id: str,
) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / f'{provider.value}-proxy-store.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    completion = BrowserCompletionResult(
        provider=provider,
        model=model,
        provider_session_url=provider_session_url,
        source_url=provider_session_url.rsplit("/", 1)[0],
        title=f"{provider.value.title()} Proxy Session",
        prompt_text="Explain the proxy flow.",
        response_text="The proxy goes through the provider UI.",
        raw_capture={"source": "test"},
        snapshot=None,
    )

    async with session_factory() as session:
        fake_browser = FakeBrowserProxyService([completion])
        service = OpenAIProxyService(session, fake_browser)  # type: ignore[arg-type]

        response = await service.create_chat_completion(
            ChatCompletionRequest(
                model=model,
                store=True,
                messages=[
                    ChatCompletionMessage(role="user", content="Explain the proxy flow."),
                ],
            )
        )

        stored_session = await session.scalar(select(ChatSession).where(ChatSession.id == response.savemycontext.stored_session_id))

        assert stored_session is not None
        assert stored_session.provider == provider
        assert stored_session.external_session_id == expected_external_session_id

    await engine.dispose()


@pytest.mark.asyncio
async def test_openai_proxy_store_merges_existing_proxy_transcript(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-openai-proxy.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    first_completion = BrowserCompletionResult(
        provider=ProviderName.GEMINI,
        model="browser-gemini",
        provider_session_url="https://gemini.google.com/app/c_proxy-session",
        source_url="https://gemini.google.com/app",
        title="Proxy Session",
        prompt_text="Plan a journal workflow.",
        response_text="Capture the day, summarize it, and keep action items.",
        raw_capture={"source": "test"},
        snapshot=None,
    )
    second_completion = BrowserCompletionResult(
        provider=ProviderName.GEMINI,
        model="browser-gemini",
        provider_session_url="https://gemini.google.com/app/c_proxy-session",
        source_url="https://gemini.google.com/app/c_proxy-session",
        title="Proxy Session",
        prompt_text="Add Obsidian backlinks.",
        response_text="Add wikilinks to entities and a dashboard index.",
        raw_capture={"source": "test"},
        snapshot=None,
    )

    async with session_factory() as session:
        fake_browser = FakeBrowserProxyService([first_completion, second_completion])
        service = OpenAIProxyService(session, fake_browser)  # type: ignore[arg-type]

        first_response = await service.create_chat_completion(
            ChatCompletionRequest(
                model="browser-gemini",
                store=True,
                messages=[
                    ChatCompletionMessage(role="user", content="Plan a journal workflow."),
                ],
            )
        )
        second_response = await service.create_chat_completion(
            ChatCompletionRequest(
                model="browser-gemini",
                store=True,
                savemycontext_provider_session_url="https://gemini.google.com/app/c_proxy-session",
                messages=[
                    ChatCompletionMessage(role="user", content="Add Obsidian backlinks."),
                ],
            )
        )

        stored_session = await session.scalar(
            select(ChatSession)
            .options(selectinload(ChatSession.messages))
            .where(ChatSession.id == second_response.savemycontext.stored_session_id)
        )

        assert first_response.savemycontext.stored_session_id is not None
        assert second_response.savemycontext.stored_session_id == first_response.savemycontext.stored_session_id
        assert stored_session is not None
        assert stored_session.external_session_id.startswith("proxy:gemini:")
        assert "Respond directly and quickly." in str(fake_browser.calls[0]["prompt_text"])
        assert [message.content for message in stored_session.messages] == [
            "Plan a journal workflow.",
            "Capture the day, summarize it, and keep action items.",
            "Add Obsidian backlinks.",
            "Add wikilinks to entities and a dashboard index.",
        ]
        assert str(fake_browser.calls[1]["prompt_text"]).startswith("Respond directly and quickly.")
        assert "Add Obsidian backlinks." in str(fake_browser.calls[1]["prompt_text"])

    await engine.dispose()

@pytest.mark.asyncio
async def test_openai_proxy_without_store_does_not_persist_session(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-openai-proxy-ephemeral.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    completion = BrowserCompletionResult(
        provider=ProviderName.CHATGPT,
        model="browser-chatgpt",
        provider_session_url="https://chatgpt.com/c/proxy-session",
        source_url="https://chatgpt.com/",
        title="ChatGPT",
        prompt_text="Summarize this.",
        response_text="Here is the summary.",
        raw_capture={"source": "test"},
        snapshot=None,
    )

    async with session_factory() as session:
        fake_browser = FakeBrowserProxyService([completion])
        service = OpenAIProxyService(session, fake_browser)  # type: ignore[arg-type]

        response = await service.create_chat_completion(
            ChatCompletionRequest(
                model="browser-chatgpt",
                store=False,
                messages=[
                    ChatCompletionMessage(role="system", content="Be concise."),
                    ChatCompletionMessage(role="user", content="Summarize this."),
                ],
            )
        )

        stored_sessions = (await session.execute(select(ChatSession))).scalars().all()
        assert response.savemycontext.stored_session_id is None
        assert not stored_sessions
        assert "Respond directly and quickly." in str(fake_browser.calls[0]["prompt_text"])
        assert "Conversation so far:" in str(fake_browser.calls[0]["prompt_text"])

    await engine.dispose()


@pytest.mark.asyncio
async def test_openai_proxy_requires_final_user_message(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-openai-proxy-validation.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    completion = BrowserCompletionResult(
        provider=ProviderName.GROK,
        model="browser-grok",
        provider_session_url="https://grok.com/c/proxy-session",
        source_url="https://grok.com/",
        title="Grok",
        prompt_text="ignored",
        response_text="ignored",
        raw_capture={"source": "test"},
        snapshot=None,
    )

    async with session_factory() as session:
        fake_browser = FakeBrowserProxyService([completion])
        service = OpenAIProxyService(session, fake_browser)  # type: ignore[arg-type]

        with pytest.raises(ValueError, match="final message must have role='user'"):
            await service.create_chat_completion(
                ChatCompletionRequest(
                    model="browser-grok",
                    messages=[
                        ChatCompletionMessage(role="assistant", content="I already answered."),
                    ],
                )
            )

    await engine.dispose()
