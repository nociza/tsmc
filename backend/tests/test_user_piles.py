from __future__ import annotations

from datetime import datetime, timezone

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.routes_ingest import router as ingest_router
from app.api.routes_piles import router as piles_router
from app.core.config import get_settings
from app.db.migrations import apply_schema_migrations
from app.db.session import get_db_session
from app.models import ChatSession, Pile
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
async def test_assign_session_to_user_pile_runs_attribute_pipeline(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'user-pile-assign.db'}")
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
            create = await client.post(
                "/api/v1/piles",
                json={
                    "slug": "research",
                    "name": "Research",
                    "description": "Long-form research notes.",
                    "attributes": ["alternate_phrasings", "importance", "completion"],
                },
            )
            assert create.status_code == 201, create.text

            ingest = await client.post(
                "/api/v1/ingest/diff",
                json={
                    "provider": ProviderName.GEMINI.value,
                    "external_session_id": "user-pile-1",
                    "sync_mode": "full_snapshot",
                    "title": "user-pile-1",
                    "source_url": "https://gemini.google.com/app/user-pile-1",
                    "captured_at": datetime(2026, 4, 18, 12, 0, tzinfo=timezone.utc).isoformat(),
                    "messages": [
                        {
                            "external_message_id": "m-1",
                            "role": MessageRole.USER.value,
                            "content": "Brainstorm: low-friction onboarding for self-hosters.",
                        }
                    ],
                    "raw_capture": {"source": "test"},
                },
            )
            assert ingest.status_code == 202, ingest.text
            session_id = ingest.json()["session_id"]
            initial_pile_slug = ingest.json()["pile_slug"]
            assert initial_pile_slug in {"factual", "ideas", "journal", "todo"}

            assign = await client.post(f"/api/v1/piles/research/sessions/{session_id}/assign")
            assert assign.status_code == 200, assign.text
            payload = assign.json()
            assert payload["pile_slug"] == "research"
            assert payload["is_discarded"] is False
            assert payload["pile_outputs"] is not None
            outputs = payload["pile_outputs"]
            # Heuristic fallback fills these:
            assert "alternate_phrasings" in outputs or "summary" in outputs
            assert outputs.get("importance") == 3
            assert outputs.get("completion") == "open"
    finally:
        get_settings.cache_clear()
    await engine.dispose()


@pytest.mark.asyncio
async def test_auto_discard_categories_route_session_to_discarded_via_classifier(tmp_path, monkeypatch) -> None:
    """When the discarded pile has auto_discard_categories configured and the
    classifier identifies a match, the session should be routed to discarded.
    The heuristic classifier doesn't match descriptions, so we mock the LLM
    client.
    """
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'auto-discard.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        await connection.run_sync(apply_schema_migrations)

    monkeypatch.setenv("SAVEMYCONTEXT_MARKDOWN_DIR", str(tmp_path / "markdown"))
    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "openai")
    monkeypatch.setenv("SAVEMYCONTEXT_OPENAI_API_KEY", "test-key")
    get_settings.cache_clear()

    # Patch the OpenAI client's generate_json to claim the session is "small talk".
    from app.services.llm.openai_client import OpenAIClient

    async def fake_generate_json(self, system_prompt, user_prompt, schema):  # type: ignore[no-untyped-def]
        from app.schemas.processing import ClassificationResult
        from app.models.enums import SessionCategory as _SC

        if "classify transcripts" in system_prompt.lower() or "classify" in system_prompt.lower():
            return ClassificationResult(category=_SC.DISCARDED, reason="matched 'small talk'")
        # Fallback for any other LLM calls — should not be hit when discarding.
        raise RuntimeError("unexpected LLM call after discard")

    monkeypatch.setattr(OpenAIClient, "generate_json", fake_generate_json, raising=True)

    try:
        # Configure the discarded pile's auto_discard_categories.
        async with session_factory() as session:
            discarded = (await session.execute(select(Pile).where(Pile.slug == "discarded"))).scalar_one()
            discarded.pipeline_config = {
                "auto_discard_categories": ["small talk", "test sessions"],
                "custom_prompt_addendum": None,
            }
            await session.commit()

        app = _build_app(session_factory)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:18888") as client:
            ingest = await client.post(
                "/api/v1/ingest/diff",
                json={
                    "provider": ProviderName.GEMINI.value,
                    "external_session_id": "auto-discard-1",
                    "sync_mode": "full_snapshot",
                    "title": "auto-discard-1",
                    "source_url": "https://gemini.google.com/app/auto-discard-1",
                    "captured_at": datetime(2026, 4, 18, 12, 0, tzinfo=timezone.utc).isoformat(),
                    "messages": [
                        {
                            "external_message_id": "m-1",
                            "role": MessageRole.USER.value,
                            "content": "hey what's up",
                        }
                    ],
                    "raw_capture": {"source": "test"},
                },
            )
            assert ingest.status_code == 202, ingest.text
            assert ingest.json()["is_discarded"] is True
            assert ingest.json()["pile_slug"] == "discarded"

        async with session_factory() as session:
            row = (await session.execute(select(ChatSession).where(ChatSession.external_session_id == "auto-discard-1"))).scalar_one()
            assert row.is_discarded is True
            assert "small talk" in (row.discarded_reason or "")
    finally:
        get_settings.cache_clear()
    await engine.dispose()
