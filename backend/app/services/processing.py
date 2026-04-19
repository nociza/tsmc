from __future__ import annotations

import inspect

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import ChatSession, FactTriplet, Pile, PileKind, SessionCategory
from app.models.base import utcnow
from app.schemas.processing import SegmentRouting, TripletResult
from app.schemas.processing_worker import SessionPipelineResult
from app.services.orchestrator import ProcessingOrchestrator
from app.services.pile_service import PileService
from app.services.piles import BUILT_IN_SLUG_TO_CATEGORY, CATEGORY_TO_BUILT_IN_SLUG, pipeline_prompt_addendum_from_config
from app.services.todo import TodoListService


# Cap how many piles we offer the classifier in a single prompt. Prevents
# runaway prompt size if a user creates many custom piles. The 4 built-in
# routable piles are always offered; only the user-defined ones get capped.
MAX_USER_PILES_IN_CLASSIFIER_PROMPT = 8


class SessionProcessor:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.orchestrator = ProcessingOrchestrator(db=db)
        self.piles = PileService(db)
        self.base_dir = TodoListService().base_dir

    async def process(self, session_id: str) -> ChatSession:
        session = await self._load_session(session_id)
        if not session.messages:
            return session

        auto_discard_categories = await self._auto_discard_categories()

        # If the user has defined custom piles, give the classifier the chance to
        # route the session to one of them. Otherwise stay on the built-in path
        # so behavior is identical to the pre-piles era.
        decision = await self._classify_into_user_pile(
            session, auto_discard_categories=auto_discard_categories
        )
        if decision == "discarded":
            return await self._load_session(session_id)
        if isinstance(decision, tuple):
            user_pile, reason = decision
            return await self._apply_user_pile(session_id, user_pile, reason=reason)

        # New: try segmented classification first. When the transcript cleanly
        # splits across multiple piles, apply each pipeline to its own slice.
        segments = await self.orchestrator.classify_segments(
            session.messages,
            auto_discard_categories=auto_discard_categories,
        )
        distinct_piles = {seg.pile_slug for seg in segments}
        if segments and len(distinct_piles) > 1:
            return await self._apply_segmented(session_id, segments)

        classification = await self.orchestrator.classify(
            session.messages,
            auto_discard_categories=auto_discard_categories,
        )

        if classification.category == SessionCategory.DISCARDED:
            reason = classification.reason or "LLM matched an auto-discard category."
            return await self.route_to_discard(session_id, reason=reason)

        if classification.category == SessionCategory.JOURNAL:
            prompt_addendum = await self._prompt_addendum_for_category(classification.category)
            result = SessionPipelineResult(
                category=classification.category,
                classification_reason=classification.reason,
                journal=await self._invoke_pipeline(
                    self.orchestrator.journal,
                    session.messages,
                    prompt_addendum=prompt_addendum,
                ),
            )
        elif classification.category == SessionCategory.FACTUAL:
            prompt_addendum = await self._prompt_addendum_for_category(classification.category)
            factual = await self._invoke_pipeline(
                self.orchestrator.factual,
                session.messages,
                prompt_addendum=prompt_addendum,
            )
            result = SessionPipelineResult(
                category=classification.category,
                classification_reason=classification.reason,
                factual_triplets=factual.triplets,
            )
        elif classification.category == SessionCategory.TODO:
            todo_markdown = TodoListService(base_dir=self.base_dir).read_markdown()
            prompt_addendum = await self._prompt_addendum_for_category(classification.category)
            result = SessionPipelineResult(
                category=classification.category,
                classification_reason=classification.reason,
                todo=await self._invoke_pipeline(
                    self.orchestrator.todo,
                    session.messages,
                    todo_markdown,
                    prompt_addendum=prompt_addendum,
                ),
            )
        else:
            prompt_addendum = await self._prompt_addendum_for_category(classification.category)
            result = SessionPipelineResult(
                category=classification.category,
                classification_reason=classification.reason,
                idea=await self._invoke_pipeline(
                    self.orchestrator.ideas,
                    session.messages,
                    prompt_addendum=prompt_addendum,
                ),
            )

        return await self.apply_pipeline_result(session_id, result)

    async def _classify_into_user_pile(
        self,
        session: ChatSession,
        *,
        auto_discard_categories: list[str],
    ) -> tuple[Pile, str] | str | None:
        """Returns one of:

        - `tuple[Pile, str]`: the classifier picked a user-defined pile.
        - `"discarded"`: the classifier picked discarded; the call already routed there.
        - `None`: defer to the legacy built-in classifier.
        """
        active_piles = await self.piles.list_piles()
        user_piles = [pile for pile in active_piles if pile.kind == PileKind.USER_DEFINED][
            :MAX_USER_PILES_IN_CLASSIFIER_PROMPT
        ]
        if not user_piles:
            return None

        # Build the candidate list. Always include the discarded pile (so the
        # auto_discard_categories check stays effective) and the four
        # routable built-ins; cap user-defined entries.
        candidates: list[tuple[str, str]] = []
        for pile in active_piles:
            if pile.kind == PileKind.USER_DEFINED and pile not in user_piles:
                continue
            candidates.append((pile.slug, pile.description or pile.name))

        choice = await self.orchestrator.classify_pile(
            session.messages,
            candidates=candidates,
            auto_discard_categories=auto_discard_categories,
        )
        if choice is None:
            return None

        if choice.pile_slug == "discarded":
            await self.route_to_discard(session.id, reason=choice.reason)
            return "discarded"
        if choice.pile_slug in BUILT_IN_SLUG_TO_CATEGORY:
            # Built-in slug: defer to legacy classifier so the typed pipeline runs.
            return None

        target = await self.piles.get_by_slug(choice.pile_slug)
        if target is None or target.kind != PileKind.USER_DEFINED:
            return None
        return target, choice.reason

    async def _apply_user_pile(self, session_id: str, target: Pile, *, reason: str) -> ChatSession:
        session = await self._load_session(session_id)
        attributes = list(target.attributes or [])
        config = target.pipeline_config or {}
        custom_addendum = pipeline_prompt_addendum_from_config(config)
        outputs = await self.orchestrator.pile_outputs(
            session.messages,
            attributes=attributes,
            custom_prompt_addendum=custom_addendum,
        )
        session.category = None
        session.pile_id = target.id
        session.is_discarded = False
        session.discarded_reason = None
        session.classification_reason = reason
        session.journal_entry = None
        session.todo_summary = None
        session.idea_summary = None
        share_post = outputs.get("share_post") if isinstance(outputs, dict) else None
        session.share_post = share_post if isinstance(share_post, str) else None
        session.pile_outputs = outputs or None
        await self._replace_triplets(session, [])
        session.last_processed_at = utcnow()
        await self.db.flush()
        return session

    async def _apply_segmented(
        self,
        session_id: str,
        segments: list[SegmentRouting],
    ) -> ChatSession:
        """Run each segment through its pile's pipeline and fold the results onto
        the session. The session's primary category/pile becomes the dominant
        segment (largest by message count); per-segment outputs live on
        `ChatSession.segments` for the markdown renderer and dashboards.
        """
        session = await self._load_session(session_id)
        messages = list(session.messages)

        segment_records: list[dict[str, object]] = []
        journal_entries: list[str] = []
        journal_actions: list[str] = []
        idea_outputs: list[dict[str, object]] = []
        share_posts: list[str] = []
        triplets: list[TripletResult] = []
        todo_summary_parts: list[str] = []
        todo_markdown: str | None = None
        factual_summaries: list[str] = []

        todo_service = TodoListService(base_dir=self.base_dir)
        current_todo = todo_service.read_markdown()
        built_in_prompt_addendums = await self._built_in_prompt_addendum_map()

        for segment in segments:
            slice_messages = messages[segment.start_index : segment.end_index + 1]
            if not slice_messages:
                continue
            outputs: dict[str, object] = {}
            prompt_addendum = built_in_prompt_addendums.get(segment.pile_slug)

            if segment.pile_slug == "journal":
                journal = await self._invoke_pipeline(
                    self.orchestrator.journal,
                    slice_messages,
                    prompt_addendum=prompt_addendum,
                )
                outputs["journal"] = journal.model_dump(exclude_none=True)
                journal_entries.append(journal.entry)
                journal_actions.extend(journal.action_items)
            elif segment.pile_slug == "factual":
                factual = await self._invoke_pipeline(
                    self.orchestrator.factual,
                    slice_messages,
                    prompt_addendum=prompt_addendum,
                )
                outputs["factual"] = factual.model_dump(exclude_none=True)
                triplets.extend(factual.triplets)
                if factual.summary:
                    factual_summaries.append(factual.summary)
            elif segment.pile_slug == "ideas":
                idea = await self._invoke_pipeline(
                    self.orchestrator.ideas,
                    slice_messages,
                    prompt_addendum=prompt_addendum,
                )
                outputs["idea"] = idea.model_dump(exclude={"share_post"})
                idea_outputs.append(idea.model_dump(exclude={"share_post"}))
                share_posts.append(idea.share_post)
            elif segment.pile_slug == "todo":
                todo = await self._invoke_pipeline(
                    self.orchestrator.todo,
                    slice_messages,
                    current_todo,
                    prompt_addendum=prompt_addendum,
                )
                outputs["todo"] = todo.model_dump(exclude_none=True)
                todo_markdown = todo.updated_markdown
                current_todo = todo.updated_markdown
                todo_summary_parts.append(todo.summary)
            else:
                continue

            segment_records.append(
                {
                    "pile_slug": segment.pile_slug,
                    "reason": segment.reason,
                    "start_index": segment.start_index,
                    "end_index": segment.end_index,
                    "outputs": outputs,
                }
            )

        if not segment_records:
            return session

        # Pick the dominant segment as the session's primary pile/category.
        dominant = max(
            segment_records,
            key=lambda record: int(record["end_index"]) - int(record["start_index"]) + 1,
        )
        dominant_slug = str(dominant["pile_slug"])
        dominant_category = BUILT_IN_SLUG_TO_CATEGORY.get(dominant_slug)

        session.category = dominant_category
        session.pile_id = await self._resolve_pile_id_for_category(dominant_category)
        session.is_discarded = False
        session.discarded_reason = None
        session.classification_reason = str(dominant.get("reason") or "Segmented classification.")

        session.journal_entry = None
        session.todo_summary = None
        session.idea_summary = None
        session.share_post = None

        if journal_entries:
            body = "\n\n".join(entry.strip() for entry in journal_entries if entry.strip())
            if journal_actions:
                deduped_actions: list[str] = []
                seen: set[str] = set()
                for item in journal_actions:
                    key = item.lower()
                    if key in seen:
                        continue
                    seen.add(key)
                    deduped_actions.append(item)
                body = body + "\n\nAction Items:\n" + "\n".join(f"- {item}" for item in deduped_actions)
            session.journal_entry = body or None

        if idea_outputs:
            # Keep the dominant idea's structure as the primary summary; stash the
            # rest under pile_outputs via the segments list (already recorded).
            primary_idea = next(
                (record["outputs"]["idea"] for record in segment_records if record["pile_slug"] == "ideas"),
                None,
            )
            session.idea_summary = primary_idea if isinstance(primary_idea, dict) else None

        if share_posts:
            session.share_post = share_posts[0]

        if todo_markdown is not None:
            todo_service.write_markdown(todo_markdown)
            session.todo_summary = "; ".join(part for part in todo_summary_parts if part) or None

        session.pile_outputs = {"factual_summaries": factual_summaries} if factual_summaries else None
        session.segments = segment_records

        await self._replace_triplets(session, triplets)
        session.last_processed_at = utcnow()
        await self.db.flush()
        return session

    async def _prompt_addendum_for_category(self, category: SessionCategory | None) -> str | None:
        pile = await self.piles.resolve_pile_for_category(category)
        return pipeline_prompt_addendum_from_config(pile.pipeline_config if pile else None)

    async def _built_in_prompt_addendum_map(self) -> dict[str, str]:
        piles = await self.piles.list_piles()
        prompt_addendum_by_slug: dict[str, str] = {}
        for pile in piles:
            if pile.slug not in BUILT_IN_SLUG_TO_CATEGORY:
                continue
            prompt_addendum = pipeline_prompt_addendum_from_config(pile.pipeline_config)
            if prompt_addendum:
                prompt_addendum_by_slug[pile.slug] = prompt_addendum
        return prompt_addendum_by_slug

    @staticmethod
    async def _invoke_pipeline(callable_obj, *args, prompt_addendum: str | None = None):
        if prompt_addendum is None:
            return await callable_obj(*args)
        try:
            signature = inspect.signature(callable_obj)
        except (TypeError, ValueError):
            signature = None
        if signature is not None and "prompt_addendum" not in signature.parameters:
            return await callable_obj(*args)
        return await callable_obj(*args, prompt_addendum=prompt_addendum)

    async def mark_pending(self, session_id: str) -> ChatSession:
        session = await self._load_session(session_id)
        session.category = None
        session.pile_id = None
        session.is_discarded = False
        session.discarded_reason = None
        session.pile_outputs = None
        session.segments = None
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
        session.segments = None
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
        session.segments = None
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
