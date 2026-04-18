from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import AuthContext, require_scope
from app.db.session import get_db_session
from app.models import ChatSession, Pile, PileKind, ProviderName
from app.models.base import utcnow
from app.schemas.explorer import CategoryGraph, CategoryStats
from app.schemas.pile import (
    DiscardedSessionItem,
    DiscardedSessionsResponse,
    PileCreate,
    PileRead,
    PileUpdate,
)
from app.schemas.session import SessionRead, build_session_read
from app.services.explorer import ExplorerService
from app.services.markdown import MarkdownExporter
from app.services.pile_service import PileNotFoundError, PileService
from app.services.piles import BUILT_IN_SLUG_TO_CATEGORY, PILE_ATTRIBUTES
from app.services.processing import SessionProcessor


router = APIRouter(prefix="/piles")


SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
FOLDER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _-]*$")


def _serialize(pile: Pile) -> PileRead:
    return PileRead.model_validate(pile)


def _validate_attributes(attributes: list[str]) -> list[str]:
    cleaned: list[str] = []
    seen: set[str] = set()
    for raw in attributes:
        value = (raw or "").strip().lower()
        if not value or value in seen:
            continue
        if value not in PILE_ATTRIBUTES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unknown pile attribute '{value}'. Allowed: {sorted(PILE_ATTRIBUTES)}",
            )
        seen.add(value)
        cleaned.append(value)
    return cleaned


def _validate_folder_label(label: str) -> str:
    cleaned = (label or "").strip()
    if not cleaned:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="folder_label is required.")
    if not FOLDER_RE.match(cleaned):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="folder_label must start with a letter or digit and only contain letters, digits, spaces, hyphens, or underscores.",
        )
    return cleaned


def _validate_pipeline_config(config: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(config, dict):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="pipeline_config must be an object.")
    return config


@router.get("", response_model=list[PileRead])
async def list_piles(
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> list[PileRead]:
    piles = await PileService(db).list_piles()
    return [_serialize(pile) for pile in piles]


@router.get("/discarded/sessions", response_model=DiscardedSessionsResponse)
async def list_discarded_sessions(
    limit: int = 200,
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> DiscardedSessionsResponse:
    statement = (
        select(ChatSession)
        .where(ChatSession.is_discarded.is_(True))
        .order_by(ChatSession.last_captured_at.desc().nulls_last(), ChatSession.updated_at.desc())
        .limit(max(1, min(limit, 1000)))
    )
    rows = (await db.execute(statement)).scalars().all()
    items = [
        DiscardedSessionItem(
            id=session.id,
            provider=session.provider.value,
            external_session_id=session.external_session_id,
            title=session.title,
            discarded_reason=session.discarded_reason,
            last_captured_at=session.last_captured_at,
            updated_at=session.updated_at,
            markdown_path=session.markdown_path,
        )
        for session in rows
    ]
    return DiscardedSessionsResponse(count=len(items), items=items)


@router.post(
    "/discarded/sessions/{session_id}/recover",
    response_model=SessionRead,
)
async def recover_discarded_session(
    session_id: str,
    _: AuthContext = Depends(require_scope("ingest")),
    db: AsyncSession = Depends(get_db_session),
) -> SessionRead:
    processor = SessionProcessor(db)
    exporter = MarkdownExporter(db)
    processor.base_dir = exporter.base_dir
    try:
        session = await processor.recover_from_discard(session_id)
    except Exception as exc:  # noqa: BLE001 - surface as 4xx if missing, else 5xx
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    markdown_path = await exporter.write_session(session)
    session.markdown_path = str(markdown_path)
    await db.commit()
    refreshed = await _reload_session_for_response(db, session.id)
    if refreshed is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found after recovery.")
    return build_session_read(refreshed)


@router.post(
    "/discarded/sessions/{session_id}/discard",
    response_model=SessionRead,
)
async def manually_discard_session(
    session_id: str,
    reason: str | None = None,
    _: AuthContext = Depends(require_scope("ingest")),
    db: AsyncSession = Depends(get_db_session),
) -> SessionRead:
    processor = SessionProcessor(db)
    exporter = MarkdownExporter(db)
    processor.base_dir = exporter.base_dir
    session = await processor.route_to_discard(session_id, reason=reason or "Manually moved to Discarded.")
    markdown_path = await exporter.write_session(session)
    session.markdown_path = str(markdown_path)
    await db.commit()
    refreshed = await _reload_session_for_response(db, session.id)
    if refreshed is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found after discard.")
    return build_session_read(refreshed)


async def _reload_session_for_response(db: AsyncSession, session_id: str) -> ChatSession | None:
    from sqlalchemy.orm import selectinload

    statement = (
        select(ChatSession)
        .options(
            selectinload(ChatSession.messages),
            selectinload(ChatSession.triplets),
            selectinload(ChatSession.pile),
        )
        .where(ChatSession.id == session_id)
        .execution_options(populate_existing=True)
    )
    result = await db.execute(statement)
    return result.scalar_one_or_none()


@router.get("/{slug}", response_model=PileRead)
async def get_pile(
    slug: str,
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> PileRead:
    try:
        pile = await PileService(db).require_by_slug(slug)
    except PileNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return _serialize(pile)


@router.get("/{slug}/stats", response_model=CategoryStats)
async def pile_stats(
    slug: str,
    provider: ProviderName | None = Query(default=None),
    session_id: list[str] | None = Query(default=None),
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> CategoryStats:
    try:
        pile = await PileService(db).require_by_slug(slug)
    except PileNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

    category = BUILT_IN_SLUG_TO_CATEGORY.get(pile.slug)
    if category is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Stats are only available for built-in piles in this release.",
        )
    return await ExplorerService(db).category_stats(category, session_ids=session_id, provider=provider)


@router.get("/{slug}/graph", response_model=CategoryGraph)
async def pile_graph(
    slug: str,
    provider: ProviderName | None = Query(default=None),
    session_id: list[str] | None = Query(default=None),
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> CategoryGraph:
    try:
        pile = await PileService(db).require_by_slug(slug)
    except PileNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

    category = BUILT_IN_SLUG_TO_CATEGORY.get(pile.slug)
    if category is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Graph is only available for built-in piles in this release.",
        )
    return await ExplorerService(db).category_graph(category, session_ids=session_id, provider=provider)


@router.post("", response_model=PileRead, status_code=status.HTTP_201_CREATED)
async def create_pile(
    payload: PileCreate,
    _: AuthContext = Depends(require_scope("admin")),
    db: AsyncSession = Depends(get_db_session),
) -> PileRead:
    slug = payload.slug.strip().lower()
    if not SLUG_RE.match(slug):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="slug must start with a lowercase letter or digit and only contain lowercase letters, digits, hyphens, or underscores.",
        )
    existing = await PileService(db).get_by_slug(slug)
    if existing is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"A pile with slug '{slug}' already exists.")

    folder_label = _validate_folder_label(payload.folder_label or payload.name)
    attributes = _validate_attributes(payload.attributes)
    if "summary" not in attributes:
        attributes = ["summary", *attributes]
    pipeline_config = _validate_pipeline_config(payload.pipeline_config)

    pile = Pile(
        slug=slug,
        name=payload.name.strip(),
        description=(payload.description or "").strip() or None,
        kind=PileKind.USER_DEFINED,
        folder_label=folder_label,
        attributes=attributes,
        pipeline_config=pipeline_config,
        is_active=True,
        is_visible_on_dashboard=True,
        sort_order=payload.sort_order,
    )
    db.add(pile)
    await db.commit()
    await db.refresh(pile)
    return _serialize(pile)


@router.patch("/{slug}", response_model=PileRead)
async def update_pile(
    slug: str,
    payload: PileUpdate,
    _: AuthContext = Depends(require_scope("admin")),
    db: AsyncSession = Depends(get_db_session),
) -> PileRead:
    service = PileService(db)
    try:
        pile = await service.require_by_slug(slug)
    except PileNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

    is_built_in = service.is_built_in(pile)

    if payload.name is not None:
        pile.name = payload.name.strip()
    if payload.description is not None:
        pile.description = payload.description.strip() or None
    if payload.folder_label is not None:
        if is_built_in:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="folder_label of a built-in pile cannot be changed.",
            )
        pile.folder_label = _validate_folder_label(payload.folder_label)
    if payload.attributes is not None:
        if is_built_in:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="attributes of a built-in pile cannot be changed.",
            )
        cleaned = _validate_attributes(payload.attributes)
        if "summary" not in cleaned:
            cleaned = ["summary", *cleaned]
        pile.attributes = cleaned
    if payload.pipeline_config is not None:
        pile.pipeline_config = _validate_pipeline_config(payload.pipeline_config)
    if payload.is_active is not None:
        if is_built_in and not payload.is_active:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Built-in piles cannot be deactivated.",
            )
        pile.is_active = payload.is_active
    if payload.sort_order is not None:
        pile.sort_order = payload.sort_order

    pile.updated_at = utcnow()
    await db.commit()
    await db.refresh(pile)
    return _serialize(pile)


@router.post(
    "/{slug}/sessions/{session_id}/assign",
    response_model=SessionRead,
)
async def assign_session_to_pile(
    slug: str,
    session_id: str,
    _: AuthContext = Depends(require_scope("ingest")),
    db: AsyncSession = Depends(get_db_session),
) -> SessionRead:
    service = PileService(db)
    try:
        await service.require_by_slug(slug)
    except PileNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

    processor = SessionProcessor(db)
    exporter = MarkdownExporter(db)
    processor.base_dir = exporter.base_dir
    try:
        session = await processor.reassign_to_pile(session_id, slug)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    markdown_path = await exporter.write_session(session)
    session.markdown_path = str(markdown_path)
    await db.commit()
    refreshed = await _reload_session_for_response(db, session.id)
    if refreshed is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found after assign.")
    return build_session_read(refreshed)


@router.delete("/{slug}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_pile(
    slug: str,
    _: AuthContext = Depends(require_scope("admin")),
    db: AsyncSession = Depends(get_db_session),
) -> None:
    service = PileService(db)
    try:
        pile = await service.require_by_slug(slug)
    except PileNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    if service.is_built_in(pile):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Built-in piles cannot be deleted; deactivate is also not allowed.",
        )
    pile.is_active = False
    pile.updated_at = utcnow()
    await db.commit()
