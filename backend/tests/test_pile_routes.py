from __future__ import annotations

from datetime import datetime, timezone

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.routes_ingest import router as ingest_router
from app.api.routes_piles import router as piles_router
from app.core.config import get_settings
from app.db.migrations import apply_schema_migrations
from app.db.session import get_db_session
from app.models.base import Base
from app.models.enums import MessageRole, ProviderName


def _build_app(session_factory) -> FastAPI:
    app = FastAPI()
    app.include_router(ingest_router, prefix="/api/v1/ingest")
    app.include_router(piles_router, prefix="/api/v1")

    async def override_db_session():
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_db_session] = override_db_session
    return app


@pytest.mark.asyncio
async def test_list_piles_returns_seeded_built_ins(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'pile-routes.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        await connection.run_sync(apply_schema_migrations)

    monkeypatch.setenv("SAVEMYCONTEXT_MARKDOWN_DIR", str(tmp_path / "markdown"))
    get_settings.cache_clear()
    try:
        app = _build_app(session_factory)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:18888") as client:
            response = await client.get("/api/v1/piles")

        assert response.status_code == 200
        slugs = {pile["slug"] for pile in response.json()}
        assert slugs >= {"journal", "factual", "ideas", "todo", "discarded"}
    finally:
        get_settings.cache_clear()
    await engine.dispose()


@pytest.mark.asyncio
async def test_create_user_pile_and_reject_built_in_slug(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'pile-create.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        await connection.run_sync(apply_schema_migrations)

    monkeypatch.setenv("SAVEMYCONTEXT_MARKDOWN_DIR", str(tmp_path / "markdown"))
    get_settings.cache_clear()
    try:
        app = _build_app(session_factory)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:18888") as client:
            create = await client.post(
                "/api/v1/piles",
                json={
                    "slug": "research",
                    "name": "Research",
                    "description": "Long-form research notes.",
                    "attributes": ["queryable_qa", "alternate_phrasings"],
                },
            )
            assert create.status_code == 201, create.text
            pile = create.json()
            assert pile["kind"] == "user_defined"
            assert pile["slug"] == "research"
            assert "summary" in pile["attributes"]
            assert "queryable_qa" in pile["attributes"]
            assert pile["folder_label"] == "Research"

            duplicate = await client.post(
                "/api/v1/piles",
                json={"slug": "journal", "name": "Hijack", "attributes": []},
            )
            assert duplicate.status_code == 409

            bad_slug = await client.post(
                "/api/v1/piles",
                json={"slug": "Has Spaces", "name": "Bad", "attributes": []},
            )
            assert bad_slug.status_code == 400

            bad_attr = await client.post(
                "/api/v1/piles",
                json={"slug": "thinking", "name": "Thinking", "attributes": ["telepathy"]},
            )
            assert bad_attr.status_code == 400
    finally:
        get_settings.cache_clear()
    await engine.dispose()


@pytest.mark.asyncio
async def test_recover_endpoint_brings_session_back_to_a_classifiable_state(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'pile-recover.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        await connection.run_sync(apply_schema_migrations)

    monkeypatch.setenv("SAVEMYCONTEXT_MARKDOWN_DIR", str(tmp_path / "markdown"))
    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "heuristic")
    get_settings.cache_clear()
    try:
        app = _build_app(session_factory)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:18888") as client:
            ingest = await client.post(
                "/api/v1/ingest/diff",
                json={
                    "provider": ProviderName.GEMINI.value,
                    "external_session_id": "loom-route-1",
                    "sync_mode": "full_snapshot",
                    "title": "loom-route-1",
                    "source_url": "https://gemini.google.com/app/loom-route-1",
                    "captured_at": datetime(2026, 4, 18, 12, 0, tzinfo=timezone.utc).isoformat(),
                    "messages": [
                        {
                            "external_message_id": "m-1",
                            "role": MessageRole.USER.value,
                            "content": "Loom — FastAPI uses uvloop and asgi.",
                        }
                    ],
                    "raw_capture": {"source": "test"},
                    "route_to_discard": True,
                    "discard_word_match": "loom",
                },
            )
            assert ingest.status_code == 202, ingest.text
            session_id = ingest.json()["session_id"]
            assert ingest.json()["is_discarded"] is True
            assert ingest.json()["pile_slug"] == "discarded"

            discarded_list = await client.get("/api/v1/piles/discarded/sessions")
            assert discarded_list.status_code == 200
            assert any(item["id"] == session_id for item in discarded_list.json()["items"])

            recover = await client.post(f"/api/v1/piles/discarded/sessions/{session_id}/recover")
            assert recover.status_code == 200, recover.text
            payload = recover.json()
            assert payload["is_discarded"] is False
            assert payload["pile_slug"] in {"factual", "journal", "ideas", "todo"}
    finally:
        get_settings.cache_clear()
    await engine.dispose()
