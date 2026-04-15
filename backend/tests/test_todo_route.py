from __future__ import annotations

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.routes_todo import router as todo_router
from app.core.config import get_settings
from app.db.session import get_db_session
from app.models.base import Base
from app.services.todo import TodoListService


@pytest.mark.asyncio
async def test_todo_route_returns_shared_document(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-todo-route.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    monkeypatch.setenv("SAVEMYCONTEXT_MARKDOWN_DIR", str(tmp_path / "markdown"))
    get_settings.cache_clear()
    try:
        todo_service = TodoListService()
        todo_service.write_markdown("# To-Do List\n\n## Active\n- [ ] Buy milk\n\n## Done\n")

        app = FastAPI()
        app.include_router(todo_router, prefix="/api/v1")

        async def override_db_session():
            async with session_factory() as session:
                yield session

        app.dependency_overrides[get_db_session] = override_db_session

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:18888") as client:
            response = await client.get("/api/v1/todo")

        assert response.status_code == 200
        payload = response.json()
        assert payload["title"] == "To-Do List"
        assert payload["markdown_path"].endswith("To-Do List.md")
        assert "- [ ] Buy milk" in payload["content"]
    finally:
        get_settings.cache_clear()

    await engine.dispose()
