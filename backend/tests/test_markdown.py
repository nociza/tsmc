from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models import FactTriplet, SyncEvent
from app.models.base import Base
from app.models import ChatMessage, ChatSession, MessageRole, ProviderName, SessionCategory
from app.services.markdown import MarkdownExporter


def test_markdown_renderer_includes_transcript() -> None:
    session = ChatSession(
        provider=ProviderName.CHATGPT,
        external_session_id="session-1",
        title="Test Session",
        category=SessionCategory.JOURNAL,
        custom_tags=["daily"],
        last_captured_at=datetime.now(timezone.utc),
    )
    session.messages = [
        ChatMessage(
            session_id="session-1",
            external_message_id="m-1",
            role=MessageRole.USER,
            content="Need to review the project plan.",
            sequence_index=1,
        )
    ]

    markdown = MarkdownExporter().render(session)
    assert "# Test Session" in markdown
    assert "## Source" in markdown
    assert "Source Document" in markdown
    assert "## Transcript" in markdown
    assert "Need to review the project plan." in markdown


def test_markdown_renderer_includes_todo_update_link() -> None:
    session = ChatSession(
        provider=ProviderName.GEMINI,
        external_session_id="todo-session-1",
        title="Update shared tasks",
        category=SessionCategory.TODO,
        todo_summary="Added 'Buy milk' and marked 'File taxes' done.",
        last_captured_at=datetime.now(timezone.utc),
    )
    session.messages = [
        ChatMessage(
            session_id="todo-session-1",
            external_message_id="m-1",
            role=MessageRole.USER,
            content="Add buy milk to my to-do list.",
            sequence_index=1,
        )
    ]

    markdown = MarkdownExporter().render(session)
    assert "## To-Do Update" in markdown
    assert "Buy milk" in markdown
    assert "Dashboards/To-Do List" in markdown
    assert "[[SaveMyContext/" not in markdown


def test_markdown_renderer_formats_idea_summary_for_humans() -> None:
    session = ChatSession(
        provider=ProviderName.GEMINI,
        external_session_id="idea-session-1",
        title="Idea Session",
        category=SessionCategory.IDEAS,
        idea_summary={
            "core_idea": "Turn AI chats into organized notes.",
            "pros": ["Private by default", "Searchable knowledge"],
            "cons": ["Requires a local backend"],
            "next_steps": ["Test with real users"],
        },
        share_post="Turn your AI chats into organized notes without leaving them trapped in a vendor UI.",
        last_captured_at=datetime.now(timezone.utc),
    )

    markdown = MarkdownExporter().render(session)

    assert "### Core Idea" in markdown
    assert "- Private by default" in markdown
    assert "- Requires a local backend" in markdown
    assert "- Test with real users" in markdown
    assert "```json" not in markdown


def test_source_markdown_renderer_includes_raw_payloads_and_sync_captures() -> None:
    session = ChatSession(
        provider=ProviderName.GEMINI,
        external_session_id="source-session-1",
        title="Source Session",
        category=SessionCategory.FACTUAL,
        source_url="https://gemini.google.com/app/source-session-1",
        last_captured_at=datetime.now(timezone.utc),
    )
    session.messages = [
        ChatMessage(
            session_id="source-session-1",
            external_message_id="m-1",
            role=MessageRole.USER,
            content="Explain FastAPI and uvloop.",
            sequence_index=1,
            raw_payload={"messageId": "m-1", "chunks": ["Explain FastAPI and uvloop."]},
        )
    ]
    session.sync_events = [
        SyncEvent(
            session_id="source-session-1",
            message_count=1,
            raw_capture={"provider": "gemini", "snapshot": {"messages": 1}},
        )
    ]

    markdown = MarkdownExporter().render_source(session)

    assert "# Source Document: Source Session" in markdown
    assert "## Raw Sync Captures" in markdown
    assert "\"provider\": \"gemini\"" in markdown
    assert "## Raw Message Payloads" in markdown
    assert "\"messageId\": \"m-1\"" in markdown
    assert "Explain FastAPI and uvloop." in markdown


@pytest.mark.asyncio
async def test_markdown_export_handles_mixed_naive_and_aware_session_timestamps(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-markdown-timezones.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        aware_session = ChatSession(
            provider=ProviderName.GEMINI,
            external_session_id="aware-session",
            title="Aware Session",
            category=SessionCategory.FACTUAL,
            source_url="https://gemini.google.com/app/aware-session",
            last_captured_at=datetime(2026, 4, 2, 12, 0, tzinfo=timezone.utc),
        )
        naive_session = ChatSession(
            provider=ProviderName.GEMINI,
            external_session_id="naive-session",
            title="Naive Session",
            category=SessionCategory.FACTUAL,
            source_url="https://gemini.google.com/app/naive-session",
            last_captured_at=datetime(2026, 4, 2, 11, 0),
        )
        aware_session.messages = []
        naive_session.messages = []
        aware_triplet = FactTriplet(
            session=aware_session,
            subject="FastAPI",
            predicate="uses",
            object="uvloop",
            confidence=0.8,
        )
        naive_triplet = FactTriplet(
            session=naive_session,
            subject="FastAPI",
            predicate="supports",
            object="ASGI",
            confidence=0.7,
        )
        aware_session.triplets = [aware_triplet]
        naive_session.triplets = [naive_triplet]
        session.add_all([aware_session, naive_session])
        await session.flush()

        aware_session.updated_at = datetime(2026, 4, 2, 12, 5, tzinfo=timezone.utc)
        naive_session.updated_at = datetime(2026, 4, 2, 11, 5)
        await session.flush()

        exporter = MarkdownExporter(session)
        exporter.base_dir = tmp_path / "markdown"

        output_path = await exporter.write_session(aware_session)
        entity_notes = sorted((exporter.vault_root / "Graph" / "Entities").glob("fastapi--*.md"))
        home_dashboard = exporter.vault_root / "Dashboards" / "Home.md"
        readme = exporter.vault_root / "README.md"
        agents = exporter.vault_root / "AGENTS.md"
        manifest = exporter.vault_root / "manifest.json"

        assert output_path.exists()
        assert len(entity_notes) == 1
        assert home_dashboard.exists()
        assert readme.exists()
        assert agents.exists()
        assert manifest.exists()
        entity_markdown = entity_notes[0].read_text(encoding="utf-8")
        home_markdown = home_dashboard.read_text(encoding="utf-8")
        agents_markdown = agents.read_text(encoding="utf-8")
        manifest_json = manifest.read_text(encoding="utf-8")
        assert "Aware Session" in entity_markdown
        assert "Naive Session" in entity_markdown
        assert "# SaveMyContext Home" in home_markdown
        assert "README" in home_markdown
        assert "# AGENTS" in agents_markdown
        assert "\"entrypoints\"" in manifest_json
        assert "\"home_dashboard\"" in manifest_json

    await engine.dispose()
