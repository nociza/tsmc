from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import AuthContext, require_scope
from app.db.session import get_db_session
from app.schemas.openai_proxy import ChatCompletionRequest, ChatCompletionResponse, ModelDescription, ModelListResponse
from app.services.browser_proxy.providers import openai_model_descriptors
from app.services.browser_proxy.service import BrowserProxyService, BrowserProxyServiceError
from app.services.openai_proxy import OpenAIProxyService


router = APIRouter()


def get_browser_proxy_service(request: Request) -> BrowserProxyService:
    service = getattr(request.app.state, "browser_proxy_service", None)
    if service is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Browser proxy service is unavailable.")
    return service


@router.get("/models", response_model=ModelListResponse)
async def list_models(
    _: AuthContext = Depends(require_scope("proxy")),
) -> ModelListResponse:
    created = int(datetime.now(timezone.utc).timestamp())
    return ModelListResponse(
        data=[ModelDescription.model_validate(item) for item in openai_model_descriptors(created)],
    )


@router.post("/chat/completions", response_model=ChatCompletionResponse)
async def create_chat_completion(
    payload: ChatCompletionRequest,
    _: AuthContext = Depends(require_scope("proxy")),
    db: AsyncSession = Depends(get_db_session),
    browser_proxy: BrowserProxyService = Depends(get_browser_proxy_service),
) -> ChatCompletionResponse:
    try:
        return await OpenAIProxyService(db, browser_proxy).create_chat_completion(payload)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except BrowserProxyServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
