from __future__ import annotations

from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db.session import get_db_session
from app.models import APIToken
from app.models.base import utcnow
from app.services.auth import hash_api_token_secret


security = HTTPBearer(auto_error=False)
LOCAL_CLIENT_HOSTS = {"127.0.0.1", "::1", "localhost"}
TOKEN_PREFIX = "savemycontext_"


@dataclass(frozen=True)
class AuthContext:
    token_id: str | None
    token_name: str | None
    username: str | None
    scopes: frozenset[str]
    bootstrap_request: bool = False

    def has_scope(self, scope: str) -> bool:
        return self.bootstrap_request or scope in self.scopes or "*" in self.scopes


def _normalize_host(value: str | None) -> str | None:
    if value is None:
        return None
    return value.removeprefix("[").removesuffix("]").lower()


def is_trusted_loopback_request(request: Request) -> bool:
    client_host = _normalize_host(request.client.host if request.client else None)
    request_host = _normalize_host(request.url.hostname)
    return client_host in LOCAL_CLIENT_HOSTS and request_host in LOCAL_CLIENT_HOSTS


async def _active_token_count(db: AsyncSession) -> int:
    result = await db.execute(
        select(func.count(APIToken.id)).where(
            APIToken.is_active.is_(True),
            APIToken.revoked_at.is_(None),
        )
    )
    return int(result.scalar_one() or 0)


async def authenticate_bearer_token(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None,
    db: AsyncSession,
) -> AuthContext | None:
    if credentials and credentials.scheme.lower() == "bearer":
        token_value = credentials.credentials.strip()
        if not token_value.startswith(TOKEN_PREFIX):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token format.")

        _, _, token_id, secret = token_value.split("_", 3) if token_value.count("_") >= 3 else ("", "", "", "")
        if not token_id or not secret:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token format.")

        result = await db.execute(
            select(APIToken)
            .options(selectinload(APIToken.user))
            .where(
                APIToken.id == token_id,
                APIToken.is_active.is_(True),
                APIToken.revoked_at.is_(None),
            )
        )
        token = result.scalar_one_or_none()
        if token is None or token.token_hash != hash_api_token_secret(secret):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token.")

        token.last_used_at = utcnow()
        await db.flush()
        return AuthContext(
            token_id=token.id,
            token_name=token.name,
            username=token.user.username if token.user else None,
            scopes=frozenset(token.scopes),
            bootstrap_request=False,
        )
    return None


async def require_bearer_token_context(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
    db: AsyncSession = Depends(get_db_session),
) -> AuthContext:
    context = await authenticate_bearer_token(request, credentials, db)
    if context is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="A SaveMyContext app token is required.")
    return context


async def resolve_auth_context(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
    db: AsyncSession = Depends(get_db_session),
) -> AuthContext:
    token_context = await authenticate_bearer_token(request, credentials, db)
    if token_context is not None:
        return token_context

    active_token_count = await _active_token_count(db)
    if active_token_count == 0 and is_trusted_loopback_request(request):
        return AuthContext(token_id=None, token_name=None, username=None, scopes=frozenset({"*"}), bootstrap_request=True)

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="A SaveMyContext app token is required.",
    )


def require_scope(scope: str):
    async def dependency(context: AuthContext = Depends(resolve_auth_context)) -> AuthContext:
        if not context.has_scope(scope):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Missing required scope: {scope}",
            )
        return context

    return dependency
