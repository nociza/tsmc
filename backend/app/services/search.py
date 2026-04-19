from __future__ import annotations

import logging
from pathlib import Path

from sqlalchemy import Text, cast, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import get_settings
from app.models import ChatMessage, ChatSession, FactTriplet, ProviderName, SessionCategory, SourceCapture
from app.schemas.search import SearchResult, SearchResponse
from app.services.agentic_search import ADKVaultSearchService, VaultSearchToolkit
from app.services.graph import entity_note_path
from app.services.todo import TODO_TITLE, TodoListService
from app.services.user_categories import extract_user_categories, has_user_category


logger = logging.getLogger(__name__)


def _snippet(text: str | None, query: str) -> str:
    value = (text or "").strip()
    if not value:
        return ""
    lower = value.lower()
    needle = query.lower()
    position = lower.find(needle)
    if position < 0:
        return value[:220]
    start = max(0, position - 80)
    end = min(len(value), position + len(query) + 120)
    return value[start:end].strip()


def _normalize_path(path_text: str | None) -> str | None:
    if not path_text:
        return None
    try:
        return str(Path(path_text).expanduser().resolve())
    except OSError:
        return None


def _candidate_snippet(hit: object) -> str:
    snippet = getattr(hit, "snippet", "")
    if isinstance(snippet, str) and snippet.strip():
        return snippet.strip()
    reason = getattr(hit, "reason", "")
    if isinstance(reason, str):
        return reason.strip()
    return ""


def _result_identity(result: SearchResult) -> tuple[str, str]:
    if result.kind == "entity" and result.entity_id:
        return ("entity", result.entity_id.casefold())
    if result.kind == "source_capture" and result.source_id:
        return ("source_capture", result.source_id)
    if result.kind == "session" and result.session_id:
        return ("session", result.session_id)
    if result.kind == "todo_list":
        return ("todo_list", result.markdown_path or TODO_TITLE)
    if result.source_id:
        return ("source_capture", result.source_id)
    if result.session_id:
        return ("session", result.session_id)
    if result.entity_id:
        return ("entity", result.entity_id.casefold())
    if result.markdown_path:
        return (result.kind, result.markdown_path)
    return (result.kind, result.title.casefold())


def _merge_duplicate_results(primary: SearchResult, fallback: SearchResult) -> SearchResult:
    authoritative = (
        fallback
        if fallback.session_id or fallback.source_id or fallback.entity_id or fallback.kind == "todo_list"
        else primary
    )
    return SearchResult(
        kind=authoritative.kind or primary.kind,
        title=authoritative.title or primary.title,
        snippet=primary.snippet or fallback.snippet,
        session_id=primary.session_id or fallback.session_id,
        source_id=primary.source_id or fallback.source_id,
        entity_id=primary.entity_id or fallback.entity_id,
        category=primary.category or fallback.category,
        provider=primary.provider or fallback.provider,
        user_categories=primary.user_categories or fallback.user_categories,
        markdown_path=primary.markdown_path or fallback.markdown_path,
    )


class SearchService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def search(
        self,
        query: str,
        *,
        limit: int = 25,
        category: SessionCategory | None = None,
        provider: ProviderName | None = None,
        user_category: str | None = None,
        kinds: set[str] | None = None,
        include_discarded: bool = False,
    ) -> SearchResponse:
        pattern = f"%{query}%"
        fetch_limit = limit * 4 if user_category else limit
        session_statement = select(ChatSession).options(selectinload(ChatSession.messages)).where(
            or_(
                ChatSession.title.ilike(pattern),
                ChatSession.classification_reason.ilike(pattern),
                ChatSession.journal_entry.ilike(pattern),
                ChatSession.todo_summary.ilike(pattern),
                cast(ChatSession.idea_summary, Text).ilike(pattern),
                ChatSession.share_post.ilike(pattern),
                ChatSession.messages.any(ChatMessage.content.ilike(pattern)),
            )
        )
        if category:
            session_statement = session_statement.where(ChatSession.category == category)
        if provider:
            session_statement = session_statement.where(ChatSession.provider == provider)
        if not include_discarded:
            session_statement = session_statement.where(ChatSession.is_discarded.is_(False))
        session_statement = session_statement.order_by(ChatSession.updated_at.desc()).limit(fetch_limit)
        session_rows = (await self.db.execute(session_statement)).scalars().all()
        if user_category:
            session_rows = [session for session in session_rows if has_user_category(session.custom_tags, user_category)]

        triplet_statement = select(FactTriplet).options(selectinload(FactTriplet.session)).join(FactTriplet.session).where(
            or_(
                FactTriplet.subject.ilike(pattern),
                FactTriplet.predicate.ilike(pattern),
                FactTriplet.object.ilike(pattern),
            )
        )
        if category:
            triplet_statement = triplet_statement.where(ChatSession.category == category)
        if provider:
            triplet_statement = triplet_statement.where(ChatSession.provider == provider)
        if not include_discarded:
            triplet_statement = triplet_statement.where(ChatSession.is_discarded.is_(False))
        triplet_statement = triplet_statement.limit(fetch_limit)
        triplet_rows = (await self.db.execute(triplet_statement)).scalars().all()
        if user_category:
            triplet_rows = [triplet for triplet in triplet_rows if triplet.session and has_user_category(triplet.session.custom_tags, user_category)]
        source_statement = select(SourceCapture).where(
            or_(
                SourceCapture.title.ilike(pattern),
                SourceCapture.page_title.ilike(pattern),
                SourceCapture.source_url.ilike(pattern),
                SourceCapture.summary.ilike(pattern),
                SourceCapture.classification_reason.ilike(pattern),
                SourceCapture.cleaned_markdown.ilike(pattern),
                SourceCapture.source_text.ilike(pattern),
            )
        )
        if category:
            source_statement = source_statement.where(SourceCapture.category == category)
        if not include_discarded:
            source_statement = source_statement.where(SourceCapture.is_discarded.is_(False))
        if provider:
            source_rows = []
        else:
            source_statement = source_statement.order_by(SourceCapture.updated_at.desc()).limit(limit)
            source_rows = (await self.db.execute(source_statement)).scalars().all()

        results: list[SearchResult] = []
        seen_session_ids: set[str] = set()
        seen_entities: set[str] = set()
        seen_source_ids: set[str] = set()
        allowed_kinds = kinds or {"session", "entity", "source_capture", "todo_list"}

        for session in session_rows:
            if "session" not in allowed_kinds:
                continue
            seen_session_ids.add(session.id)
            results.append(
                SearchResult(
                    kind="session",
                    title=session.title or session.external_session_id,
                    snippet=_snippet(
                        "\n".join(
                            [
                                session.classification_reason or "",
                                session.journal_entry or "",
                                session.todo_summary or "",
                                session.share_post or "",
                                *(message.content for message in session.messages[:3]),
                            ]
                        ),
                        query,
                    ),
                    session_id=session.id,
                    category=session.category,
                    provider=session.provider,
                    user_categories=extract_user_categories(session.custom_tags),
                    markdown_path=session.markdown_path,
                )
            )

        for triplet in triplet_rows:
            if "entity" not in allowed_kinds:
                continue
            for entity in (triplet.subject, triplet.object):
                entity_key = entity.lower()
                if entity_key in seen_entities:
                    continue
                seen_entities.add(entity_key)
                session = triplet.session
                results.append(
                    SearchResult(
                        kind="entity",
                        title=entity,
                        snippet=f"{triplet.subject} | {triplet.predicate} | {triplet.object}",
                        session_id=session.id if session else None,
                        entity_id=entity,
                        category=session.category if session else None,
                        provider=session.provider if session else None,
                        user_categories=extract_user_categories(session.custom_tags) if session else [],
                        markdown_path=entity_note_path(entity),
                    )
                )

        for source_capture in source_rows:
            if "source_capture" not in allowed_kinds:
                continue
            if source_capture.id in seen_source_ids:
                continue
            seen_source_ids.add(source_capture.id)
            results.append(
                SearchResult(
                    kind="source_capture",
                    title=source_capture.title or source_capture.page_title or "Saved source",
                    snippet=_snippet(
                        "\n".join(
                            [
                                source_capture.summary or "",
                                source_capture.cleaned_markdown or "",
                                source_capture.selection_text or "",
                                source_capture.source_text,
                            ]
                        ),
                        query,
                    ),
                    source_id=source_capture.id,
                    category=source_capture.category,
                    markdown_path=source_capture.markdown_path or source_capture.raw_source_path,
                )
            )

        todo_service = TodoListService()
        todo_markdown = todo_service.read_markdown()
        if (
            "todo_list" in allowed_kinds
            and provider is None
            and category in {None, SessionCategory.TODO}
            and query.lower() in todo_markdown.lower()
        ):
            results.append(
                SearchResult(
                    kind="todo_list",
                    title=TODO_TITLE,
                    snippet=_snippet(todo_markdown, query),
                    category=SessionCategory.TODO,
                    markdown_path=str(todo_service.path),
                )
            )

        agentic_results = await self._agentic_results(
            query,
            limit=max(limit * 4, 24),
            category=category,
            provider=provider,
            user_category=user_category,
            allowed_kinds=allowed_kinds,
            include_discarded=include_discarded,
        )
        ordered = self._merge_results(agentic_results, results, limit=limit)
        return SearchResponse(query=query, count=len(ordered), results=ordered)

    async def _agentic_results(
        self,
        query: str,
        *,
        limit: int,
        category: SessionCategory | None,
        provider: ProviderName | None,
        user_category: str | None,
        allowed_kinds: set[str],
        include_discarded: bool,
    ) -> list[SearchResult]:
        if not {"session", "source_capture"} & allowed_kinds:
            return []

        hits = await self._agentic_candidates(query, limit=limit)
        if not hits:
            return []

        normalized_paths = [hit.path for hit in hits]

        session_statement = select(ChatSession).where(ChatSession.markdown_path.in_(normalized_paths))
        if category:
            session_statement = session_statement.where(ChatSession.category == category)
        if provider:
            session_statement = session_statement.where(ChatSession.provider == provider)
        if not include_discarded:
            session_statement = session_statement.where(ChatSession.is_discarded.is_(False))
        session_rows = (await self.db.execute(session_statement)).scalars().all()
        if user_category:
            session_rows = [session for session in session_rows if has_user_category(session.custom_tags, user_category)]

        session_by_path: dict[str, ChatSession] = {}
        for session in session_rows:
            normalized_path = _normalize_path(session.markdown_path)
            if normalized_path:
                session_by_path[normalized_path] = session

        source_by_path: dict[str, SourceCapture] = {}
        if provider is None:
            source_statement = select(SourceCapture).where(
                or_(
                    SourceCapture.markdown_path.in_(normalized_paths),
                    SourceCapture.raw_source_path.in_(normalized_paths),
                )
            )
            if category:
                source_statement = source_statement.where(SourceCapture.category == category)
            if not include_discarded:
                source_statement = source_statement.where(SourceCapture.is_discarded.is_(False))
            source_rows = (await self.db.execute(source_statement)).scalars().all()
            for source_capture in source_rows:
                for candidate in (source_capture.markdown_path, source_capture.raw_source_path):
                    normalized_path = _normalize_path(candidate)
                    if normalized_path:
                        source_by_path[normalized_path] = source_capture

        resolved: list[SearchResult] = []
        for hit in hits:
            session = session_by_path.get(hit.path)
            if session is not None and "session" in allowed_kinds:
                resolved.append(
                    SearchResult(
                        kind="session",
                        title=session.title or session.external_session_id,
                        snippet=_candidate_snippet(hit),
                        session_id=session.id,
                        category=session.category,
                        provider=session.provider,
                        user_categories=extract_user_categories(session.custom_tags),
                        markdown_path=session.markdown_path,
                    )
                )
                continue

            source_capture = source_by_path.get(hit.path)
            if source_capture is not None and "source_capture" in allowed_kinds:
                resolved.append(
                    SearchResult(
                        kind="source_capture",
                        title=source_capture.title or source_capture.page_title or "Saved source",
                        snippet=_candidate_snippet(hit),
                        source_id=source_capture.id,
                        category=source_capture.category,
                        markdown_path=source_capture.markdown_path or source_capture.raw_source_path,
                    )
                )
                continue

        return resolved

    async def _agentic_candidates(self, query: str, *, limit: int):
        settings = get_settings()
        if settings.google_api_key:
            try:
                candidates = await ADKVaultSearchService(settings=settings).search(query, limit=limit)
                if candidates:
                    return candidates
            except Exception as exc:
                logger.warning("ADK vault search failed; falling back to local grep search: %s", exc)

        toolkit = VaultSearchToolkit(settings)
        return toolkit.search(query, limit=limit)

    def _merge_results(
        self,
        primary_results: list[SearchResult],
        fallback_results: list[SearchResult],
        *,
        limit: int,
    ) -> list[SearchResult]:
        ordered: list[SearchResult] = []
        index_by_identity: dict[tuple[str, str], int] = {}

        for result in [*primary_results, *fallback_results]:
            identity = _result_identity(result)
            existing_index = index_by_identity.get(identity)
            if existing_index is None:
                index_by_identity[identity] = len(ordered)
                ordered.append(result)
                continue
            ordered[existing_index] = _merge_duplicate_results(ordered[existing_index], result)

        return ordered[:limit]
