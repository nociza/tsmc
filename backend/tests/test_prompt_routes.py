from __future__ import annotations

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.routes_prompts import router as prompts_router
from app.db.session import get_db_session
from app.models import MessageRole, PromptTemplate
from app.models.base import Base
from app.schemas.processing import JournalResult
from app.services.orchestrator import ProcessingOrchestrator


class StubMessage:
    def __init__(self, role: MessageRole, content: str) -> None:
        self.role = role
        self.content = content


@pytest.mark.asyncio
async def test_prompt_template_routes_list_and_update_override(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-prompts.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    app = FastAPI()
    app.include_router(prompts_router, prefix="/api/v1")

    async def override_db_session():
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_db_session] = override_db_session

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:18888") as client:
        list_response = await client.get("/api/v1/prompts/templates")
        assert list_response.status_code == 200
        templates = list_response.json()
        assert any(template["key"] == "processing.journal" and template["has_override"] is False for template in templates)

        update_response = await client.put(
            "/api/v1/prompts/templates/processing.journal",
            json={
                "system_prompt": "Journal override system",
                "user_prompt": "Journal override user {{transcript}}{{pile_addendum_block}}",
            },
        )
        assert update_response.status_code == 200
        updated = update_response.json()
        assert updated["key"] == "processing.journal"
        assert updated["has_override"] is True
        assert updated["system_prompt"] == "Journal override system"
        assert updated["user_prompt"] == "Journal override user {{transcript}}{{pile_addendum_block}}"

        get_response = await client.get("/api/v1/prompts/templates/processing.journal")
        assert get_response.status_code == 200
        current = get_response.json()
        assert current["has_override"] is True
        assert current["system_prompt"] == "Journal override system"

    await engine.dispose()


@pytest.mark.asyncio
async def test_prompt_template_update_rejects_unknown_placeholders(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-prompts-invalid.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    app = FastAPI()
    app.include_router(prompts_router, prefix="/api/v1")

    async def override_db_session():
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_db_session] = override_db_session

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:18888") as client:
        response = await client.put(
            "/api/v1/prompts/templates/processing.journal",
            json={
                "system_prompt": "Journal override system",
                "user_prompt": "Journal override user {{transcript}}{{unknown_field}}",
            },
        )
        assert response.status_code == 400
        assert "unknown_field" in response.text

    await engine.dispose()


@pytest.mark.asyncio
async def test_orchestrator_uses_prompt_override_and_pile_addendum(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-prompts-orchestrator.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    captured: dict[str, str] = {}

    class StubClient:
        async def generate_json(self, **kwargs) -> JournalResult:
            captured["system_prompt"] = kwargs["system_prompt"]
            captured["user_prompt"] = kwargs["user_prompt"]
            return JournalResult(entry="entry", action_items=[])

    async with session_factory() as session:
        session.add(
            PromptTemplate(
                key="processing.journal",
                system_prompt="Overridden journal system",
                user_prompt="Overridden journal user {{transcript}}{{pile_addendum_block}}",
            )
        )
        await session.commit()

        orchestrator = ProcessingOrchestrator(db=session)
        orchestrator.client = StubClient()  # type: ignore[assignment]

        messages = [
            StubMessage(MessageRole.USER, "I spent the afternoon fixing the build."),
            StubMessage(MessageRole.ASSISTANT, "That sounds productive."),
        ]

        result = await orchestrator.journal(messages, prompt_addendum="Keep the entry very terse.")  # type: ignore[arg-type]
        assert result.entry == "entry"
        assert captured["system_prompt"] == "Overridden journal system"
        assert "I spent the afternoon fixing the build." in captured["user_prompt"]
        assert "Keep the entry very terse." in captured["user_prompt"]

    await engine.dispose()
