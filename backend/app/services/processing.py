from __future__ import annotations

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import ChatSession, FactTriplet, SessionCategory
from app.models.base import utcnow
from app.schemas.processing import TripletResult
from app.schemas.processing_worker import SessionPipelineResult
from app.services.orchestrator import ProcessingOrchestrator
from app.services.pile_service import PileService
from app.services.piles import CATEGORY_TO_BUILT_IN_SLUG
from app.services.todo import TodoListService


class SessionProcessor:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.orchestrator = ProcessingOrchestrator()
        self.piles = PileService(db)
        self.base_dir = TodoListService().base_dir

    async def process(self, session_id: str) -> ChatSession:
        session = await self._load_session(session_id)
        if not session.messages:
            return session

        auto_discard_categories = await self._auto_discard_categories()
        classification = await self.orchestrator.classify(
            session.messages,
            auto_discard_categories=auto_discard_categories,
        )

        if classification.category == SessionCategory.DISCARDED:
            reason = classification.reason or "LLM matched an auto-discard category."
            return await self.route_to_discard(session_id, reason=reason)

        if classification.category == SessionCategory.JOURNAL:
            result = SessionPipelineResult(
                category=classification.category,
                classification_reason=classification.reason,
                journal=await self.orchestrator.journal(session.messages),
            )
        elif classification.category == SessionCategory.FACTUAL:
            result = SessionPipelineResult(
                category=classification.category,
                classification_reason=classification.reason,
                factual_triplets=await self.orchestrator.factual_triplets(session.messages),
            )
        elif classification.category == SessionCategory.TODO:
            todo_markdown = TodoListService(base_dir=self.base_dir).read_markdown()
            result = SessionPipelineResult(
                category=classification.category,
                classification_reason=classification.reason,
                todo=await self.orchestrator.todo(session.messages, todo_markdown),
            )
        else:
            result = SessionPipelineResult(
                category=classification.category,
                classification_reason=classification.reason,
                idea=await self.orchestrator.ideas(session.messages),
            )

        return await self.apply_pipeline_result(session_id, result)

    async def mark_pending(self, session_id: str) -> ChatSession:
        session = await self._load_session(session_id)
        session.category = None
        session.pile_id = None
        session.is_discarded = False
        session.discarded_reason = None
        session.pile_outputs = None
        session.classification_reason = None
        session.journal_entry = None
        session.todo_summary = None
        session.idea_summary = None
        session.share_post = None
        session.last_processed_at = None
        await self._replace_triplets(session, [])
        await self.db.flush()
        return session

    async def apply_pipeline_result(self, session_id: str, result: SessionPipelineResult) -> ChatSession:
        session = await self._load_session(session_id)
        session.category = result.category
        session.pile_id = await self._resolve_pile_id_for_category(result.category)
        session.is_discarded = result.category == SessionCategory.DISCARDED
        session.classification_reason = result.classification_reason
        session.journal_entry = None
        session.todo_summary = None
        session.idea_summary = None
        session.share_post = None

        if result.category == SessionCategory.JOURNAL and result.journal is not None:
            action_lines = [f"- {item}" for item in result.journal.action_items]
            if action_lines:
                session.journal_entry = f"{result.journal.entry}\n\nAction Items:\n" + "\n".join(action_lines)
            else:
                session.journal_entry = result.journal.entry
            await self._replace_triplets(session, [])
        elif result.category == SessionCategory.TODO and result.todo is not None:
            TodoListService(base_dir=self.base_dir).write_markdown(result.todo.updated_markdown)
            session.todo_summary = result.todo.summary
            await self._replace_triplets(session, [])
        elif result.category == SessionCategory.FACTUAL:
            await self._replace_triplets(session, result.factual_triplets)
        elif result.category == SessionCategory.IDEAS and result.idea is not None:
            session.idea_summary = result.idea.model_dump(exclude={"share_post"})
            session.share_post = result.idea.share_post
            await self._replace_triplets(session, [])
        else:
            await self._replace_triplets(session, [])

        session.last_processed_at = utcnow()
        await self.db.flush()
        return session

    async def route_to_discard(self, session_id: str, *, reason: str) -> ChatSession:
        session = await self._load_session(session_id)
        discarded_pile = await self.piles.discarded_pile()
        session.category = SessionCategory.DISCARDED
        session.pile_id = discarded_pile.id if discarded_pile else None
        session.is_discarded = True
        session.discarded_reason = reason
        session.classification_reason = reason
        session.journal_entry = None
        session.todo_summary = None
        session.idea_summary = None
        session.share_post = None
        session.pile_outputs = None
        session.last_processed_at = utcnow()
        await self._replace_triplets(session, [])
        await self.db.flush()
        return session

    async def recover_from_discard(self, session_id: str) -> ChatSession:
        session = await self._load_session(session_id)
        if not session.is_discarded:
            return session
        session.is_discarded = False
        session.discarded_reason = None
        session.category = None
        session.pile_id = None
        session.classification_reason = None
        session.last_processed_at = None
        await self.db.flush()
        return await self.process(session_id)

    async def _resolve_pile_id_for_category(self, category: SessionCategory | None) -> str | None:
        slug = CATEGORY_TO_BUILT_IN_SLUG.get(category) if category else None
        if not slug:
            return None
        pile = await self.piles.get_by_slug(slug)
        return pile.id if pile else None

    async def _auto_discard_categories(self) -> list[str]:
        discarded_pile = await self.piles.discarded_pile()
        if not discarded_pile:
            return []
        config = discarded_pile.pipeline_config or {}
        raw = config.get("auto_discard_categories")
        if not isinstance(raw, list):
            return []
        return [str(item).strip() for item in raw if str(item).strip()]

    async def reassign_to_pile(self, session_id: str, pile_slug: str) -> ChatSession:
        session = await self._load_session(session_id)
        target = await self.piles.require_by_slug(pile_slug)
        from app.services.pile_service import PileService

        if PileService.is_built_in(target):
            # Built-in piles use the existing typed pipeline. Fall back to a fresh
            # process() call and overwrite the session's category to match.
            session.category = PileService.category_for_pile(target)
            session.pile_id = target.id
            await self.db.flush()
            return await self.process(session_id)

        # User-defined pile: run the generic attribute-driven pipeline.
        attributes = list(target.attributes or [])
        custom_addendum = (target.pipeline_config or {}).get("custom_prompt_addendum") if target.pipeline_config else None
        outputs = await self.orchestrator.pile_outputs(
            session.messages,
            attributes=attributes,
            custom_prompt_addendum=custom_addendum if isinstance(custom_addendum, str) else None,
        )
        session.category = None
        session.pile_id = target.id
        session.is_discarded = False
        session.discarded_reason = None
        session.classification_reason = f"Manually assigned to pile '{target.slug}'."
        session.journal_entry = None
        session.todo_summary = None
        session.idea_summary = None
        session.share_post = outputs.get("share_post") if isinstance(outputs.get("share_post"), str) else None
        session.pile_outputs = outputs or None
        await self._replace_triplets(session, [])
        session.last_processed_at = utcnow()
        await self.db.flush()
        return session

    async def _replace_triplets(self, session: ChatSession, triplets: list[TripletResult]) -> None:
        await self.db.execute(delete(FactTriplet).where(FactTriplet.session_id == session.id))
        session.triplets.clear()
        for triplet in triplets:
            fact_triplet = FactTriplet(
                session=session,
                subject=triplet.subject,
                predicate=triplet.predicate,
                object=triplet.object,
                confidence=triplet.confidence,
            )
            self.db.add(fact_triplet)
        await self.db.flush()

    async def _load_session(self, session_id: str) -> ChatSession:
        statement = (
            select(ChatSession)
            .options(
                selectinload(ChatSession.messages),
                selectinload(ChatSession.triplets),
                selectinload(ChatSession.sync_events),
                selectinload(ChatSession.pile),
            )
            .where(ChatSession.id == session_id)
        )
        result = await self.db.execute(statement)
        session = result.scalar_one()
        return session
