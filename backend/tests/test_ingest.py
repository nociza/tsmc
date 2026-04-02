from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models import ChatMessage
from app.models.base import Base
from app.models.enums import MessageRole, ProviderName
from app.schemas.ingest import IngestDiffRequest, IngestMessage
from app.services.ingest import IngestService


@pytest.mark.asyncio
async def test_full_snapshot_updates_existing_messages(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'tsmc-test.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        service = IngestService(session)
        service.exporter.base_dir = tmp_path / "markdown"

        first_payload = IngestDiffRequest(
            provider=ProviderName.GEMINI,
            external_session_id="session-1",
            sync_mode="full_snapshot",
            source_url="https://gemini.google.com/app/session-1",
            captured_at=datetime(2026, 4, 1, 12, 0, tzinfo=timezone.utc),
            messages=[
                IngestMessage(
                    external_message_id="msg-1",
                    role=MessageRole.USER,
                    content="Original prompt",
                )
            ],
            raw_capture={"source": "test"},
        )
        await service.ingest(first_payload)

        second_payload = IngestDiffRequest(
            provider=ProviderName.GEMINI,
            external_session_id="session-1",
            sync_mode="full_snapshot",
            source_url="https://gemini.google.com/app/session-1",
            captured_at=datetime(2026, 4, 1, 12, 5, tzinfo=timezone.utc),
            messages=[
                IngestMessage(
                    external_message_id="msg-1",
                    role=MessageRole.USER,
                    content="Updated prompt text",
                ),
                IngestMessage(
                    external_message_id="msg-2",
                    parent_external_message_id="msg-1",
                    role=MessageRole.ASSISTANT,
                    content="Fresh assistant reply",
                ),
            ],
            raw_capture={"source": "test"},
        )
        await service.ingest(second_payload)

        result = await session.execute(select(ChatMessage).order_by(ChatMessage.sequence_index))
        messages = result.scalars().all()

        assert [message.external_message_id for message in messages] == ["msg-1", "msg-2"]
        assert messages[0].content == "Updated prompt text"
        assert messages[1].content == "Fresh assistant reply"

    await engine.dispose()


@pytest.mark.asyncio
async def test_ingest_accepts_long_titles(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'tsmc-long-title.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        service = IngestService(session)
        service.exporter.base_dir = tmp_path / "markdown"

        long_title = "Generate keyframes for me using the style of hand drawn stick figures on white background. " * 12
        payload = IngestDiffRequest(
            provider=ProviderName.GEMINI,
            external_session_id="long-title-session",
            sync_mode="full_snapshot",
            title=long_title,
            source_url="https://gemini.google.com/app/long-title-session",
            captured_at=datetime(2026, 4, 1, 12, 0, tzinfo=timezone.utc),
            messages=[
                IngestMessage(
                    external_message_id="msg-1",
                    role=MessageRole.USER,
                    content="Test content",
                )
            ],
            raw_capture={"source": "test"},
        )

        stored_session, _ = await service.ingest(payload)
        assert stored_session.title == long_title

    await engine.dispose()
