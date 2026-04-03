from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.dependencies import AuthContext, require_scope
from app.db.session import get_db_session
from app.models import ChatSession, ProviderName, SessionCategory
from app.schemas.session import SessionListItem, SessionRead


router = APIRouter()


@router.get("/sessions", response_model=list[SessionListItem])
async def list_sessions(
    provider: ProviderName | None = Query(default=None),
    category: SessionCategory | None = Query(default=None),
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> list[SessionListItem]:
    statement = select(ChatSession).order_by(ChatSession.updated_at.desc())
    if provider:
        statement = statement.where(ChatSession.provider == provider)
    if category:
        statement = statement.where(ChatSession.category == category)
    result = await db.execute(statement)
    return [SessionListItem.model_validate(session) for session in result.scalars().all()]


@router.get("/sessions/{session_id}", response_model=SessionRead)
async def get_session(
    session_id: str,
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> SessionRead:
    statement = (
        select(ChatSession)
        .options(
            selectinload(ChatSession.messages),
            selectinload(ChatSession.triplets),
        )
        .where(ChatSession.id == session_id)
    )
    result = await db.execute(statement)
    session = result.scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found.")
    return SessionRead.model_validate(session)


@router.get("/views/journal", response_model=list[SessionListItem])
async def journal_view(
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> list[SessionListItem]:
    result = await db.execute(
        select(ChatSession)
        .where(ChatSession.category == SessionCategory.JOURNAL)
        .order_by(ChatSession.updated_at.desc())
    )
    return [SessionListItem.model_validate(session) for session in result.scalars().all()]


@router.get("/views/factual", response_model=list[SessionListItem])
async def factual_view(
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> list[SessionListItem]:
    result = await db.execute(
        select(ChatSession)
        .where(ChatSession.category == SessionCategory.FACTUAL)
        .order_by(ChatSession.updated_at.desc())
    )
    return [SessionListItem.model_validate(session) for session in result.scalars().all()]


@router.get("/views/ideas", response_model=list[SessionListItem])
async def ideas_view(
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> list[SessionListItem]:
    result = await db.execute(
        select(ChatSession)
        .where(ChatSession.category == SessionCategory.IDEAS)
        .order_by(ChatSession.updated_at.desc())
    )
    return [SessionListItem.model_validate(session) for session in result.scalars().all()]
