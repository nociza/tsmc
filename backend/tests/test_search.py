from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.models import ChatMessage, ChatSession, FactTriplet, MessageRole, ProviderName, SessionCategory
from app.models.base import Base
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
