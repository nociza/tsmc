from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.db.migrations import apply_schema_migrations
from app.models import Pile, PileKind
from app.models.base import Base
from app.services.pile_service import PileService
from app.services.piles import DEFAULT_PILES


@pytest.mark.asyncio
async def test_apply_schema_migrations_seeds_built_in_piles(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'piles-seed.db'}")

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        await connection.run_sync(apply_schema_migrations)

    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as session:
        result = await session.execute(select(Pile).order_by(Pile.sort_order.asc()))
        piles = list(result.scalars().all())

    slugs = {pile.slug for pile in piles}
    assert slugs == {seed.slug for seed in DEFAULT_PILES}
    assert {pile.kind for pile in piles} == {seed.kind for seed in DEFAULT_PILES}

    discarded = next(pile for pile in piles if pile.slug == "discarded")
    assert discarded.is_visible_on_dashboard is False
    assert discarded.attributes == ["chronological"]
    assert discarded.pipeline_config == {"auto_discard_categories": [], "custom_prompt_addendum": None}

    journal = next(pile for pile in piles if pile.slug == "journal")
    assert journal.is_visible_on_dashboard is True
    assert "summary" in journal.attributes
    assert journal.kind == PileKind.BUILT_IN_JOURNAL

    await engine.dispose()


@pytest.mark.asyncio
async def test_apply_schema_migrations_is_idempotent(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'piles-idempotent.db'}")

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        await connection.run_sync(apply_schema_migrations)

    async with engine.begin() as connection:
        await connection.run_sync(apply_schema_migrations)

    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as session:
        count = (await session.execute(select(Pile))).scalars().all()
    assert len(count) == len(DEFAULT_PILES)

    await engine.dispose()


@pytest.mark.asyncio
async def test_pile_service_lookup_helpers(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'piles-service.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        await connection.run_sync(apply_schema_migrations)

    async with session_factory() as session:
        service = PileService(session)
        listed = await service.list_piles()
        assert {pile.slug for pile in listed} >= {"journal", "factual", "ideas", "todo", "discarded"}

        visible = await service.list_piles(include_hidden=False)
        assert "discarded" not in {pile.slug for pile in visible}

        ideas = await service.get_by_slug("ideas")
        assert ideas is not None
        assert ideas.kind == PileKind.BUILT_IN_IDEAS

        discarded = await service.discarded_pile()
        assert discarded is not None
        assert discarded.is_visible_on_dashboard is False

    await engine.dispose()


@pytest.mark.asyncio
async def test_apply_schema_migrations_backfills_pile_id_from_category(tmp_path) -> None:
    from datetime import datetime, timezone

    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'piles-backfill.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    from app.models import ChatSession, ProviderName, SessionCategory

    async with session_factory() as session:
        legacy = ChatSession(
            provider=ProviderName.GEMINI,
            external_session_id="legacy-1",
            category=SessionCategory.JOURNAL,
            last_captured_at=datetime(2026, 4, 18, tzinfo=timezone.utc),
        )
        session.add(legacy)
        await session.commit()
        legacy_id = legacy.id

    async with engine.begin() as connection:
        await connection.run_sync(apply_schema_migrations)

    async with session_factory() as session:
        loaded = await session.get(ChatSession, legacy_id)
        assert loaded is not None
        assert loaded.pile_id is not None

        journal_pile = (await session.execute(select(Pile).where(Pile.slug == "journal"))).scalar_one()
        assert loaded.pile_id == journal_pile.id

    await engine.dispose()
