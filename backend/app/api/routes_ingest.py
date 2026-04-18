from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import AuthContext, require_scope
from app.db.session import get_db_session
from app.schemas.ingest import IngestDiffRequest, IngestResponse
from app.services.ingest import IngestService


router = APIRouter()


@router.post("/diff", response_model=IngestResponse, status_code=status.HTTP_202_ACCEPTED)
async def ingest_diff(
    payload: IngestDiffRequest,
    _: AuthContext = Depends(require_scope("ingest")),
    db: AsyncSession = Depends(get_db_session),
) -> IngestResponse:
    if not payload.messages:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No messages supplied.")

    session, new_message_count = await IngestService(db).ingest(payload)
    return IngestResponse(
        session_id=session.id,
        category=session.category,
        pile_slug=session.pile.slug if session.pile else None,
        is_discarded=session.is_discarded,
        new_message_count=new_message_count,
        markdown_path=session.markdown_path,
        processed=session.last_processed_at is not None,
    )
