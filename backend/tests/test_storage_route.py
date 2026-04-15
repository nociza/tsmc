from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.routes_dashboard import router as dashboard_router
from app.cli_config import default_cli_config, merge_cli_config, save_cli_config
from app.cli_paths import CLIPaths
from app.core.config import get_settings
from app.db.session import get_db_session
from app.models import ChatSession
from app.models.base import Base
from app.models.enums import MessageRole, ProviderName
from app.schemas.ingest import IngestDiffRequest, IngestMessage
from app.services.ingest import IngestService


@pytest.mark.asyncio
async def test_storage_route_rebuilds_vault_in_new_root(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-storage-route.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    config_dir = tmp_path / "config"
    data_dir = tmp_path / "data"
    old_markdown_root = tmp_path / "old-markdown"
    new_markdown_root = tmp_path / "new-markdown"
    cli_paths = CLIPaths(
        config_dir=config_dir,
        config_path=config_dir / "config.toml",
        env_path=config_dir / "savemycontext.env",
        data_dir=data_dir,
        markdown_dir=old_markdown_root,
        database_path=data_dir / "savemycontext.db",
        systemd_user_dir=tmp_path / "systemd-user",
        unit_path=tmp_path / "systemd-user" / "savemycontext.service",
    )
    config = merge_cli_config(default_cli_config(cli_paths), data_dir=data_dir, markdown_dir=old_markdown_root)
    save_cli_config(config, cli_paths.config_path)

    monkeypatch.setenv("SAVEMYCONTEXT_CLI_CONFIG_PATH", str(cli_paths.config_path))
    monkeypatch.setenv("SAVEMYCONTEXT_MARKDOWN_DIR", str(old_markdown_root))
    monkeypatch.setenv("SAVEMYCONTEXT_LLM_BACKEND", "heuristic")
    get_settings.cache_clear()

    try:
        async with session_factory() as db_session:
            service = IngestService(db_session)
            service.exporter.base_dir = old_markdown_root
            stored_session, _ = await service.ingest(
                IngestDiffRequest(
                    provider=ProviderName.GEMINI,
                    external_session_id="storage-route-session",
                    sync_mode="full_snapshot",
                    title="Storage Route Session",
                    source_url="https://gemini.google.com/app/storage-route-session",
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
            old_path = Path(stored_session.markdown_path or "")
            assert old_path.exists()

        app = FastAPI()
        app.include_router(dashboard_router, prefix="/api/v1")

        async def override_db_session():
            async with session_factory() as session:
                yield session

        app.dependency_overrides[get_db_session] = override_db_session

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:18888") as client:
            current_response = await client.get("/api/v1/system/storage")
            assert current_response.status_code == 200
            assert current_response.json()["markdown_root"] == str(old_markdown_root.resolve())

            response = await client.post(
                "/api/v1/system/storage",
                json={
                    "markdown_root": str(new_markdown_root)
                },
            )

        assert response.status_code == 200
        payload = response.json()
        assert payload["markdown_root"] == str(new_markdown_root.resolve())
        assert payload["vault_root"].endswith("/SaveMyContext")
        assert payload["regenerated_session_count"] == 1
        assert payload["persistence_kind"] == "cli_config"

        vault_root = new_markdown_root / "SaveMyContext"
        assert (vault_root / "README.md").exists()
        assert (vault_root / "AGENTS.md").exists()
        assert (vault_root / "manifest.json").exists()
        assert (vault_root / "Dashboards" / "Home.md").exists()
        assert (vault_root / "Sources" / "gemini--storage-route-session--source.md").exists()
        assert (vault_root / "Factual" / "gemini--storage-route-session.md").exists()
        assert str(new_markdown_root.resolve()) in cli_paths.config_path.read_text(encoding="utf-8")

        async with session_factory() as db_session:
            session_record = await db_session.scalar(
                select(ChatSession).where(ChatSession.external_session_id == "storage-route-session")
            )
            assert session_record is not None
            assert session_record.markdown_path == str(vault_root / "Factual" / "gemini--storage-route-session.md")
    finally:
        get_settings.cache_clear()

    await engine.dispose()
