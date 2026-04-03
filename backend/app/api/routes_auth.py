from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import AuthContext, require_bearer_token_context, require_scope
from app.db.session import get_db_session
from app.models import APIToken
from app.schemas.auth import APITokenRead, TokenVerifyResponse


router = APIRouter()


@router.get("/auth/token/verify", response_model=TokenVerifyResponse)
async def verify_token(context: AuthContext = Depends(require_bearer_token_context)) -> TokenVerifyResponse:
    return TokenVerifyResponse(
        valid=True,
        token_name=context.token_name,
        scopes=sorted(context.scopes),
        username=context.username,
    )


@router.get("/auth/tokens", response_model=list[APITokenRead])
async def list_tokens(
    _: AuthContext = Depends(require_scope("admin")),
    db: AsyncSession = Depends(get_db_session),
) -> list[APITokenRead]:
    result = await db.execute(select(APIToken).order_by(APIToken.created_at.desc()))
    return [APITokenRead.model_validate(token) for token in result.scalars().all()]
