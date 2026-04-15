from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models import ChatSession
from app.models.base import Base
from app.models.enums import MessageRole, ProviderName
from app.core.config import get_settings
from app.schemas.ingest import IngestDiffRequest, IngestMessage
from app.services.ingest import IngestService
from app.services.processing_worker import ExtensionBrowserProcessingService


@pytest.mark.asyncio
async def test_processing_worker_complete_applies_pipeline_result_batch_and_writes_markdown(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-processing-worker.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "browser_proxy")
    monkeypatch.setenv("SAVEMYCONTEXT_EXPERIMENTAL_BROWSER_AUTOMATION", "true")
    get_settings.cache_clear()

    try:
        async with session_factory() as session:
            ingest = IngestService(session)
            ingest.exporter.base_dir = tmp_path / "markdown"
            first_session, _ = await ingest.ingest(
                IngestDiffRequest(
                    provider=ProviderName.GEMINI,
                    external_session_id="processing-session-1",
                    sync_mode="full_snapshot",
                    title="Processing Session 1",
                    source_url="https://gemini.google.com/app/processing-session-1",
                    captured_at=datetime(2026, 4, 2, 13, 0, tzinfo=timezone.utc),
                    messages=[
                        IngestMessage(
                            external_message_id="msg-1",
                            role=MessageRole.USER,
                            content="I need to plan tomorrow and review today's work.",
                        )
                    ],
                    raw_capture={"source": "test"},
                )
            )
            second_session, _ = await ingest.ingest(
                IngestDiffRequest(
                    provider=ProviderName.GEMINI,
                    external_session_id="processing-session-2",
                    sync_mode="full_snapshot",
                    title="Processing Session 2",
                    source_url="https://gemini.google.com/app/processing-session-2",
                    captured_at=datetime(2026, 4, 2, 13, 5, tzinfo=timezone.utc),
                    messages=[
                        IngestMessage(
                            external_message_id="msg-2",
                            role=MessageRole.USER,
                            content="Explain how FastAPI uses uvloop.",
                        )
                    ],
                    raw_capture={"source": "test"},
                )
            )

            worker = ExtensionBrowserProcessingService(session)
            result = await worker.complete_task(
                [first_session.id, second_session.id],
                (
                    '{"results":['
                    '{"session_id":"%s","category":"journal","classification_reason":"Personal planning.","journal":{"entry":"Planned the next day.","action_items":["Review the release checklist"]},"factual_triplets":[],"idea":null},'
                    '{"session_id":"%s","category":"factual","classification_reason":"Technical explanation.","journal":null,"factual_triplets":[{"subject":"FastAPI","predicate":"uses","object":"uvloop","confidence":0.92}],"idea":null}'
                    "]}"
                )
                % (first_session.id, second_session.id),
            )

            refreshed_first = await session.get(ChatSession, first_session.id)
            refreshed_second = await session.get(ChatSession, second_session.id)

            assert result.processed_count == 2
            assert [item.session_id for item in result.results] == [first_session.id, second_session.id]
            assert refreshed_first is not None
            assert refreshed_second is not None
            assert refreshed_first.category.value == "journal"
            assert "Planned the next day." in (refreshed_first.journal_entry or "")
            assert refreshed_first.markdown_path is not None
            assert refreshed_second.category.value == "factual"
            assert refreshed_second.markdown_path is not None
    finally:
        get_settings.cache_clear()

    await engine.dispose()


@pytest.mark.asyncio
async def test_processing_worker_complete_rejects_invalid_json_with_clear_error(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-processing-worker-invalid.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "browser_proxy")
    monkeypatch.setenv("SAVEMYCONTEXT_EXPERIMENTAL_BROWSER_AUTOMATION", "true")
    get_settings.cache_clear()

    try:
        async with session_factory() as session:
            ingest = IngestService(session)
            ingest.exporter.base_dir = tmp_path / "markdown"
            stored_session, _ = await ingest.ingest(
                IngestDiffRequest(
                    provider=ProviderName.GEMINI,
                    external_session_id="processing-invalid-session",
                    sync_mode="full_snapshot",
                    title="Processing Invalid Session",
                    source_url="https://gemini.google.com/app/processing-invalid-session",
                    captured_at=datetime(2026, 4, 3, 10, 0, tzinfo=timezone.utc),
                    messages=[
                        IngestMessage(
                            external_message_id="msg-1",
                            role=MessageRole.USER,
                            content="Summarize this as a journal entry.",
                        )
                    ],
                    raw_capture={"source": "test"},
                )
            )

            worker = ExtensionBrowserProcessingService(session)
            with pytest.raises(ValueError, match="Could not parse the processing response as valid JSON"):
                await worker.complete_task(
                    [stored_session.id],
                    '{"category":"journal","classification_reason":"broken \\q"}',
                )
    finally:
        get_settings.cache_clear()

    await engine.dispose()


@pytest.mark.asyncio
async def test_processing_worker_complete_accepts_task_key_reply_and_maps_to_expected_session(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-processing-worker-task-key.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "browser_proxy")
    monkeypatch.setenv("SAVEMYCONTEXT_EXPERIMENTAL_BROWSER_AUTOMATION", "true")
    get_settings.cache_clear()

    try:
        async with session_factory() as session:
            ingest = IngestService(session)
            ingest.exporter.base_dir = tmp_path / "markdown"
            stored_session, _ = await ingest.ingest(
                IngestDiffRequest(
                    provider=ProviderName.GEMINI,
                    external_session_id="processing-task-key-session",
                    sync_mode="full_snapshot",
                    title="Processing Task Key Session",
                    source_url="https://gemini.google.com/app/processing-task-key-session",
                    captured_at=datetime(2026, 4, 3, 10, 0, tzinfo=timezone.utc),
                    messages=[
                        IngestMessage(
                            external_message_id="msg-1",
                            role=MessageRole.USER,
                            content="Summarize this as a journal entry.",
                        )
                    ],
                    raw_capture={"source": "test"},
                )
            )

            worker = ExtensionBrowserProcessingService(session)
            result = await worker.complete_task(
                [stored_session.id],
                '{"results":[{"task_key":"task_1","category":"journal","classification_reason":"ok","journal":{"entry":"hello","action_items":[]},"factual_triplets":[],"idea":null}]}',
            )

            assert result.processed_count == 1
            assert result.results[0].session_id == stored_session.id
    finally:
        get_settings.cache_clear()

    await engine.dispose()


@pytest.mark.asyncio
async def test_processing_worker_complete_accepts_single_result_with_wrong_session_id_for_single_batch(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-processing-worker-single-fallback.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "browser_proxy")
    monkeypatch.setenv("SAVEMYCONTEXT_EXPERIMENTAL_BROWSER_AUTOMATION", "true")
    get_settings.cache_clear()

    try:
        async with session_factory() as session:
            ingest = IngestService(session)
            ingest.exporter.base_dir = tmp_path / "markdown"
            stored_session, _ = await ingest.ingest(
                IngestDiffRequest(
                    provider=ProviderName.GEMINI,
                    external_session_id="processing-single-fallback-session",
                    sync_mode="full_snapshot",
                    title="Processing Single Fallback Session",
                    source_url="https://gemini.google.com/app/processing-single-fallback-session",
                    captured_at=datetime(2026, 4, 3, 10, 0, tzinfo=timezone.utc),
                    messages=[
                        IngestMessage(
                            external_message_id="msg-1",
                            role=MessageRole.USER,
                            content="Summarize this as a journal entry.",
                        )
                    ],
                    raw_capture={"source": "test"},
                )
            )

            worker = ExtensionBrowserProcessingService(session)
            result = await worker.complete_task(
                [stored_session.id],
                '{"results":[{"session_id":"made-up-id","category":"journal","classification_reason":"ok","journal":{"entry":"hello","action_items":[]},"factual_triplets":[],"idea":null}]}',
            )

            assert result.processed_count == 1
            assert result.results[0].session_id == stored_session.id
    finally:
        get_settings.cache_clear()

    await engine.dispose()
