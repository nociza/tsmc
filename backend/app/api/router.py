from fastapi import APIRouter

from app.api.routes_auth import router as auth_router
from app.api.routes_dashboard import router as dashboard_router
from app.api.routes_health import router as health_router
from app.api.routes_ingest import router as ingest_router
from app.api.routes_meta import router as meta_router
from app.api.routes_sessions import router as sessions_router


api_router = APIRouter()
api_router.include_router(health_router, tags=["health"])
api_router.include_router(meta_router, tags=["meta"])
api_router.include_router(auth_router, tags=["auth"])
api_router.include_router(ingest_router, prefix="/ingest", tags=["ingest"])
api_router.include_router(sessions_router, tags=["sessions"])
api_router.include_router(dashboard_router, tags=["dashboard"])
