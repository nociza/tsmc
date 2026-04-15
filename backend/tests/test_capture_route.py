from __future__ import annotations

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.routes_capture import router as capture_router
from app.api.routes_dashboard import router as dashboard_router
from app.core.config import get_settings
from app.db.session import get_db_session
from app.models.base import Base
from app.models.enums import SessionCategory
from app.services.source_capture import SourceCaptureEnrichment, SourceCaptureProcessor


@pytest.mark.asyncio
async def test_capture_route_saves_raw_selection_and_exposes_it_to_search(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-capture-route.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_MARKDOWN_DIR", str(tmp_path / "markdown"))
    get_settings.cache_clear()
    try:
        app = FastAPI()
        app.include_router(capture_router, prefix="/api/v1")
        app.include_router(dashboard_router, prefix="/api/v1")

        async def override_db_session():
            async with session_factory() as session:
                yield session

        app.dependency_overrides[get_db_session] = override_db_session

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:18888") as client:
            response = await client.post(
                "/api/v1/capture/source",
                json={
                    "capture_kind": "selection",
                    "save_mode": "raw",
                    "page_title": "Rust article",
                    "source_url": "https://example.com/rust",
                    "selection_text": "Rust uses ownership to manage memory safely.",
                    "source_text": "Rust uses ownership to manage memory safely.",
                    "source_markdown": "Rust uses ownership to manage memory safely."
                },
            )

            assert response.status_code == 202
            payload = response.json()
            assert payload["processed"] is False
            assert payload["capture_kind"] == "selection"
            assert payload["save_mode"] == "raw"
            assert payload["markdown_path"].endswith(".md")
            assert payload["raw_source_path"].endswith("--source.md")

            search_response = await client.get("/api/v1/search", params={"q": "ownership"})

        assert search_response.status_code == 200
        search_payload = search_response.json()
        assert any(result["kind"] == "source_capture" for result in search_payload["results"])
    finally:
        get_settings.cache_clear()

    await engine.dispose()


@pytest.mark.asyncio
async def test_capture_route_saves_ai_enriched_page_capture(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-capture-ai-route.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_MARKDOWN_DIR", str(tmp_path / "markdown"))
    get_settings.cache_clear()

    async def fake_enrich(self, payload):  # type: ignore[no-untyped-def]
        return SourceCaptureEnrichment(
            title="Reference architecture note",
            category=SessionCategory.FACTUAL,
            classification_reason="A factual reference page about distributed systems.",
            summary="Captures the main architecture constraints and design choices.",
            cleaned_markdown="# Reference architecture\n\n- Durable queues\n- Backpressure\n- Idempotent workers",
        )

    monkeypatch.setattr(SourceCaptureProcessor, "enrich", fake_enrich)

    try:
        app = FastAPI()
        app.include_router(capture_router, prefix="/api/v1")

        async def override_db_session():
            async with session_factory() as session:
                yield session

        app.dependency_overrides[get_db_session] = override_db_session

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:18888") as client:
            response = await client.post(
                "/api/v1/capture/source",
                json={
                    "capture_kind": "page",
                    "save_mode": "ai",
                    "page_title": "Distributed systems reference",
                    "source_url": "https://example.com/reference",
                    "source_text": "Durable queues, backpressure, and idempotent workers are important.",
                    "source_markdown": "# Distributed systems reference\n\nDurable queues.\n\nBackpressure.\n\nIdempotent workers."
                },
            )

        assert response.status_code == 202
        payload = response.json()
        assert payload["processed"] is True
        assert payload["category"] == "factual"
        markdown_path = tmp_path / "markdown" / "SaveMyContext" / "Captures"
        assert any(markdown_path.glob("page--reference-architecture-note-*.md"))
        note_path = next(markdown_path.glob("page--reference-architecture-note-*.md"))
        note_markdown = note_path.read_text(encoding="utf-8")
        assert "Reference architecture note" in note_markdown
        assert "Durable queues" in note_markdown
    finally:
        get_settings.cache_clear()

    await engine.dispose()
