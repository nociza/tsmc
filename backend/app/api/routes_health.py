from __future__ import annotations

from fastapi import APIRouter

from app.core.config import get_settings
from app.core.version import get_app_version


router = APIRouter()


@router.get("/health")
async def healthcheck() -> dict[str, str]:
    settings = get_settings()
    return {
        "status": "ok",
        "app": settings.app_name,
        "version": get_app_version(),
        "llm_backend": settings.llm_backend,
    }
