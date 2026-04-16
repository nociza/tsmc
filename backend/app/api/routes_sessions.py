from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.dependencies import AuthContext, require_scope
from app.db.session import get_db_session
from app.models import ChatSession, ProviderName, SessionCategory
from app.schemas.explorer import SessionNoteRead
from app.schemas.session import SessionListItem, SessionRead
from app.services.explorer import read_session_markdown, session_related_entities, session_word_count


router = APIRouter()


async def _load_session(db: AsyncSession, session_id: str) -> ChatSession | None:
    statement = (
        select(ChatSession)
        .options(
            selectinload(ChatSession.messages),
            selectinload(ChatSession.triplets),
        )
        .where(ChatSession.id == session_id)
    )
    result = await db.execute(statement)
    return result.scalar_one_or_none()


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
    session = await _load_session(db, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found.")
    return SessionRead.model_validate(session)


@router.get("/notes/{session_id}", response_model=SessionNoteRead)
async def get_session_note(
    session_id: str,
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> SessionNoteRead:
    session = await _load_session(db, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found.")

    raw_markdown = read_session_markdown(session)
    return SessionNoteRead(
        **SessionRead.model_validate(session).model_dump(),
        raw_markdown=raw_markdown,
        related_entities=session_related_entities(session),
        word_count=session_word_count(session, raw_markdown),
    )


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


@router.get("/views/todo", response_model=list[SessionListItem])
async def todo_view(
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> list[SessionListItem]:
    result = await db.execute(
        select(ChatSession)
        .where(ChatSession.category == SessionCategory.TODO)
        .order_by(ChatSession.updated_at.desc())
    )
    return [SessionListItem.model_validate(session) for session in result.scalars().all()]
