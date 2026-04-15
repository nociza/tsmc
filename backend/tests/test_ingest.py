from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import shutil
import subprocess

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models import ChatMessage, ChatSession
from app.models.base import Base
from app.models.enums import MessageRole, ProviderName, SessionCategory
from app.schemas.ingest import IngestDiffRequest, IngestMessage
from app.core.config import get_settings
from app.services.ingest import IngestService
from app.services.processing_worker import ExtensionBrowserProcessingService
from app.services.todo import TodoListService


@pytest.mark.asyncio
async def test_full_snapshot_updates_existing_messages(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-test.db'}")
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
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-long-title.db'}")
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


@pytest.mark.asyncio
async def test_ingest_writes_markdown_when_related_sessions_have_mixed_datetime_timezones(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-ingest-timezones.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "openai")
    get_settings.cache_clear()
    try:
        async with session_factory() as session:
            service = IngestService(session)
            service.exporter.base_dir = tmp_path / "markdown"

            first_payload = IngestDiffRequest(
                provider=ProviderName.GEMINI,
                external_session_id="facts-1",
                sync_mode="full_snapshot",
                title="Facts 1",
                source_url="https://gemini.google.com/app/facts-1",
                captured_at=datetime(2026, 4, 2, 12, 0, tzinfo=timezone.utc),
                messages=[
                    IngestMessage(
                        external_message_id="msg-1",
                        role=MessageRole.USER,
                        content="FastAPI uses uvloop.",
                    )
                ],
                raw_capture={"source": "test"},
            )
            await service.ingest(first_payload)

            first_session = await session.scalar(
                select(ChatSession).where(ChatSession.external_session_id == "facts-1")
            )
            assert first_session is not None
            first_session.updated_at = datetime(2026, 4, 2, 12, 5)
            await session.flush()

            second_payload = IngestDiffRequest(
                provider=ProviderName.GEMINI,
                external_session_id="facts-2",
                sync_mode="full_snapshot",
                title="Facts 2",
                source_url="https://gemini.google.com/app/facts-2",
                captured_at=datetime(2026, 4, 2, 12, 10, tzinfo=timezone.utc),
                messages=[
                    IngestMessage(
                        external_message_id="msg-2",
                        role=MessageRole.USER,
                        content="FastAPI supports ASGI.",
                    )
                ],
                raw_capture={"source": "test"},
            )
            stored_session, _ = await service.ingest(second_payload)

            assert stored_session.markdown_path is not None
            entity_note = service.exporter.vault_root / "Graph" / "Entities" / "fastapi.md"
            assert entity_note.exists()
            entity_markdown = entity_note.read_text(encoding="utf-8")
            assert "Facts 1" in entity_markdown
            assert "Facts 2" in entity_markdown
    finally:
        get_settings.cache_clear()

    await engine.dispose()


@pytest.mark.asyncio
async def test_ingest_writes_fact_triplets_into_session_markdown(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-ingest-factual-markdown.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "heuristic")
    get_settings.cache_clear()
    try:
        async with session_factory() as session:
            service = IngestService(session)
            service.exporter.base_dir = tmp_path / "markdown"

            stored_session, _ = await service.ingest(
                IngestDiffRequest(
                    provider=ProviderName.GEMINI,
                    external_session_id="facts-triplet-session",
                    sync_mode="full_snapshot",
                    title="Facts Triplet Session",
                    source_url="https://gemini.google.com/app/facts-triplet-session",
                    captured_at=datetime(2026, 4, 14, 12, 0, tzinfo=timezone.utc),
                    messages=[
                        IngestMessage(
                            external_message_id="msg-1",
                            role=MessageRole.USER,
                            content="FastAPI uses uvloop.",
                        )
                    ],
                    raw_capture={"source": "test"},
                )
            )

            markdown_path = Path(stored_session.markdown_path or "")
            markdown = markdown_path.read_text(encoding="utf-8")

            assert stored_session.category == SessionCategory.FACTUAL
            assert any(triplet.subject == "FastAPI" and triplet.predicate == "uses" for triplet in stored_session.triplets)
            assert "## Fact Triplets" in markdown
            assert "- FastAPI | uses | uvloop" in markdown
    finally:
        get_settings.cache_clear()

    await engine.dispose()


@pytest.mark.asyncio
async def test_ingest_writes_source_document_with_raw_capture_and_message_payloads(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-ingest-source-markdown.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "heuristic")
    get_settings.cache_clear()
    try:
        async with session_factory() as session:
            service = IngestService(session)
            service.exporter.base_dir = tmp_path / "markdown"

            stored_session, _ = await service.ingest(
                IngestDiffRequest(
                    provider=ProviderName.GEMINI,
                    external_session_id="source-doc-session",
                    sync_mode="full_snapshot",
                    title="Source Doc Session",
                    source_url="https://gemini.google.com/app/source-doc-session",
                    captured_at=datetime(2026, 4, 14, 12, 0, tzinfo=timezone.utc),
                    messages=[
                        IngestMessage(
                            external_message_id="msg-1",
                            role=MessageRole.USER,
                            content="Explain how FastAPI uses uvloop.",
                            raw_payload={"messageId": "msg-1", "role": "user"},
                        )
                    ],
                    raw_capture={"provider": "gemini", "snapshot": {"messageCount": 1}},
                )
            )

            markdown_path = Path(stored_session.markdown_path or "")
            source_path = markdown_path.parent.parent / "Sources" / "gemini--source-doc-session--source.md"
            markdown = markdown_path.read_text(encoding="utf-8")
            source_markdown = source_path.read_text(encoding="utf-8")

            assert source_path.exists()
            assert "Source Document" in markdown
            assert "[[Sources/gemini--source-doc-session--source|Source Document]]" in markdown
            assert "## Raw Sync Captures" in source_markdown
            assert "\"messageCount\": 1" in source_markdown
            assert "\"messageId\": \"msg-1\"" in source_markdown
    finally:
        get_settings.cache_clear()

    await engine.dispose()


@pytest.mark.asyncio
async def test_ingest_auto_processes_immediately_without_browser_automation(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-browser-llm.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "auto")
    get_settings.cache_clear()

    try:
        async with session_factory() as session:
            service = IngestService(session)
            service.exporter.base_dir = tmp_path / "markdown"

            first_session, _ = await service.ingest(
                IngestDiffRequest(
                    provider=ProviderName.GEMINI,
                    external_session_id="source-session-1",
                    sync_mode="full_snapshot",
                    title="Original Session 1",
                    source_url="https://gemini.google.com/app/source-session-1",
                    captured_at=datetime(2026, 4, 2, 12, 0, tzinfo=timezone.utc),
                    messages=[
                        IngestMessage(
                            external_message_id="msg-1",
                            role=MessageRole.USER,
                            content="Plan tomorrow and reflect on today.",
                        )
                    ],
                    raw_capture={"source": "test"},
                )
            )
            second_session, _ = await service.ingest(
                IngestDiffRequest(
                    provider=ProviderName.GEMINI,
                    external_session_id="source-session-2",
                    sync_mode="full_snapshot",
                    title="Original Session 2",
                    source_url="https://gemini.google.com/app/source-session-2",
                    captured_at=datetime(2026, 4, 2, 12, 5, tzinfo=timezone.utc),
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

            processing = ExtensionBrowserProcessingService(session)
            next_task = await processing.next_task()

            assert first_session.last_processed_at is not None
            assert second_session.last_processed_at is not None
            assert next_task.available is False
            assert next_task.task_count == 0
            assert next_task.prompt is None
    finally:
        get_settings.cache_clear()

    await engine.dispose()


@pytest.mark.asyncio
async def test_ingest_browser_proxy_batches_when_experimental_browser_automation_is_enabled(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-browser-llm-experimental.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "browser_proxy")
    monkeypatch.setenv("SAVEMYCONTEXT_EXPERIMENTAL_BROWSER_AUTOMATION", "true")
    monkeypatch.setenv("SAVEMYCONTEXT_BROWSER_LLM_MODEL", "browser-gemini")
    monkeypatch.setenv("SAVEMYCONTEXT_BROWSER_LLM_STATE_PATH", str(tmp_path / "browser-llm-state.json"))
    get_settings.cache_clear()

    try:
        async with session_factory() as session:
            service = IngestService(session)
            service.exporter.base_dir = tmp_path / "markdown"

            first_session, _ = await service.ingest(
                IngestDiffRequest(
                    provider=ProviderName.GEMINI,
                    external_session_id="source-session-1",
                    sync_mode="full_snapshot",
                    title="Original Session 1",
                    source_url="https://gemini.google.com/app/source-session-1",
                    captured_at=datetime(2026, 4, 2, 12, 0, tzinfo=timezone.utc),
                    messages=[
                        IngestMessage(
                            external_message_id="msg-1",
                            role=MessageRole.USER,
                            content="Plan tomorrow and reflect on today.",
                        )
                    ],
                    raw_capture={"source": "test"},
                )
            )
            second_session, _ = await service.ingest(
                IngestDiffRequest(
                    provider=ProviderName.GEMINI,
                    external_session_id="source-session-2",
                    sync_mode="full_snapshot",
                    title="Original Session 2",
                    source_url="https://gemini.google.com/app/source-session-2",
                    captured_at=datetime(2026, 4, 2, 12, 5, tzinfo=timezone.utc),
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

            processing = ExtensionBrowserProcessingService(session)
            next_task = await processing.next_task()

            assert first_session.category is None
            assert first_session.last_processed_at is None
            assert second_session.category is None
            assert second_session.last_processed_at is None
            assert next_task.available is True
            assert next_task.task_count == 2
            assert [task.session_id for task in next_task.tasks] == [second_session.id, first_session.id]
            assert next_task.worker_model == "browser-gemini"
            assert "Use fast mode." in (next_task.prompt or "")
            assert '"task_key":"task_1"' in (next_task.prompt or "")
            assert '"task_key":"task_2"' in (next_task.prompt or "")
            assert '"source_session_id":"source-session-1"' in (next_task.prompt or "")
            assert '"source_session_id":"source-session-2"' in (next_task.prompt or "")
    finally:
        get_settings.cache_clear()

    await engine.dispose()


@pytest.mark.asyncio
async def test_ingest_updates_shared_todo_list_and_versions_vault(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-todo-ingest.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "heuristic")
    monkeypatch.setenv("SAVEMYCONTEXT_MARKDOWN_DIR", str(tmp_path / "markdown"))
    get_settings.cache_clear()

    try:
        async with session_factory() as session:
            service = IngestService(session)
            service.exporter.base_dir = tmp_path / "markdown"
            TodoListService(base_dir=service.exporter.base_dir).write_markdown(
                "# To-Do List\n\n## Active\n- [ ] File taxes\n\n## Done\n"
            )

            stored_session, _ = await service.ingest(
                IngestDiffRequest(
                    provider=ProviderName.GEMINI,
                    external_session_id="todo-session-1",
                    sync_mode="full_snapshot",
                    title="Update to-do list",
                    source_url="https://gemini.google.com/app/todo-session-1",
                    captured_at=datetime(2026, 4, 14, 12, 0, tzinfo=timezone.utc),
                    messages=[
                        IngestMessage(
                            external_message_id="msg-1",
                            role=MessageRole.USER,
                            content="Add buy milk to my to-do list and mark file taxes as done.",
                        )
                    ],
                    raw_capture={"source": "test"},
                )
            )

            todo_path = TodoListService(base_dir=service.exporter.base_dir).path
            todo_markdown = todo_path.read_text(encoding="utf-8")

            assert stored_session.category == SessionCategory.TODO
            assert stored_session.todo_summary is not None
            assert "buy milk" in stored_session.todo_summary.lower()
            assert "- [ ] buy milk" in todo_markdown
            assert "- [x] File taxes" in todo_markdown
            assert (service.exporter.vault_root / ".git").exists()

            if shutil.which("git"):
                log = subprocess.run(
                    ["git", "log", "--oneline", "-1"],
                    cwd=service.exporter.vault_root,
                    check=True,
                    capture_output=True,
                    text=True,
                )
                assert "Update to-do list from gemini:todo-session-1" in log.stdout
    finally:
        get_settings.cache_clear()

    await engine.dispose()
