from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import AuthContext, require_scope
from app.db.session import get_db_session
from app.core.config import get_settings
from app.core.version import get_app_version
from app.models import APIToken, ChatMessage, ChatSession, FactTriplet, ProviderName, SessionCategory, SyncEvent
from app.models.base import utcnow
from app.schemas.dashboard import CategoryCount, CustomCategoryCount, DashboardSummary
from app.schemas.explorer import CategoryGraph, CategoryStats
from app.schemas.graph import GraphEdge, GraphNode
from app.schemas.search import SearchResponse
from app.schemas.system import StorageSettingsResponse, StorageSettingsUpdate, SystemStatus
from app.services.explorer import ExplorerService
from app.services.git_versioning import GitVersioningService
from app.services.graph import GraphService
from app.services.search import SearchService
from app.services.storage_config import StorageConfigService
from app.services.todo import TodoListService
from app.services.user_categories import summarize_user_categories


router = APIRouter()


@router.get("/dashboard/summary", response_model=DashboardSummary)
async def dashboard_summary(
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> DashboardSummary:
    total_sessions = int((await db.scalar(select(func.count(ChatSession.id)))) or 0)
    total_messages = int((await db.scalar(select(func.count(ChatMessage.id)))) or 0)
    total_triplets = int((await db.scalar(select(func.count(FactTriplet.id)))) or 0)
    total_sync_events = int((await db.scalar(select(func.count(SyncEvent.id)))) or 0)
    active_tokens = int(
        (await db.scalar(select(func.count(APIToken.id)).where(APIToken.is_active.is_(True), APIToken.revoked_at.is_(None))))
        or 0
    )
    latest_sync_at = await db.scalar(select(func.max(ChatSession.last_captured_at)))

    category_rows = (
        await db.execute(
            select(ChatSession.category, func.count(ChatSession.id))
            .where(ChatSession.category.is_not(None))
            .group_by(ChatSession.category)
        )
    ).all()

    categories = [
        CategoryCount(category=category, count=count)
        for category, count in category_rows
        if category in {SessionCategory.JOURNAL, SessionCategory.FACTUAL, SessionCategory.IDEAS, SessionCategory.TODO}
    ]
    session_tags = (await db.execute(select(ChatSession.custom_tags))).scalars().all()
    return DashboardSummary(
        total_sessions=total_sessions,
        total_messages=total_messages,
        total_triplets=total_triplets,
        total_sync_events=total_sync_events,
        active_tokens=active_tokens,
        latest_sync_at=latest_sync_at,
        categories=categories,
        custom_categories=[CustomCategoryCount(name=name, count=count) for name, count in summarize_user_categories(session_tags)],
    )


@router.get("/search", response_model=SearchResponse)
async def search(
    q: str = Query(min_length=2),
    limit: int = Query(default=25, ge=1, le=100),
    category: SessionCategory | None = Query(default=None),
    provider: ProviderName | None = Query(default=None),
    user_category: str | None = Query(default=None),
    kind: list[str] | None = Query(default=None),
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> SearchResponse:
    return await SearchService(db).search(
        q,
        limit=limit,
        category=category,
        provider=provider,
        user_category=user_category,
        kinds=set(kind) if kind else None,
    )


@router.get("/categories/{category}/stats", response_model=CategoryStats)
async def category_stats(
    category: SessionCategory,
    provider: ProviderName | None = Query(default=None),
    session_id: list[str] | None = Query(default=None),
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> CategoryStats:
    return await ExplorerService(db).category_stats(category, session_ids=session_id, provider=provider)


@router.get("/categories/{category}/graph", response_model=CategoryGraph)
async def category_graph(
    category: SessionCategory,
    provider: ProviderName | None = Query(default=None),
    session_id: list[str] | None = Query(default=None),
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> CategoryGraph:
    return await ExplorerService(db).category_graph(category, session_ids=session_id, provider=provider)


@router.get("/custom-categories/{name}/stats", response_model=CategoryStats)
async def custom_category_stats(
    name: str,
    provider: ProviderName | None = Query(default=None),
    session_id: list[str] | None = Query(default=None),
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> CategoryStats:
    return await ExplorerService(db).custom_category_stats(name, session_ids=session_id, provider=provider)


@router.get("/custom-categories/{name}/graph", response_model=CategoryGraph)
async def custom_category_graph(
    name: str,
    provider: ProviderName | None = Query(default=None),
    session_id: list[str] | None = Query(default=None),
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> CategoryGraph:
    return await ExplorerService(db).custom_category_graph(name, session_ids=session_id, provider=provider)


@router.get("/graph/nodes", response_model=list[GraphNode])
async def graph_nodes(
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> list[GraphNode]:
    return await GraphService(db).nodes()


@router.get("/graph/edges", response_model=list[GraphEdge])
async def graph_edges(
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> list[GraphEdge]:
    return await GraphService(db).edges()


@router.get("/system/status", response_model=SystemStatus)
async def system_status(
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> SystemStatus:
    settings = get_settings()
    todo_service = TodoListService()
    git_service = GitVersioningService(repo_root=settings.resolved_vault_root)
    active_tokens = int(
        (await db.scalar(select(func.count(APIToken.id)).where(APIToken.is_active.is_(True), APIToken.revoked_at.is_(None))))
        or 0
    )
    return SystemStatus(
        product="savemycontext",
        version=get_app_version(),
        server_time=utcnow(),
        markdown_root=str(settings.resolved_markdown_dir),
        vault_root=str(settings.resolved_vault_root),
        todo_list_path=str(todo_service.ensure_exists()),
        public_url=settings.public_url,
        auth_mode="app_token" if active_tokens else "bootstrap_local",
        git_versioning_enabled=settings.git_versioning_enabled,
        git_available=git_service.is_available(),
        total_sessions=int((await db.scalar(select(func.count(ChatSession.id)))) or 0),
        total_messages=int((await db.scalar(select(func.count(ChatMessage.id)))) or 0),
        total_triplets=int((await db.scalar(select(func.count(FactTriplet.id)))) or 0),
    )


@router.get("/system/storage", response_model=StorageSettingsResponse)
async def get_storage_settings(
    _: AuthContext = Depends(require_scope("read")),
) -> StorageSettingsResponse:
    return StorageConfigService().read()


@router.post("/system/storage", response_model=StorageSettingsResponse)
async def update_storage_settings(
    payload: StorageSettingsUpdate,
    _: AuthContext = Depends(require_scope("admin")),
    db: AsyncSession = Depends(get_db_session),
) -> StorageSettingsResponse:
    return await StorageConfigService(db).update_markdown_root(payload.markdown_root)
