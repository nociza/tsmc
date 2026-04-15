from __future__ import annotations

from typing import TYPE_CHECKING

from pydantic import BaseModel, Field

from app.core.config import get_settings
from app.models import ChatMessage
from app.schemas.processing import ClassificationResult, IdeaResult, JournalResult, TodoResult, TripletResult
from app.services.heuristics import (
    heuristic_classification,
    heuristic_idea,
    heuristic_journal,
    heuristic_triplets,
    is_explicit_todo_request,
)
from app.services.llm.base import LLMClient
from app.services.llm.browser_proxy_client import BrowserProxyClient
from app.services.llm.google_client import GoogleGenAIClient
from app.services.llm.openai_client import OpenAIClient
from app.services.todo import heuristic_todo_result

if TYPE_CHECKING:
    from app.services.browser_proxy.service import BrowserProxyService


class TripletListSchema(BaseModel):
    triplets: list[TripletResult] = Field(default_factory=list)


def render_transcript(messages: list[ChatMessage]) -> str:
    lines: list[str] = []
    for message in messages:
        lines.append(f"{message.role.value.upper()}: {message.content.strip()}")
    return "\n".join(lines).strip()


class ProcessingOrchestrator:
    def __init__(self, browser_proxy: BrowserProxyService | None = None) -> None:
        self.settings = get_settings()
        self.browser_proxy = browser_proxy
        self.client = self._resolve_client()

    def _resolve_client(self) -> LLMClient | None:
        backend = self.settings.llm_backend.lower()
        if backend == "browser_proxy":
            if not self.settings.experimental_browser_automation or self.browser_proxy is None:
                return None
            return BrowserProxyClient(self.browser_proxy, settings=self.settings)
        if backend == "openai":
            return OpenAIClient()
        if backend == "google":
            return GoogleGenAIClient()
        if backend == "auto":
            if self.settings.openai_api_key:
                return OpenAIClient()
            if self.settings.google_api_key:
                return GoogleGenAIClient()
        return None

    async def classify(self, messages: list[ChatMessage]) -> ClassificationResult:
        transcript = render_transcript(messages)
        if not transcript or not self.client:
            return heuristic_classification(messages)

        try:
            classification = await self.client.generate_json(
                system_prompt=(
                    "You classify transcripts into one of four buckets: journal, factual, ideas, or todo. "
                    "Return JSON with keys category and reason."
                ),
                user_prompt=(
                    "Classify this transcript. Use 'journal' for personal context, day-to-day planning, reminders, prioritization, or reflection. "
                    "Use 'todo' only when the user explicitly asks to create, edit, add, remove, reorder, reopen, or complete items on a shared to-do list or checklist file. "
                    "General planning, reminders, or scheduling are not 'todo' unless the transcript explicitly mentions modifying the shared to-do list. "
                    "Use 'factual' for coding, research, explanation, or objective Q&A. "
                    "Use 'ideas' for brainstorming, creative exploration, or original concepts.\n\n"
                    f"{transcript}"
                ),
                schema=ClassificationResult,
            )
            if is_explicit_todo_request(messages):
                if classification.category == SessionCategory.TODO:
                    return classification
                return heuristic_classification(messages)
            if classification.category == SessionCategory.TODO:
                return heuristic_classification(messages)
            return classification
        except Exception:
            return heuristic_classification(messages)

    async def journal(self, messages: list[ChatMessage]) -> JournalResult:
        transcript = render_transcript(messages)
        if not transcript or not self.client:
            return heuristic_journal(messages)

        try:
            return await self.client.generate_json(
                system_prompt=(
                    "You write concise diary-style notes from a user transcript. "
                    "Return JSON with keys entry and action_items."
                ),
                user_prompt=(
                    "Summarize the transcript into a short journal entry focused on the user's context and action items. "
                    "Strip AI filler and keep the note grounded and practical.\n\n"
                    f"{transcript}"
                ),
                schema=JournalResult,
            )
        except Exception:
            return heuristic_journal(messages)

    async def factual_triplets(self, messages: list[ChatMessage]) -> list[TripletResult]:
        transcript = render_transcript(messages)
        if not transcript or not self.client:
            return heuristic_triplets(messages)

        try:
            wrapper = await self.client.generate_json(
                system_prompt=(
                    "Extract subject-predicate-object triplets from factual transcripts. "
                    "Return JSON with one key named triplets containing a list of objects with subject, predicate, object, confidence."
                ),
                user_prompt=(
                    "Extract the clearest factual relationships from this transcript. "
                    "Use normalized predicates and skip speculative relationships. "
                    "Prefer durable entities such as libraries, frameworks, protocols, runtimes, files, or products. "
                    "Avoid vague outcome phrases, generic adjectives, and long descriptive clauses as nodes. "
                    "Keep the set small and high signal.\n\n"
                    f"{transcript}"
                ),
                schema=TripletListSchema,
            )
            return wrapper.triplets
        except Exception:
            return heuristic_triplets(messages)

    async def todo(self, messages: list[ChatMessage], current_markdown: str) -> TodoResult:
        transcript = render_transcript(messages)
        if not transcript or not self.client:
            return heuristic_todo_result(messages, current_markdown)

        try:
            return await self.client.generate_json(
                system_prompt=(
                    "You maintain a single shared markdown to-do list for a user. "
                    "Return JSON with keys summary and updated_markdown."
                ),
                user_prompt=(
                    "Update the shared markdown to-do list using the transcript.\n"
                    "Only apply changes the user clearly requested to the shared to-do list.\n"
                    "Do not turn general planning advice into to-do items unless the transcript explicitly asks to modify the shared list.\n"
                    "Preserve unfinished work unless the transcript says to remove or complete it.\n"
                    "Keep the response markdown concise and readable for Obsidian.\n"
                    "The file should remain a complete standalone markdown document.\n\n"
                    "Current to-do list markdown:\n"
                    f"{current_markdown}\n\n"
                    "Transcript:\n"
                    f"{transcript}"
                ),
                schema=TodoResult,
            )
        except Exception:
            return heuristic_todo_result(messages, current_markdown)

    async def ideas(self, messages: list[ChatMessage]) -> IdeaResult:
        transcript = render_transcript(messages)
        if not transcript or not self.client:
            return heuristic_idea(messages)

        try:
            return await self.client.generate_json(
                system_prompt=(
                    "Summarize ideation transcripts. "
                    "Return JSON with keys core_idea, pros, cons, next_steps, and share_post."
                ),
                user_prompt=(
                    "Distill the transcript into a structured brainstorm summary. "
                    "Keep the share_post concise, specific, and credible. "
                    "Avoid hype words such as revolutionary, effortless, unlock, game-changing, or world-class. "
                    "Write it like a thoughtful builder note that another person would actually want to share.\n\n"
                    f"{transcript}"
                ),
                schema=IdeaResult,
            )
        except Exception:
            return heuristic_idea(messages)
