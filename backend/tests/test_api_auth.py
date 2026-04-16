from __future__ import annotations

import pytest
from fastapi import Depends, FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.dependencies import AuthContext, require_scope
from app.db.session import get_db_session
from app.models.base import Base
from app.services.auth import create_api_token, ensure_admin_user


async def _issue_token(
    session_factory: async_sessionmaker,
    *,
    scopes: list[str],
) -> str:
    async with session_factory() as session:
        await ensure_admin_user(
            session,
            username="admin",
            password="correct horse battery staple",
        )

    async with session_factory() as session:
        created = await create_api_token(
            session,
            username="admin",
            name="test-client",
            scopes=scopes,
        )
        return created.plain_text


def _build_test_app(session_factory: async_sessionmaker) -> FastAPI:
    app = FastAPI()

    async def override_db_session():
        async with session_factory() as session:
            yield session

    @app.get("/protected")
    async def protected(_: AuthContext = Depends(require_scope("read"))) -> dict[str, bool]:
        return {"ok": True}

    app.dependency_overrides[get_db_session] = override_db_session
    return app


@pytest.mark.asyncio
async def test_loopback_bootstrap_access_requires_no_token_when_backend_is_unconfigured(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-bootstrap-auth.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    app = _build_test_app(session_factory)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:18888") as client:
        response = await client.get("/protected")

    assert response.status_code == 200
    assert response.json() == {"ok": True}

    await engine.dispose()


@pytest.mark.asyncio
async def test_remote_host_does_not_receive_bootstrap_access_even_if_backend_sees_a_loopback_peer(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-remote-bootstrap-auth.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    app = _build_test_app(session_factory)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="https://notes.example.com") as client:
        response = await client.get("/protected")

    assert response.status_code == 401
    assert response.json()["detail"] == "A SaveMyContext app token is required."

    await engine.dispose()


@pytest.mark.asyncio
async def test_loopback_access_requires_a_token_once_any_token_exists(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-loopback-auth.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    app = _build_test_app(session_factory)
    token = await _issue_token(session_factory, scopes=["read"])

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:18888") as client:
        unauthorized = await client.get("/protected")
        authorized = await client.get("/protected", headers={"Authorization": f"Bearer {token}"})

    assert unauthorized.status_code == 401
    assert authorized.status_code == 200
    assert authorized.json() == {"ok": True}

    await engine.dispose()
