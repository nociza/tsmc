from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.models import ChatMessage, ChatSession, FactTriplet, MessageRole, ProviderName, SessionCategory, SourceCapture
from app.models.base import Base
from app.services.agentic_search import AgenticSearchCandidate
from app.services.graph import GraphService
from app.services.search import SearchService
from app.services.todo import TodoListService


@pytest.mark.asyncio
async def test_search_and_graph_services_return_agent_friendly_results(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-search.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        chat_session = ChatSession(
            provider=ProviderName.GEMINI,
            external_session_id="session-1",
            title="SQLite search design",
            category=SessionCategory.FACTUAL,
            last_captured_at=datetime.now(timezone.utc),
        )
        session.add(chat_session)
        await session.flush()
        session.add_all(
            [
                ChatMessage(
                    session_id=chat_session.id,
                    external_message_id="msg-1",
                    role=MessageRole.USER,
                    content="How should SaveMyContext store notes in SQLite?",
                    sequence_index=1,
                ),
                FactTriplet(
                    session_id=chat_session.id,
                    subject="SQLite",
                    predicate="stores",
                    object="SaveMyContext notes",
                    confidence=0.9,
                ),
            ]
        )
        await session.commit()

    async with session_factory() as session:
        search = await SearchService(session).search("SQLite")
        nodes = await GraphService(session).nodes()
        edges = await GraphService(session).edges()

        assert any(result.kind == "session" and result.title == "SQLite search design" for result in search.results)
        assert any(result.kind == "entity" and result.title == "SQLite" for result in search.results)
        assert any(node.label == "SQLite" for node in nodes)
        assert any(edge.predicate == "stores" for edge in edges)

    await engine.dispose()


@pytest.mark.asyncio
async def test_search_includes_shared_todo_list(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-search-todo.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_MARKDOWN_DIR", str(tmp_path / "markdown"))
    get_settings.cache_clear()
    try:
        todo_service = TodoListService()
        todo_service.write_markdown("# To-Do List\n\n## Active\n- [ ] Buy milk\n\n## Done\n")

        async with session_factory() as session:
            search = await SearchService(session).search("milk")
            assert any(result.kind == "todo_list" and result.title == "To-Do List" for result in search.results)
    finally:
        get_settings.cache_clear()

    await engine.dispose()


@pytest.mark.asyncio
async def test_search_reads_session_markdown_files_with_shell_search(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-search-markdown.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_MARKDOWN_DIR", str(tmp_path / "markdown"))
    get_settings.cache_clear()
    try:
        note_path = tmp_path / "markdown" / "SaveMyContext" / "Factual" / "storage-note.md"
        note_path.parent.mkdir(parents=True, exist_ok=True)
        note_path.write_text(
            "# Storage internals\n\nThis note mentions zero-copy indexes for compact search.\n",
            encoding="utf-8",
        )

        async with session_factory() as session:
            chat_session = ChatSession(
                provider=ProviderName.CHATGPT,
                external_session_id="session-markdown-only",
                title="Storage internals",
                category=SessionCategory.FACTUAL,
                markdown_path=str(note_path),
                last_captured_at=datetime.now(timezone.utc),
            )
            session.add(chat_session)
            await session.commit()
            session_id = chat_session.id

        async with session_factory() as session:
            search = await SearchService(session).search("zero-copy indexes")
            assert any(result.session_id == session_id for result in search.results)
            assert any("zero-copy" in result.snippet.lower() for result in search.results if result.session_id == session_id)
    finally:
        get_settings.cache_clear()

    await engine.dispose()


@pytest.mark.asyncio
async def test_search_reads_capture_source_files_with_shell_search(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-search-captures.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_MARKDOWN_DIR", str(tmp_path / "markdown"))
    get_settings.cache_clear()
    try:
        capture_note_path = tmp_path / "markdown" / "SaveMyContext" / "Captures" / "page--systems-note--12345678.md"
        raw_source_path = tmp_path / "markdown" / "SaveMyContext" / "Captures" / "page--systems-note--12345678--source.md"
        capture_note_path.parent.mkdir(parents=True, exist_ok=True)
        capture_note_path.write_text("# Systems note\n\nDurable queues.\n", encoding="utf-8")
        raw_source_path.write_text(
            "# Source Document\n\nAn obscure cap theorem footnote lives here.\n",
            encoding="utf-8",
        )

        async with session_factory() as session:
            source_capture = SourceCapture(
                capture_kind="page",
                save_mode="raw",
                title="Systems note",
                source_text="Durable queues.",
                markdown_path=str(capture_note_path),
                raw_source_path=str(raw_source_path),
            )
            session.add(source_capture)
            await session.commit()
            source_id = source_capture.id

        async with session_factory() as session:
            search = await SearchService(session).search("cap theorem footnote")
            assert any(result.kind == "source_capture" and result.source_id == source_id for result in search.results)
            assert any(
                "cap theorem footnote" in result.snippet.lower()
                for result in search.results
                if result.source_id == source_id
            )
    finally:
        get_settings.cache_clear()

    await engine.dispose()


@pytest.mark.asyncio
async def test_search_uses_adk_candidates_when_google_is_configured(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-search-adk.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_MARKDOWN_DIR", str(tmp_path / "markdown"))
    monkeypatch.setenv("SAVEMYCONTEXT_GOOGLE_API_KEY", "test-google-key")
    get_settings.cache_clear()
    try:
        note_path = tmp_path / "markdown" / "SaveMyContext" / "Factual" / "adk-note.md"
        note_path.parent.mkdir(parents=True, exist_ok=True)
        note_path.write_text("# ADK note\n\nSearch result chosen by the fake ADK service.\n", encoding="utf-8")

        async with session_factory() as session:
            chat_session = ChatSession(
                provider=ProviderName.GEMINI,
                external_session_id="session-adk-only",
                title="ADK note",
                category=SessionCategory.FACTUAL,
                markdown_path=str(note_path),
                last_captured_at=datetime.now(timezone.utc),
            )
            session.add(chat_session)
            await session.commit()
            session_id = chat_session.id

        class FakeADKVaultSearchService:
            def __init__(self, settings=None) -> None:
                self.settings = settings

            async def search(self, query: str, *, limit: int = 10) -> list[AgenticSearchCandidate]:
                assert query == "rare adk token"
                assert limit >= 24
                return [
                    AgenticSearchCandidate(
                        path=str(note_path.resolve()),
                        reason="ADK selected the best matching note.",
                        snippet="ADK snippet for a query that is not in the database.",
                    )
                ]

        monkeypatch.setattr("app.services.search.ADKVaultSearchService", FakeADKVaultSearchService)

        async with session_factory() as session:
            search = await SearchService(session).search("rare adk token")
            assert any(result.session_id == session_id for result in search.results)
            assert any(
                "adk snippet" in result.snippet.lower()
                for result in search.results
                if result.session_id == session_id
            )
    finally:
        get_settings.cache_clear()

    await engine.dispose()


@pytest.mark.asyncio
async def test_graph_keeps_distinct_entities_that_share_the_same_human_slug(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-search-collisions.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        chat_session = ChatSession(
            provider=ProviderName.GEMINI,
            external_session_id="session-collisions",
            title="Language collisions",
            category=SessionCategory.FACTUAL,
            last_captured_at=datetime.now(timezone.utc),
        )
        session.add(chat_session)
        await session.flush()
        session.add_all(
            [
                FactTriplet(
                    session_id=chat_session.id,
                    subject="C",
                    predicate="differs_from",
                    object="C#",
                    confidence=0.8,
                ),
                FactTriplet(
                    session_id=chat_session.id,
                    subject="C++",
                    predicate="differs_from",
                    object="C",
                    confidence=0.8,
                ),
            ]
        )
        await session.commit()

    async with session_factory() as session:
        nodes = await GraphService(session).nodes()

        c_family_nodes = {node.label: node for node in nodes if node.label in {"C", "C#", "C++"}}
        assert set(c_family_nodes) == {"C", "C#", "C++"}
        assert len({node.id for node in c_family_nodes.values()}) == 3
        assert len({node.note_path for node in c_family_nodes.values()}) == 3

    await engine.dispose()
