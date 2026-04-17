from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.routes_dashboard import router as dashboard_router
from app.api.routes_sessions import router as sessions_router
from app.core.config import get_settings
from app.db.session import get_db_session
from app.models import ChatMessage, ChatSession, FactTriplet, MessageRole, ProviderName, SessionCategory
from app.models.base import Base


@pytest.mark.asyncio
async def test_category_routes_expose_stats_graph_search_and_note_content(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-explorer-routes.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    markdown_root = tmp_path / "markdown"
    vault_root = markdown_root / "SaveMyContext"
    monkeypatch.setenv("SAVEMYCONTEXT_MARKDOWN_DIR", str(markdown_root))
    get_settings.cache_clear()

    try:
        factual_note_path = vault_root / "Factual" / "gemini--sqlite-search-design.md"
        factual_note_path.parent.mkdir(parents=True, exist_ok=True)
        factual_note_path.write_text(
            "# SQLite Search Design\n\n## Fact Triplets\n\n- SQLite | stores | notes\n",
            encoding="utf-8",
        )

        async with session_factory() as session:
            factual_session = ChatSession(
                provider=ProviderName.GEMINI,
                external_session_id="session-factual",
                title="SQLite search design",
                category=SessionCategory.FACTUAL,
                markdown_path=str(factual_note_path),
                source_url="https://example.com/sqlite",
                classification_reason="Grounded factual note.",
                share_post="SQLite helps keep note search local.",
                custom_tags=["savemycontext", "database", "search"],
                last_captured_at=datetime(2026, 4, 15, 20, 0, tzinfo=timezone.utc),
                updated_at=datetime(2026, 4, 15, 20, 0, tzinfo=timezone.utc),
            )
            idea_session_one = ChatSession(
                provider=ProviderName.GEMINI,
                external_session_id="session-idea-1",
                title="Capability badge workflow",
                category=SessionCategory.IDEAS,
                source_url="https://example.com/badge",
                idea_summary={
                    "core_idea": "Build a workflow badge for the agent.",
                    "pros": ["Clear workflow signal"],
                    "cons": ["Needs governance"],
                    "next_steps": ["Prototype the workflow graph"],
                },
                share_post="A workflow badge could travel with the agent.",
                last_captured_at=datetime(2026, 4, 14, 18, 0, tzinfo=timezone.utc),
                updated_at=datetime(2026, 4, 14, 18, 0, tzinfo=timezone.utc),
            )
            idea_session_two = ChatSession(
                provider=ProviderName.GROK,
                external_session_id="session-idea-2",
                title="Workflow graph for capability pages",
                category=SessionCategory.IDEAS,
                source_url="https://example.com/workflow-graph",
                idea_summary={
                    "core_idea": "Use a graph to connect capability pages and workflow notes.",
                    "pros": ["Makes workflow relationships visible"],
                    "cons": ["Adds visual complexity"],
                    "next_steps": ["Link workflow terms across notes"],
                },
                last_captured_at=datetime(2026, 4, 13, 18, 0, tzinfo=timezone.utc),
                updated_at=datetime(2026, 4, 13, 18, 0, tzinfo=timezone.utc),
            )
            session.add_all([factual_session, idea_session_one, idea_session_two])
            await session.flush()
            session.add_all(
                [
                    ChatMessage(
                        session_id=factual_session.id,
                        external_message_id="msg-1",
                        role=MessageRole.USER,
                        content="How should SaveMyContext search SQLite-backed notes?",
                        sequence_index=1,
                    ),
                    ChatMessage(
                        session_id=factual_session.id,
                        external_message_id="msg-2",
                        role=MessageRole.ASSISTANT,
                        content="SQLite can store notes and keep search local.",
                        sequence_index=2,
                    ),
                    FactTriplet(
                        session_id=factual_session.id,
                        subject="SQLite",
                        predicate="stores",
                        object="notes",
                        confidence=0.9,
                    ),
                    FactTriplet(
                        session_id=factual_session.id,
                        subject="Search",
                        predicate="uses",
                        object="SQLite",
                        confidence=0.8,
                    ),
                ]
            )
            await session.commit()

            factual_session_id = factual_session.id

        app = FastAPI()
        app.include_router(dashboard_router, prefix="/api/v1")
        app.include_router(sessions_router, prefix="/api/v1")

        async def override_db_session():
            async with session_factory() as session:
                yield session

        app.dependency_overrides[get_db_session] = override_db_session

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:18888") as client:
            stats_response = await client.get("/api/v1/categories/factual/stats")
            graph_response = await client.get("/api/v1/categories/factual/graph")
            ideas_graph_response = await client.get("/api/v1/categories/ideas/graph")
            search_response = await client.get(
                "/api/v1/search",
                params={"q": "workflow", "category": "ideas", "provider": "gemini"},
            )
            note_response = await client.get(f"/api/v1/notes/{factual_session_id}")

        assert stats_response.status_code == 200
        stats_payload = stats_response.json()
        assert stats_payload["total_sessions"] == 1
        assert stats_payload["total_messages"] == 2
        assert stats_payload["total_triplets"] == 2
        assert stats_payload["top_entities"][0]["label"] == "SQLite"
        assert stats_payload["top_tags"][0]["label"] == "database"

        assert graph_response.status_code == 200
        graph_payload = graph_response.json()
        assert graph_payload["category"] == "factual"
        assert any(node["label"] == "SQLite" and factual_session_id in node["session_ids"] for node in graph_payload["nodes"])
        assert any(edge["label"] == "stores" for edge in graph_payload["edges"])

        assert ideas_graph_response.status_code == 200
        ideas_graph_payload = ideas_graph_response.json()
        assert ideas_graph_payload["category"] == "ideas"
        assert all(node["kind"] == "session" for node in ideas_graph_payload["nodes"])
        assert ideas_graph_payload["edge_count"] >= 1

        assert search_response.status_code == 200
        search_payload = search_response.json()
        assert search_payload["count"] >= 1
        assert all(result["category"] == "ideas" for result in search_payload["results"])
        assert all(result.get("provider") in {"gemini", None} for result in search_payload["results"])

        assert note_response.status_code == 200
        note_payload = note_response.json()
        assert note_payload["id"] == factual_session_id
        assert "SQLite | stores | notes" in note_payload["raw_markdown"]
        assert "SQLite" in note_payload["related_entities"]
        assert note_payload["word_count"] > 0
    finally:
        get_settings.cache_clear()

    await engine.dispose()


@pytest.mark.asyncio
async def test_custom_category_routes_allow_user_defined_groupings(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-custom-categories.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    markdown_root = tmp_path / "markdown"
    vault_root = markdown_root / "SaveMyContext"
    monkeypatch.setenv("SAVEMYCONTEXT_MARKDOWN_DIR", str(markdown_root))
    get_settings.cache_clear()

    try:
        factual_note_path = vault_root / "Factual" / "architecture-evidence.md"
        factual_note_path.parent.mkdir(parents=True, exist_ok=True)
        factual_note_path.write_text(
            "# Architecture Evidence\n\n## Fact Triplets\n\n- Context graph | supports | architecture reviews\n",
            encoding="utf-8",
        )

        async with session_factory() as session:
            factual_primary = ChatSession(
                provider=ProviderName.CHATGPT,
                external_session_id="custom-factual-1",
                title="Architecture evidence",
                category=SessionCategory.FACTUAL,
                markdown_path=str(factual_note_path),
                share_post="Architecture reviews need evidence connected back to the context graph.",
                custom_tags=["systems", "category:Architecture Review"],
                last_captured_at=datetime(2026, 4, 16, 18, 0, tzinfo=timezone.utc),
                updated_at=datetime(2026, 4, 16, 18, 0, tzinfo=timezone.utc),
            )
            factual_support = ChatSession(
                provider=ProviderName.GEMINI,
                external_session_id="custom-factual-2",
                title="Platform topology",
                category=SessionCategory.FACTUAL,
                share_post="Platform topology should stay searchable during architecture reviews.",
                custom_tags=["topology", "category:Architecture Review"],
                last_captured_at=datetime(2026, 4, 15, 18, 0, tzinfo=timezone.utc),
                updated_at=datetime(2026, 4, 15, 18, 0, tzinfo=timezone.utc),
            )
            idea_session = ChatSession(
                provider=ProviderName.GROK,
                external_session_id="custom-idea-1",
                title="Architecture review workflow",
                category=SessionCategory.IDEAS,
                share_post="Prototype a review workflow that groups related notes under Architecture Review.",
                custom_tags=["workflow", "category:Architecture Review"],
                idea_summary={
                    "core_idea": "Use user-defined categories to group architecture review sessions.",
                    "pros": ["Lets teams review related notes together"],
                    "cons": ["Needs clean taxonomy rules"],
                    "next_steps": ["Ship custom category browsing"],
                },
                last_captured_at=datetime(2026, 4, 14, 18, 0, tzinfo=timezone.utc),
                updated_at=datetime(2026, 4, 14, 18, 0, tzinfo=timezone.utc),
            )
            launch_session = ChatSession(
                provider=ProviderName.CHATGPT,
                external_session_id="custom-todo-1",
                title="Launch board",
                category=SessionCategory.TODO,
                share_post="Launch notes stay in a separate custom category.",
                todo_summary="Track launch blockers and approvals.",
                custom_tags=["release", "category:Launch"],
                last_captured_at=datetime(2026, 4, 13, 18, 0, tzinfo=timezone.utc),
                updated_at=datetime(2026, 4, 13, 18, 0, tzinfo=timezone.utc),
            )
            session.add_all([factual_primary, factual_support, idea_session, launch_session])
            await session.flush()
            session.add_all(
                [
                    ChatMessage(
                        session_id=factual_primary.id,
                        external_message_id="custom-msg-1",
                        role=MessageRole.USER,
                        content="How do we structure the architecture review corpus?",
                        sequence_index=1,
                    ),
                    ChatMessage(
                        session_id=idea_session.id,
                        external_message_id="custom-msg-2",
                        role=MessageRole.ASSISTANT,
                        content="Group the review sessions under a shared custom category.",
                        sequence_index=1,
                    ),
                    FactTriplet(
                        session_id=factual_primary.id,
                        subject="Context graph",
                        predicate="supports",
                        object="architecture reviews",
                        confidence=0.92,
                    ),
                    FactTriplet(
                        session_id=factual_support.id,
                        subject="Platform topology",
                        predicate="stays_searchable_for",
                        object="architecture reviews",
                        confidence=0.87,
                    ),
                ]
            )
            await session.commit()

            factual_primary_id = factual_primary.id

        app = FastAPI()
        app.include_router(dashboard_router, prefix="/api/v1")
        app.include_router(sessions_router, prefix="/api/v1")

        async def override_db_session():
            async with session_factory() as session:
                yield session

        app.dependency_overrides[get_db_session] = override_db_session

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:18888") as client:
            categories_response = await client.get("/api/v1/user-categories")
            factual_categories_response = await client.get("/api/v1/user-categories", params={"category": "factual"})
            sessions_response = await client.get("/api/v1/sessions", params={"user_category": "Architecture Review"})
            stats_response = await client.get("/api/v1/custom-categories/Architecture%20Review/stats")
            graph_response = await client.get("/api/v1/custom-categories/Architecture%20Review/graph")
            search_response = await client.get("/api/v1/search", params={"q": "architecture", "user_category": "Architecture Review"})
            update_response = await client.put(
                f"/api/v1/sessions/{factual_primary_id}/user-categories",
                json={"user_categories": ["Architecture Review", "Platform Work"]},
            )
            reserved_response = await client.put(
                f"/api/v1/sessions/{factual_primary_id}/user-categories",
                json={"user_categories": ["todo"]},
            )

        assert categories_response.status_code == 200
        category_payload = categories_response.json()
        assert category_payload[0] == {"name": "Architecture Review", "count": 3}
        assert {"name": "Launch", "count": 1} in category_payload

        assert factual_categories_response.status_code == 200
        assert factual_categories_response.json() == [{"name": "Architecture Review", "count": 2}]

        assert sessions_response.status_code == 200
        session_payload = sessions_response.json()
        assert len(session_payload) == 3
        assert all("Architecture Review" in item["user_categories"] for item in session_payload)
        assert all("category:Architecture Review" not in item["custom_tags"] for item in session_payload)

        assert stats_response.status_code == 200
        stats_payload = stats_response.json()
        assert stats_payload["scope_kind"] == "custom"
        assert stats_payload["scope_label"] == "Architecture Review"
        assert stats_payload["dominant_category"] == "factual"
        assert stats_payload["total_sessions"] == 3
        assert stats_payload["total_messages"] == 2
        assert stats_payload["total_triplets"] == 2
        assert {item["category"]: item["count"] for item in stats_payload["system_category_counts"]} == {
            "factual": 2,
            "ideas": 1,
        }

        assert graph_response.status_code == 200
        graph_payload = graph_response.json()
        assert graph_payload["scope_kind"] == "custom"
        assert graph_payload["scope_label"] == "Architecture Review"
        assert graph_payload["dominant_category"] == "factual"
        assert graph_payload["node_count"] >= 3
        assert all(node["kind"] == "session" for node in graph_payload["nodes"])

        assert search_response.status_code == 200
        search_payload = search_response.json()
        assert search_payload["count"] >= 1
        assert all("Architecture Review" in result["user_categories"] for result in search_payload["results"])

        assert update_response.status_code == 200
        updated_session = update_response.json()
        assert updated_session["user_categories"] == ["Architecture Review", "Platform Work"]
        assert updated_session["custom_tags"] == ["systems"]

        assert reserved_response.status_code == 422
        assert "reserved" in reserved_response.text
    finally:
        get_settings.cache_clear()

    await engine.dispose()
