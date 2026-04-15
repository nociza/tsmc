from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import AuthContext, require_scope
from app.core.config import get_settings
from app.db.session import get_db_session
from app.schemas.openai_proxy import ChatCompletionRequest, ChatCompletionResponse, ModelDescription, ModelListResponse
from app.services.browser_proxy.providers import openai_model_descriptors
from app.services.browser_proxy.errors import BrowserProxyServiceError
from app.services.openai_proxy import OpenAIProxyService


router = APIRouter()


def require_browser_automation_enabled() -> None:
    if get_settings().experimental_browser_automation:
        return
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=(
            "Experimental browser automation is disabled. "
            "Configure an OpenAI-compatible API key for backend processing instead."
        ),
    )


def get_browser_proxy_service(request: Request) -> Any:
    require_browser_automation_enabled()
    service = getattr(request.app.state, "browser_proxy_service", None)
    if service is None:
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail=(
                "Direct backend browser automation is disabled. "
                "Use the Chrome extension's browser session and manual AI processing flow instead."
            ),
        )
    return service


@router.get("/models", response_model=ModelListResponse)
async def list_models(
    _: AuthContext = Depends(require_scope("proxy")),
) -> ModelListResponse:
    require_browser_automation_enabled()
    created = int(datetime.now(timezone.utc).timestamp())
    return ModelListResponse(
        data=[ModelDescription.model_validate(item) for item in openai_model_descriptors(created)],
    )


@router.post("/chat/completions", response_model=ChatCompletionResponse)
async def create_chat_completion(
    payload: ChatCompletionRequest,
    _: AuthContext = Depends(require_scope("proxy")),
    db: AsyncSession = Depends(get_db_session),
    browser_proxy: Any = Depends(get_browser_proxy_service),
) -> ChatCompletionResponse:
    try:
        return await OpenAIProxyService(db, browser_proxy).create_chat_completion(payload)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except BrowserProxyServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
