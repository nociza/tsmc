from __future__ import annotations

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import ChatMessage, ChatSession, SyncEvent
from app.models.base import utcnow
from app.schemas.ingest import IngestDiffRequest
from app.services.markdown import MarkdownExporter
from app.services.processing import SessionProcessor
from app.services.processing_worker import uses_extension_browser_processing


class IngestService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.exporter = MarkdownExporter(db)
        self.processor = SessionProcessor(db)

    async def ingest(self, payload: IngestDiffRequest) -> tuple[ChatSession, int]:
        session = await self._get_or_create_session(payload)
        if payload.sync_mode == "full_snapshot":
            new_message_count = await self._ingest_full_snapshot(session.id, payload)
        else:
            new_message_count = await self._ingest_incremental(session.id, payload)

        if payload.raw_capture is not None or new_message_count:
            self.db.add(
                SyncEvent(
                    session_id=session.id,
                    message_count=new_message_count,
                    raw_capture=payload.raw_capture,
                )
            )

        await self.db.flush()
        self.processor.base_dir = self.exporter.base_dir
        if payload.route_to_discard:
            reason = (
                f"Auto-discarded by trigger word '{payload.discard_word_match}'."
                if payload.discard_word_match
                else "Auto-discarded by client."
            )
            session = await self.processor.route_to_discard(session.id, reason=reason)
        elif uses_extension_browser_processing():
            session = await self.processor.mark_pending(session.id)
        else:
            session = await self.processor.process(session.id)
        markdown_path = await self.exporter.write_session(session)
        session.markdown_path = str(markdown_path)
        await self.db.commit()
        return await self._load_session(session.id), new_message_count

    async def _ingest_incremental(self, session_id: str, payload: IngestDiffRequest) -> int:
        existing_ids = await self._existing_message_ids(session_id)
        next_index = await self._next_sequence_index(session_id)
        new_message_count = 0

        for message in sorted(payload.messages, key=self._message_sort_key):
            if message.external_message_id in existing_ids:
                continue
            self.db.add(
                ChatMessage(
                    session_id=session_id,
                    external_message_id=message.external_message_id,
                    parent_external_message_id=message.parent_external_message_id,
                    role=message.role,
                    content=message.content,
                    sequence_index=next_index,
                    occurred_at=message.occurred_at,
                    raw_payload=message.raw_payload,
                )
            )
            existing_ids.add(message.external_message_id)
            next_index += 1
            new_message_count += 1

        return new_message_count

    async def _ingest_full_snapshot(self, session_id: str, payload: IngestDiffRequest) -> int:
        existing_messages = await self._existing_messages(session_id)
        new_message_count = 0

        for sequence_index, message in enumerate(payload.messages, start=1):
            existing = existing_messages.pop(message.external_message_id, None)
            if existing is not None:
                existing.parent_external_message_id = message.parent_external_message_id
                existing.role = message.role
                existing.content = message.content
                existing.sequence_index = sequence_index
                existing.occurred_at = message.occurred_at
                existing.raw_payload = message.raw_payload
                continue

            self.db.add(
                ChatMessage(
                    session_id=session_id,
                    external_message_id=message.external_message_id,
                    parent_external_message_id=message.parent_external_message_id,
                    role=message.role,
                    content=message.content,
                    sequence_index=sequence_index,
                    occurred_at=message.occurred_at,
                    raw_payload=message.raw_payload,
                )
            )
            new_message_count += 1

        if existing_messages:
            stale_ids = [message.id for message in existing_messages.values()]
            await self.db.execute(delete(ChatMessage).where(ChatMessage.id.in_(stale_ids)))

        return new_message_count

    async def _get_or_create_session(self, payload: IngestDiffRequest) -> ChatSession:
        statement = select(ChatSession).where(
            ChatSession.provider == payload.provider,
            ChatSession.external_session_id == payload.external_session_id,
        )
        result = await self.db.execute(statement)
        session = result.scalar_one_or_none()
        if session is None:
            session = ChatSession(
                provider=payload.provider,
                external_session_id=payload.external_session_id,
                title=payload.title,
                source_url=payload.source_url,
                custom_tags=sorted(set(payload.custom_tags)),
                last_captured_at=payload.captured_at or utcnow(),
            )
            self.db.add(session)
            await self.db.flush()
            return session

        if payload.title:
            session.title = payload.title
        if payload.source_url:
            session.source_url = payload.source_url
        if payload.custom_tags:
            session.custom_tags = sorted(set([*session.custom_tags, *payload.custom_tags]))
        session.last_captured_at = payload.captured_at or utcnow()
        await self.db.flush()
        return session

    async def _existing_message_ids(self, session_id: str) -> set[str]:
        statement = select(ChatMessage.external_message_id).where(ChatMessage.session_id == session_id)
        result = await self.db.execute(statement)
        return set(result.scalars().all())

    async def _existing_messages(self, session_id: str) -> dict[str, ChatMessage]:
        statement = select(ChatMessage).where(ChatMessage.session_id == session_id)
        result = await self.db.execute(statement)
        return {
            message.external_message_id: message
            for message in result.scalars().all()
        }

    async def _next_sequence_index(self, session_id: str) -> int:
        statement = select(func.max(ChatMessage.sequence_index)).where(ChatMessage.session_id == session_id)
        result = await self.db.execute(statement)
        maximum = result.scalar_one_or_none()
        return (maximum or 0) + 1

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
            .execution_options(populate_existing=True)
        )
        result = await self.db.execute(statement)
        return result.scalar_one()

    @staticmethod
    def _message_sort_key(message: object) -> tuple[int, str]:
        occurred_at = getattr(message, "occurred_at", None)
        return (1 if occurred_at is None else 0, occurred_at.isoformat() if occurred_at else "")
