from __future__ import annotations

import json
from dataclasses import dataclass

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import Settings, get_settings
from app.models import ChatSession
from app.schemas.processing_worker import (
    ProcessingCompleteResponse,
    ProcessingCompleteResult,
    ProcessingResultEnvelope,
    ProcessingResultItem,
    ProcessingStatusResponse,
    ProcessingTaskItem,
    ProcessingTaskResponse,
    SessionPipelineResult,
)
from app.services.markdown import MarkdownExporter
from app.services.orchestrator import render_transcript
from app.services.processing import SessionProcessor
from app.services.prompt_templates import PromptTemplateService
from app.services.text import extract_json_object
from app.services.todo import TodoListService


def browser_automation_enabled(settings: Settings | None = None) -> bool:
    resolved = settings or get_settings()
    return resolved.experimental_browser_automation


def uses_extension_browser_processing(settings: Settings | None = None) -> bool:
    resolved = settings or get_settings()
    return browser_automation_enabled(resolved) and resolved.llm_backend.lower() == "browser_proxy"


def immediate_processing_model(settings: Settings | None = None) -> str | None:
    resolved = settings or get_settings()
    backend = resolved.llm_backend.lower()
    if backend == "openai":
        return resolved.resolved_openai_model
    if backend == "google":
        return resolved.google_model
    if backend == "auto":
        if resolved.openai_api_key:
            return resolved.resolved_openai_model
        if resolved.google_api_key:
            return resolved.google_model
    return None


@dataclass(frozen=True)
class PendingProcessingTask:
    task_key: str
    session_id: str
    source_provider: str
    source_session_id: str
    title: str | None
    transcript: str


class ExtensionBrowserProcessingService:
    def __init__(self, db: AsyncSession, *, settings: Settings | None = None) -> None:
        self.db = db
        self.settings = settings or get_settings()
        self.processor = SessionProcessor(db)
        self.exporter = MarkdownExporter(db)
        self.prompts = PromptTemplateService(db)

    async def status(self) -> ProcessingStatusResponse:
        if self.settings.llm_backend.lower() == "browser_proxy" and not browser_automation_enabled(self.settings):
            return ProcessingStatusResponse(
                enabled=False,
                mode="disabled",
                worker_model=self.settings.browser_llm_model,
                pending_count=0,
            )
        if not uses_extension_browser_processing(self.settings):
            return ProcessingStatusResponse(
                enabled=False,
                mode="immediate",
                worker_model=immediate_processing_model(self.settings),
                pending_count=0,
            )
        return ProcessingStatusResponse(
            enabled=True,
            mode="extension_browser",
            worker_model=self.settings.browser_llm_model,
            pending_count=await self.pending_count(),
        )

    async def pending_count(self) -> int:
        result = await self.db.execute(
            select(func.count(ChatSession.id)).where(self._pending_condition())
        )
        return int(result.scalar_one() or 0)

    async def next_task(self) -> ProcessingTaskResponse:
        if self.settings.llm_backend.lower() == "browser_proxy" and not browser_automation_enabled(self.settings):
            return ProcessingTaskResponse(available=False, worker_model=self.settings.browser_llm_model)
        if not uses_extension_browser_processing(self.settings):
            return ProcessingTaskResponse(available=False, worker_model=immediate_processing_model(self.settings))

        tasks = await self._next_pending_tasks()
        if not tasks:
            return ProcessingTaskResponse(available=False, worker_model=self.settings.browser_llm_model)

        return ProcessingTaskResponse(
            available=True,
            tasks=[
                ProcessingTaskItem(
                    task_key=task.task_key,
                    session_id=task.session_id,
                    source_provider=task.source_provider,
                    source_session_id=task.source_session_id,
                    title=task.title,
                )
                for task in tasks
            ],
            prompt=await self._build_prompt(
                tasks,
                current_todo_markdown=TodoListService(base_dir=self.exporter.base_dir).read_markdown(),
            ),
            worker_model=self.settings.browser_llm_model,
        )

    async def complete_task(self, session_ids: list[str], response_text: str) -> ProcessingCompleteResponse:
        try:
            parsed = self._parse_pipeline_results(session_ids, response_text)
        except ValueError as exc:
            raise ValueError(f"Could not parse the processing response as valid JSON: {exc}") from exc

        results: list[ProcessingCompleteResult] = []
        self.processor.base_dir = self.exporter.base_dir
        for item in parsed:
            session = await self.processor.apply_pipeline_result(
                item.session_id,
                SessionPipelineResult(
                    category=item.category,
                    classification_reason=item.classification_reason,
                    journal=item.journal,
                    todo=item.todo,
                    factual_triplets=item.factual_triplets,
                    idea=item.idea,
                ),
            )
            markdown_path = await self.exporter.write_session(session)
            session.markdown_path = str(markdown_path)
            results.append(
                ProcessingCompleteResult(
                    session_id=session.id,
                    category=session.category,
                    markdown_path=session.markdown_path,
                    processed=session.last_processed_at is not None,
                )
            )
        await self.db.commit()
        return ProcessingCompleteResponse(processed_count=len(results), results=results)

    async def _build_prompt(self, tasks: list[PendingProcessingTask], *, current_todo_markdown: str) -> str:
        prompt_tasks = [
            {
                "task_key": task.task_key,
                "source_provider": task.source_provider,
                "source_session_id": task.source_session_id,
                "title": task.title,
                "transcript": task.transcript,
            }
            for task in tasks
        ]
        prompt = await self.prompts.render(
            "processing.worker_batch",
            values={
                "current_todo_markdown": current_todo_markdown,
                "tasks_json": json.dumps(prompt_tasks, ensure_ascii=True, separators=(",", ":")),
            },
        )
        return f"{prompt.system_prompt}\n\n{prompt.user_prompt}".strip()

    async def _next_pending_tasks(self) -> list[PendingProcessingTask]:
        result = await self.db.execute(
            select(ChatSession)
            .options(
                selectinload(ChatSession.messages),
                selectinload(ChatSession.triplets),
            )
            .where(self._pending_condition())
            .order_by(ChatSession.last_captured_at.desc(), ChatSession.updated_at.desc())
            .limit(max(self.settings.processing_batch_size * 4, 24))
        )
        sessions = result.scalars().all()
        tasks: list[PendingProcessingTask] = []
        accumulated_chars = 0

        for session in sessions:
            if not session.messages:
                continue
            transcript = render_transcript(session.messages)
            if not transcript:
                continue

            task_chars = len(transcript) + len(session.title or "") + 256
            would_exceed_batch_size = len(tasks) >= self.settings.processing_batch_size
            would_exceed_char_limit = (
                bool(tasks)
                and accumulated_chars + task_chars > self.settings.processing_batch_max_chars
            )
            if would_exceed_batch_size or would_exceed_char_limit:
                break

            tasks.append(
                PendingProcessingTask(
                    task_key=f"task_{len(tasks) + 1}",
                    session_id=session.id,
                    source_provider=session.provider,
                    source_session_id=session.external_session_id,
                    title=session.title,
                    transcript=transcript,
                )
            )
            accumulated_chars += task_chars

        return tasks

    def _parse_pipeline_results(
        self,
        session_ids: list[str],
        response_text: str,
    ) -> list[ProcessingResultItem]:
        payload = extract_json_object(response_text)
        expected_ids = list(dict.fromkeys(session_ids))
        expected_task_keys = [f"task_{index + 1}" for index in range(len(expected_ids))]
        expected_task_key_map = dict(zip(expected_task_keys, expected_ids, strict=False))
        if not expected_ids:
            raise ValueError("No session_ids were provided for completion.")

        if "results" in payload:
            envelope = ProcessingResultEnvelope.model_validate(payload)
            raw_results = envelope.results
        elif len(expected_ids) == 1:
            single = SessionPipelineResult.model_validate(payload)
            raw_results = [
                ProcessingResultItem(
                    session_id=expected_ids[0],
                    task_key=expected_task_keys[0],
                    category=single.category,
                    classification_reason=single.classification_reason,
                    journal=single.journal,
                    todo=single.todo,
                    factual_triplets=single.factual_triplets,
                    idea=single.idea,
                )
            ]
        else:
            raise ValueError(
                f"Expected a JSON object with a 'results' array for task_keys {', '.join(expected_task_keys)}."
            )

        resolved_results: list[ProcessingResultItem] = []
        resolved_ids: list[str] = []

        for index, item in enumerate(raw_results):
            resolved_id = item.session_id if item.session_id in expected_ids else None
            if resolved_id is None and item.task_key in expected_task_key_map:
                resolved_id = expected_task_key_map[item.task_key]
            if resolved_id is None and item.session_id in expected_task_key_map:
                resolved_id = expected_task_key_map[item.session_id]
            if resolved_id is None and len(expected_ids) == 1 and len(raw_results) == 1:
                resolved_id = expected_ids[0]

            if resolved_id is None:
                raise ValueError(
                    "The processing response must include exactly these task_keys or session_ids: "
                    f"{', '.join(expected_task_keys)}."
                )

            resolved_ids.append(resolved_id)
            resolved_results.append(
                ProcessingResultItem(
                    session_id=resolved_id,
                    task_key=item.task_key or expected_task_keys[index],
                    category=item.category,
                    classification_reason=item.classification_reason,
                    journal=item.journal,
                    todo=item.todo,
                    factual_triplets=item.factual_triplets,
                    idea=item.idea,
                )
            )

        if len(set(resolved_ids)) != len(resolved_ids):
            raise ValueError("The processing response contains duplicate task keys or session_id values.")
        if set(resolved_ids) != set(expected_ids):
            raise ValueError(
                "The processing response must include exactly these task_keys or session_ids: "
                f"{', '.join(expected_task_keys)}."
            )

        result_map = {item.session_id: item for item in resolved_results if item.session_id is not None}
        return [result_map[session_id] for session_id in expected_ids]

    def _pending_condition(self):
        return or_(
            ChatSession.last_processed_at.is_(None),
            ChatSession.last_processed_at < ChatSession.last_captured_at,
        )
