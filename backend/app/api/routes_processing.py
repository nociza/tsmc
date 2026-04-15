from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import AuthContext, require_scope
from app.db.session import get_db_session
from app.schemas.processing_worker import (
    ProcessingCompleteRequest,
    ProcessingCompleteResponse,
    ProcessingStatusResponse,
    ProcessingTaskResponse,
)
from app.services.processing_worker import ExtensionBrowserProcessingService


router = APIRouter(prefix="/processing")


@router.get("/status", response_model=ProcessingStatusResponse)
async def processing_status(
    _: AuthContext = Depends(require_scope("ingest")),
    db: AsyncSession = Depends(get_db_session),
) -> ProcessingStatusResponse:
    return await ExtensionBrowserProcessingService(db).status()


@router.post("/next", response_model=ProcessingTaskResponse)
async def next_processing_task(
    _: AuthContext = Depends(require_scope("ingest")),
    db: AsyncSession = Depends(get_db_session),
) -> ProcessingTaskResponse:
    return await ExtensionBrowserProcessingService(db).next_task()


@router.post("/complete", response_model=ProcessingCompleteResponse)
async def complete_processing_task(
    payload: ProcessingCompleteRequest,
    _: AuthContext = Depends(require_scope("ingest")),
    db: AsyncSession = Depends(get_db_session),
) -> ProcessingCompleteResponse:
    try:
        return await ExtensionBrowserProcessingService(db).complete_task(
            session_ids=payload.resolved_session_ids,
            response_text=payload.response_text,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
