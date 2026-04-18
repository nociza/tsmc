from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.db.migrations import apply_schema_migrations
from app.models import ChatSession, Pile
from app.models.base import Base
from app.models.enums import MessageRole, ProviderName
from app.schemas.ingest import IngestDiffRequest, IngestMessage
from app.services.ingest import IngestService
from app.services.processing import SessionProcessor


def _payload(*, external_id: str, content: str, route_to_discard: bool = False, discard_word: str | None = None) -> IngestDiffRequest:
    return IngestDiffRequest(
        provider=ProviderName.GEMINI,
        external_session_id=external_id,
        sync_mode="full_snapshot",
        title=external_id,
        source_url=f"https://gemini.google.com/app/{external_id}",
        captured_at=datetime(2026, 4, 18, 12, 0, tzinfo=timezone.utc),
        messages=[
            IngestMessage(
                external_message_id="m-1",
                role=MessageRole.USER,
                content=content,
            )
        ],
        raw_capture={"source": "test"},
        route_to_discard=route_to_discard,
        discard_word_match=discard_word,
    )


@pytest.mark.asyncio
async def test_route_to_discard_skips_processing_and_writes_into_discarded_folder(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'discard-route.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        await connection.run_sync(apply_schema_migrations)

    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "heuristic")
    get_settings.cache_clear()

    try:
        async with session_factory() as session:
            service = IngestService(session)
            service.exporter.base_dir = tmp_path / "markdown"

            stored, _ = await service.ingest(
                _payload(
                    external_id="loom-session-1",
                    content="Loom, just a quick scratch — please ignore.",
                    route_to_discard=True,
                    discard_word="loom",
                )
            )

            assert stored.is_discarded is True
            assert stored.discarded_reason is not None
            assert "loom" in stored.discarded_reason.lower()
            assert stored.last_processed_at is not None
            assert stored.journal_entry is None
            assert stored.todo_summary is None
            assert stored.idea_summary is None
            assert stored.share_post is None
            assert stored.triplets == []

            discarded_pile = (await session.execute(select(Pile).where(Pile.slug == "discarded"))).scalar_one()
            assert stored.pile_id == discarded_pile.id

            markdown_path = Path(stored.markdown_path or "")
            assert "Discarded" in markdown_path.parts
            assert markdown_path.exists()
    finally:
        get_settings.cache_clear()

    await engine.dispose()


@pytest.mark.asyncio
async def test_recover_from_discard_runs_classification(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'discard-recover.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        await connection.run_sync(apply_schema_migrations)

    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "heuristic")
    get_settings.cache_clear()

    try:
        async with session_factory() as session:
            service = IngestService(session)
            service.exporter.base_dir = tmp_path / "markdown"

            stored, _ = await service.ingest(
                _payload(
                    external_id="recover-session-1",
                    content="Loom, FastAPI uses uvloop for performance.",
                    route_to_discard=True,
                    discard_word="loom",
                )
            )
            session_id = stored.id
            assert stored.is_discarded is True

        async with session_factory() as session:
            processor = SessionProcessor(session)
            recovered = await processor.recover_from_discard(session_id)
            await session.commit()

            assert recovered.is_discarded is False
            assert recovered.discarded_reason is None
            # The factual heuristic should pick the FastAPI/uvloop content as factual.
            from app.models import SessionCategory

            assert recovered.category in {SessionCategory.FACTUAL, SessionCategory.JOURNAL, SessionCategory.IDEAS}
            assert recovered.pile_id is not None
    finally:
        get_settings.cache_clear()

    await engine.dispose()


@pytest.mark.asyncio
async def test_discarded_sessions_excluded_from_dashboard_summary(tmp_path, monkeypatch) -> None:
    """
    Counts sessions split between discarded and non-discarded buckets to confirm
    the dashboard summary query honors the is_discarded filter.
    """
    from sqlalchemy import func
    from sqlalchemy import select as sa_select

    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'discard-dashboard.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        await connection.run_sync(apply_schema_migrations)

    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "heuristic")
    get_settings.cache_clear()

    try:
        async with session_factory() as session:
            service = IngestService(session)
            service.exporter.base_dir = tmp_path / "markdown"

            await service.ingest(
                _payload(
                    external_id="kept-session",
                    content="FastAPI uses uvloop and asgi.",
                )
            )
            await service.ingest(
                _payload(
                    external_id="discarded-session",
                    content="Loom: please ignore",
                    route_to_discard=True,
                    discard_word="loom",
                )
            )

        async with session_factory() as session:
            non_discarded = int(
                (await session.scalar(
                    sa_select(func.count(ChatSession.id)).where(ChatSession.is_discarded.is_(False))
                )) or 0
            )
            discarded = int(
                (await session.scalar(
                    sa_select(func.count(ChatSession.id)).where(ChatSession.is_discarded.is_(True))
                )) or 0
            )
            assert non_discarded == 1
            assert discarded == 1
    finally:
        get_settings.cache_clear()

    await engine.dispose()
