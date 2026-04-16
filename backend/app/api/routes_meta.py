from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.version import get_app_version
from app.db.session import get_db_session
from app.models import APIToken
from app.models.base import utcnow
from app.schemas.meta import CapabilityAuth, CapabilityExtension, CapabilityFeatureSet, CapabilityResponse, CapabilityStorage


router = APIRouter()


@router.get("/meta/capabilities", response_model=CapabilityResponse)
async def capabilities(db: AsyncSession = Depends(get_db_session)) -> CapabilityResponse:
    settings = get_settings()
    active_tokens = await db.scalar(
        select(func.count(APIToken.id)).where(
            APIToken.is_active.is_(True),
            APIToken.revoked_at.is_(None),
        )
    )
    auth_mode = "app_token" if active_tokens else "bootstrap_local"
    local_unauthenticated_access = auth_mode == "bootstrap_local"
    return CapabilityResponse(
        product="savemycontext",
        version=get_app_version(),
        api_prefix=settings.api_v1_prefix,
        server_time=utcnow(),
        auth=CapabilityAuth(
            mode=auth_mode,
            token_verify_path=f"{settings.api_v1_prefix}/auth/token/verify",
            local_unauthenticated_access=local_unauthenticated_access,
        ),
        extension=CapabilityExtension(
            min_version=settings.minimum_extension_version,
            auth_mode=auth_mode,
        ),
        features=CapabilityFeatureSet(
            storage_management=True,
            browser_proxy=settings.experimental_browser_automation,
            openai_compatible_api=settings.experimental_browser_automation,
        ),
        storage=CapabilityStorage(
            markdown_root=str(settings.resolved_markdown_dir),
            vault_root=str(settings.resolved_vault_root),
            public_url=settings.public_url,
        ),
    )
