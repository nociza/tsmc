from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models import APIToken, User
from app.models.base import Base
from app.services.auth import create_api_token, ensure_admin_user, revoke_api_token, verify_password


@pytest.mark.asyncio
async def test_admin_bootstrap_and_token_lifecycle(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-auth.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        user = await ensure_admin_user(
            session,
            username="admin",
            password="correct horse battery staple",
        )
        assert user.is_admin is True
        assert verify_password("correct horse battery staple", user.password_hash) is True

    async with session_factory() as session:
        created = await create_api_token(
            session,
            username="admin",
            name="chrome-extension",
            scopes=["ingest", "read"],
        )
        assert created.plain_text.startswith("savemycontext_pat_")
        assert created.token.scopes == ["ingest", "read"]

    async with session_factory() as session:
        token = await session.scalar(select(APIToken))
        assert token is not None
        revoked = await revoke_api_token(session, token_id=token.id)
        assert revoked.is_active is False
        assert revoked.revoked_at is not None

    async with session_factory() as session:
        stored_user = await session.scalar(select(User).where(User.username == "admin"))
        assert stored_user is not None

    await engine.dispose()
