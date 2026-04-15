from __future__ import annotations

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import ChatSession, FactTriplet, SessionCategory
from app.models.base import utcnow
from app.schemas.processing import TripletResult
from app.schemas.processing_worker import SessionPipelineResult
from app.services.orchestrator import ProcessingOrchestrator
from app.services.todo import TodoListService


class SessionProcessor:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.orchestrator = ProcessingOrchestrator()
        self.base_dir = TodoListService().base_dir

    async def process(self, session_id: str) -> ChatSession:
        session = await self._load_session(session_id)
        if not session.messages:
            return session

        classification = await self.orchestrator.classify(session.messages)
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
            )
            .where(ChatSession.id == session_id)
        )
        result = await self.db.execute(statement)
        session = result.scalar_one()
        return session
