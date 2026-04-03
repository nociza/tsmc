from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models import ChatMessage, ChatSession, FactTriplet, MessageRole, ProviderName, SessionCategory
from app.models.base import Base
from app.services.graph import GraphService
from app.services.search import SearchService


@pytest.mark.asyncio
async def test_search_and_graph_services_return_agent_friendly_results(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'tsmc-search.db'}")
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
                    content="How should TSMC store notes in SQLite?",
                    sequence_index=1,
                ),
                FactTriplet(
                    session_id=chat_session.id,
                    subject="SQLite",
                    predicate="stores",
                    object="TSMC notes",
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
