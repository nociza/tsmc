from __future__ import annotations

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import ChatMessage, ChatSession, FactTriplet, SessionCategory
from app.schemas.search import SearchResult, SearchResponse
from app.services.graph import entity_note_path
from app.services.todo import TODO_TITLE, TodoListService


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


class SearchService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def search(self, query: str, *, limit: int = 25) -> SearchResponse:
        pattern = f"%{query}%"
        session_statement = (
            select(ChatSession)
            .options(selectinload(ChatSession.messages))
            .where(
                or_(
                    ChatSession.title.ilike(pattern),
                    ChatSession.classification_reason.ilike(pattern),
                    ChatSession.journal_entry.ilike(pattern),
                    ChatSession.todo_summary.ilike(pattern),
                    ChatSession.share_post.ilike(pattern),
                    ChatSession.messages.any(ChatMessage.content.ilike(pattern)),
                )
            )
            .order_by(ChatSession.updated_at.desc())
            .limit(limit)
        )
        session_rows = (await self.db.execute(session_statement)).scalars().all()

        triplet_statement = (
            select(FactTriplet)
            .options(selectinload(FactTriplet.session))
            .where(
                or_(
                    FactTriplet.subject.ilike(pattern),
                    FactTriplet.predicate.ilike(pattern),
                    FactTriplet.object.ilike(pattern),
                )
            )
            .limit(limit)
        )
        triplet_rows = (await self.db.execute(triplet_statement)).scalars().all()

        results: list[SearchResult] = []
        seen_session_ids: set[str] = set()
        seen_entities: set[str] = set()

        for session in session_rows:
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
                    markdown_path=session.markdown_path,
                )
            )

        for triplet in triplet_rows:
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
                        markdown_path=entity_note_path(entity),
                    )
                )

        todo_service = TodoListService()
        todo_markdown = todo_service.read_markdown()
        if query.lower() in todo_markdown.lower():
            results.append(
                SearchResult(
                    kind="todo_list",
                    title=TODO_TITLE,
                    snippet=_snippet(todo_markdown, query),
                    category=SessionCategory.TODO,
                    markdown_path=str(todo_service.path),
                )
            )

        ordered = results[:limit]
        return SearchResponse(query=query, count=len(ordered), results=ordered)
