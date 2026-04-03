from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes_openai import router as openai_router
from app.api.router import api_router
from app.core.config import get_settings
from app.db.session import init_db
from app.services.browser_proxy.service import BrowserProxyService

try:
    import uvloop
except ImportError:  # pragma: no cover
    uvloop = None


if uvloop is not None:  # pragma: no cover
    uvloop.install()


settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings.resolved_markdown_dir.mkdir(parents=True, exist_ok=True)
    settings.resolved_browser_profile_dir.mkdir(parents=True, exist_ok=True)
    await init_db()
    browser_proxy_service = BrowserProxyService(settings)
    await browser_proxy_service.start()
    app.state.browser_proxy_service = browser_proxy_service
    yield
    await browser_proxy_service.close()


app = FastAPI(
    title=settings.app_name,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_origin_regex=settings.cors_origin_regex,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix=settings.api_v1_prefix)
app.include_router(openai_router, prefix="/v1")
