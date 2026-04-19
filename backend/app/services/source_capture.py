from __future__ import annotations

from dataclasses import dataclass

from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ChatMessage, MessageRole, SourceCapture
from app.models.enums import SessionCategory
from app.schemas.source_capture import SourceCaptureRequest, SourceCaptureResponse
from app.services.heuristics import heuristic_classification
from app.services.markdown import MarkdownExporter
from app.services.orchestrator import ProcessingOrchestrator
from app.services.prompt_templates import PromptTemplateService
from app.services.text import normalize_whitespace, take_sentences


class SourceCaptureAIResult(BaseModel):
    title: str
    category: SessionCategory
    classification_reason: str
    summary: str
    cleaned_markdown: str


@dataclass
class SourceCaptureEnrichment:
    title: str
    category: SessionCategory | None
    classification_reason: str | None
    summary: str | None
    cleaned_markdown: str | None


class SourceCaptureProcessor:
    def __init__(self, db: AsyncSession | None = None) -> None:
        self.orchestrator = ProcessingOrchestrator(db=db)
        self.client = self.orchestrator.client
        self.prompts = PromptTemplateService(db)

    async def enrich(self, payload: SourceCaptureRequest) -> SourceCaptureEnrichment:
        transcript = self._build_transcript(payload)
        if self.client:
            try:
                prompt = await self.prompts.render(
                    "capture.enrich",
                    values={
                        "capture_kind": payload.capture_kind,
                        "save_mode": payload.save_mode,
                        "page_title": payload.page_title or "n/a",
                        "source_url": payload.source_url or "n/a",
                        "source_markdown": payload.source_markdown or "n/a",
                        "transcript": transcript,
                    },
                )
                result = await self.client.generate_json(
                    system_prompt=prompt.system_prompt,
                    user_prompt=prompt.user_prompt,
                    schema=SourceCaptureAIResult,
                )
                return SourceCaptureEnrichment(
                    title=result.title.strip() or self._fallback_title(payload),
                    category=result.category,
                    classification_reason=result.classification_reason.strip() or "AI-enriched source capture.",
                    summary=result.summary.strip() or take_sentences(transcript, 2),
                    cleaned_markdown=result.cleaned_markdown.strip() or self._fallback_markdown(payload),
                )
            except Exception:
                pass

        return self._heuristic_enrichment(payload)

    def _heuristic_enrichment(self, payload: SourceCaptureRequest) -> SourceCaptureEnrichment:
        transcript = self._build_transcript(payload)
        synthetic_messages = [
            ChatMessage(
                session_id="source-capture",
                external_message_id="source-capture",
                role=MessageRole.USER,
                content=transcript,
                sequence_index=1,
            )
        ]
        heuristic_result = heuristic_classification(synthetic_messages)
        return SourceCaptureEnrichment(
            title=self._fallback_title(payload),
            category=heuristic_result.category,
            classification_reason=heuristic_result.reason,
            summary=take_sentences(transcript, 2),
            cleaned_markdown=self._fallback_markdown(payload),
        )

    def _fallback_title(self, payload: SourceCaptureRequest) -> str:
        explicit = normalize_whitespace(payload.title or payload.page_title or "")
        if explicit:
            return explicit
        selection = normalize_whitespace(payload.selection_text or "")
        if selection:
            return take_sentences(selection, 1)[:160] or "Saved selection"
        return take_sentences(payload.source_text, 1)[:160] or "Saved page"

    def _fallback_markdown(self, payload: SourceCaptureRequest) -> str:
        if payload.source_markdown and payload.source_markdown.strip():
            return payload.source_markdown.strip()
        lines = [line.strip() for line in payload.source_text.splitlines()]
        compact = [line for line in lines if line]
        return "\n\n".join(compact).strip()

    def _build_transcript(self, payload: SourceCaptureRequest) -> str:
        primary = payload.selection_text or payload.source_text
        return normalize_whitespace(primary)


class SourceCaptureService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.processor = SourceCaptureProcessor(db)
        self.exporter = MarkdownExporter(db)

    async def capture(self, payload: SourceCaptureRequest) -> SourceCaptureResponse:
        source_text = payload.source_text.strip()
        source_capture = SourceCapture(
            capture_kind=payload.capture_kind,
            save_mode=payload.save_mode,
            title=normalize_whitespace(payload.title or payload.page_title or "") or None,
            page_title=normalize_whitespace(payload.page_title or "") or None,
            source_url=payload.source_url.strip() if payload.source_url else None,
            selection_text=payload.selection_text.strip() if payload.selection_text else None,
            source_text=source_text,
            source_markdown=(payload.source_markdown.strip() if payload.source_markdown else None),
            raw_payload=payload.raw_payload,
        )

        if payload.save_mode == "ai":
            enrichment = await self.processor.enrich(payload)
            source_capture.title = enrichment.title
            source_capture.category = enrichment.category
            source_capture.classification_reason = enrichment.classification_reason
            source_capture.summary = enrichment.summary
            source_capture.cleaned_markdown = enrichment.cleaned_markdown
        else:
            source_capture.title = source_capture.title or self.processor._fallback_title(payload)
            source_capture.cleaned_markdown = self.processor._fallback_markdown(payload)

        self.db.add(source_capture)
        await self.db.flush()

        markdown_path, raw_source_path = await self.exporter.write_source_capture(source_capture)
        source_capture.markdown_path = str(markdown_path)
        source_capture.raw_source_path = str(raw_source_path)
        await self.db.commit()
        await self.db.refresh(source_capture)

        return SourceCaptureResponse(
            source_id=source_capture.id,
            title=source_capture.title or "Saved source",
            capture_kind=payload.capture_kind,
            save_mode=payload.save_mode,
            processed=payload.save_mode == "ai",
            category=source_capture.category,
            markdown_path=source_capture.markdown_path,
            raw_source_path=source_capture.raw_source_path,
        )
