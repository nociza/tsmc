from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import AuthContext, require_scope
from app.db.session import get_db_session
from app.schemas.source_capture import SourceCaptureRequest, SourceCaptureResponse
from app.services.source_capture import SourceCaptureService


router = APIRouter()


@router.post("/capture/source", response_model=SourceCaptureResponse, status_code=202)
async def capture_source(
    payload: SourceCaptureRequest,
    _: AuthContext = Depends(require_scope("ingest")),
    db: AsyncSession = Depends(get_db_session),
) -> SourceCaptureResponse:
    return await SourceCaptureService(db).capture(payload)
