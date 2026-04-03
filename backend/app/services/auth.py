from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass

from pwdlib import PasswordHash
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import APIToken, User
from app.models.base import utcnow


password_hasher = PasswordHash.recommended()


@dataclass(frozen=True)
class CreatedToken:
    token: APIToken
    plain_text: str


def hash_password(password: str) -> str:
    return password_hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return password_hasher.verify(password, password_hash)


def hash_api_token_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def build_plain_text_token(token_id: str, secret: str) -> str:
    return f"tsmc_pat_{token_id}_{secret}"


async def ensure_admin_user(
    db: AsyncSession,
    *,
    username: str,
    password: str,
    force: bool = False,
) -> User:
    result = await db.execute(select(User).order_by(User.created_at.asc()))
    existing_users = result.scalars().all()
    if existing_users and not force:
        raise RuntimeError("An admin user already exists. Re-run with --force if you need to replace it.")

    if existing_users and force:
        for user in existing_users:
            await db.delete(user)
        await db.flush()

    user = User(
        username=username.strip(),
        password_hash=hash_password(password),
        is_admin=True,
        is_active=True,
    )
    db.add(user)
    await db.flush()
    await db.commit()
    await db.refresh(user)
    return user


async def create_api_token(
    db: AsyncSession,
    *,
    username: str,
    name: str,
    scopes: list[str],
) -> CreatedToken:
    result = await db.execute(select(User).where(User.username == username))
    user = result.scalar_one_or_none()
    if user is None:
        raise RuntimeError(f"User not found: {username}")

    secret = secrets.token_urlsafe(24)
    token = APIToken(
        user_id=user.id,
        name=name.strip(),
        token_prefix=secret[:8],
        token_hash=hash_api_token_secret(secret),
        scopes=sorted(set(scopes)),
        is_active=True,
    )
    db.add(token)
    await db.flush()
    plain_text = build_plain_text_token(token.id, secret)
    await db.commit()
    await db.refresh(token)
    return CreatedToken(token=token, plain_text=plain_text)


async def revoke_api_token(db: AsyncSession, *, token_id: str) -> APIToken:
    result = await db.execute(select(APIToken).where(APIToken.id == token_id))
    token = result.scalar_one_or_none()
    if token is None:
        raise RuntimeError(f"Token not found: {token_id}")
    token.is_active = False
    token.revoked_at = utcnow()
    await db.commit()
    await db.refresh(token)
    return token
