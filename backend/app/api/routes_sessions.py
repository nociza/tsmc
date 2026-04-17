from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.dependencies import AuthContext, require_scope
from app.db.session import get_db_session
from app.models import ChatSession, ProviderName, SessionCategory
from app.schemas.explorer import SessionNoteRead
from app.schemas.session import (
    SessionListItem,
    SessionRead,
    SessionUserCategoriesUpdate,
    UserCategorySummary,
    build_session_list_item,
    build_session_read,
)
from app.services.explorer import read_session_markdown, session_related_entities, session_word_count
from app.services.user_categories import has_user_category, merge_user_categories, summarize_user_categories


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
    user_category: str | None = Query(default=None),
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> list[SessionListItem]:
    statement = select(ChatSession).order_by(ChatSession.updated_at.desc())
    if provider:
        statement = statement.where(ChatSession.provider == provider)
    if category:
        statement = statement.where(ChatSession.category == category)
    result = await db.execute(statement)
    sessions = result.scalars().all()
    if user_category:
        sessions = [session for session in sessions if has_user_category(session.custom_tags, user_category)]
    return [build_session_list_item(session) for session in sessions]


@router.get("/sessions/{session_id}", response_model=SessionRead)
async def get_session(
    session_id: str,
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> SessionRead:
    session = await _load_session(db, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found.")
    return build_session_read(session)


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
        **build_session_read(session).model_dump(),
        raw_markdown=raw_markdown,
        related_entities=session_related_entities(session),
        word_count=session_word_count(session, raw_markdown),
    )


@router.get("/user-categories", response_model=list[UserCategorySummary])
async def list_user_categories(
    provider: ProviderName | None = Query(default=None),
    category: SessionCategory | None = Query(default=None),
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> list[UserCategorySummary]:
    statement = select(ChatSession.custom_tags).order_by(ChatSession.updated_at.desc())
    if provider:
        statement = statement.where(ChatSession.provider == provider)
    if category:
        statement = statement.where(ChatSession.category == category)
    tag_sets = list((await db.execute(statement)).scalars().all())
    return [UserCategorySummary(name=name, count=count) for name, count in summarize_user_categories(tag_sets)]


@router.put("/sessions/{session_id}/user-categories", response_model=SessionListItem)
async def update_session_user_categories(
    session_id: str,
    payload: SessionUserCategoriesUpdate,
    _: AuthContext = Depends(require_scope("ingest")),
    db: AsyncSession = Depends(get_db_session),
) -> SessionListItem:
    session = await _load_session(db, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found.")
    session.custom_tags = merge_user_categories(session.custom_tags, payload.user_categories)
    await db.commit()
    refreshed = await _load_session(db, session_id)
    if refreshed is None:
        raise HTTPException(status_code=404, detail="Session not found.")
    return build_session_list_item(refreshed)


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
    return [build_session_list_item(session) for session in result.scalars().all()]


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
    return [build_session_list_item(session) for session in result.scalars().all()]


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
    return [build_session_list_item(session) for session in result.scalars().all()]


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
    return [build_session_list_item(session) for session in result.scalars().all()]
