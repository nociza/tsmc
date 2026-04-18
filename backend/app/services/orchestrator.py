from __future__ import annotations

from typing import TYPE_CHECKING

from pydantic import BaseModel, Field

from app.core.config import get_settings
from app.models import ChatMessage
from app.models.enums import SessionCategory
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

    async def classify(
        self,
        messages: list[ChatMessage],
        *,
        auto_discard_categories: list[str] | None = None,
    ) -> ClassificationResult:
        transcript = render_transcript(messages)
        if not transcript or not self.client:
            return heuristic_classification(messages)

        cleaned_discard = [item.strip() for item in (auto_discard_categories or []) if item and item.strip()]
        discard_addendum = ""
        if cleaned_discard:
            joined = "; ".join(f"'{item}'" for item in cleaned_discard)
            discard_addendum = (
                "\nIf the transcript clearly fits one of the user's auto-discard categories "
                f"({joined}), return category='discarded' with a short reason naming the matching category. "
                "Otherwise, never use 'discarded'."
            )

        try:
            classification = await self.client.generate_json(
                system_prompt=(
                    "You classify transcripts into one of these buckets: journal, factual, ideas, todo, or discarded. "
                    "Return JSON with keys category and reason."
                ),
                user_prompt=(
                    "Classify this transcript. Use 'journal' for personal context, day-to-day planning, reminders, prioritization, or reflection. "
                    "Use 'todo' only when the user explicitly asks to create, edit, add, remove, reorder, reopen, or complete items on a shared to-do list or checklist file. "
                    "General planning, reminders, or scheduling are not 'todo' unless the transcript explicitly mentions modifying the shared to-do list. "
                    "Use 'factual' for coding, research, explanation, or objective Q&A. "
                    "Use 'ideas' for brainstorming, creative exploration, or original concepts."
                    f"{discard_addendum}\n\n"
                    f"{transcript}"
                ),
                schema=ClassificationResult,
            )
            if classification.category == SessionCategory.DISCARDED:
                if cleaned_discard:
                    return classification
                # If auto-discard isn't configured, ignore the model's discard label.
                return heuristic_classification(messages)
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

    async def pile_outputs(
        self,
        messages: list[ChatMessage],
        *,
        attributes: list[str],
        custom_prompt_addendum: str | None = None,
    ) -> dict[str, object]:
        """Run the generic attribute-driven pipeline for a user-defined pile.

        Each attribute that we know how to handle adds a structured key to the
        returned dict. Unknown attributes are silently ignored. The dict is a
        plain JSON-serializable shape that gets stored on `ChatSession.pile_outputs`.
        """
        transcript = render_transcript(messages)
        wanted = {attr for attr in attributes if attr}
        if not transcript or not wanted:
            return {}
        if not self.client:
            return _heuristic_pile_outputs(messages, wanted)

        # Ask one structured call for everything we need at once. This keeps user
        # piles cheap even when they enable several attributes.
        attr_lines: list[str] = []
        if "summary" in wanted:
            attr_lines.append("- summary: 1-3 sentence neutral synopsis of what the user took away.")
        if "queryable_qa" in wanted:
            attr_lines.append(
                "- qa_pairs: up to 4 objects {question, answer} suited for later semantic search."
            )
        if "share_post" in wanted:
            attr_lines.append("- share_post: a tweet-sized (<=280 chars) credible note the user would share.")
        if "alternate_phrasings" in wanted:
            attr_lines.append(
                "- alternate_phrasings: up to 3 differently worded restatements of the core takeaway."
            )
        if "importance" in wanted:
            attr_lines.append("- importance: integer 1-5 (1 trivial, 5 critical).")
        if "deadline" in wanted:
            attr_lines.append(
                "- deadline: ISO-8601 date if the transcript clearly mentions one, else null."
            )
        if "completion" in wanted:
            attr_lines.append("- completion: 'open' | 'in_progress' | 'done' if discernible, else 'open'.")
        if not attr_lines:
            return {}

        addendum = f"\n\nAdditional pile-specific instructions:\n{custom_prompt_addendum.strip()}" if custom_prompt_addendum else ""
        request = (
            "Extract the following fields from the transcript. Return STRICT JSON with only these keys (omit any that "
            "aren't requested). Use null for fields you cannot ground in the transcript:\n"
            + "\n".join(attr_lines)
            + addendum
            + "\n\nTranscript:\n"
            + transcript
        )

        try:
            from pydantic import BaseModel as _BaseModel, Field as _Field

            class _GenericPileOutput(_BaseModel):
                model_config = {"extra": "allow"}
                summary: str | None = None
                qa_pairs: list[dict[str, str]] = _Field(default_factory=list)
                share_post: str | None = None
                alternate_phrasings: list[str] = _Field(default_factory=list)
                importance: int | None = None
                deadline: str | None = None
                completion: str | None = None

            raw = await self.client.generate_json(
                system_prompt=(
                    "You extract structured fields from a transcript for a user-defined note pile. "
                    "Return JSON only, no commentary."
                ),
                user_prompt=request,
                schema=_GenericPileOutput,
            )
            payload = raw.model_dump(exclude_none=True)
            return {key: value for key, value in payload.items() if key in wanted}
        except Exception:
            return _heuristic_pile_outputs(messages, wanted)


def _heuristic_pile_outputs(messages: list[ChatMessage], wanted: set[str]) -> dict[str, object]:
    from app.services.heuristics import heuristic_idea, heuristic_journal

    out: dict[str, object] = {}
    if "summary" in wanted or "alternate_phrasings" in wanted or "share_post" in wanted:
        idea = heuristic_idea(messages)
        if "summary" in wanted:
            out["summary"] = idea.core_idea
        if "share_post" in wanted:
            out["share_post"] = idea.share_post
        if "alternate_phrasings" in wanted:
            phrasings = [idea.core_idea]
            phrasings.extend(idea.next_steps[:2])
            out["alternate_phrasings"] = [phrase for phrase in phrasings if phrase][:3]
    if "queryable_qa" in wanted:
        journal = heuristic_journal(messages)
        out["qa_pairs"] = (
            [{"question": "What did the user discuss?", "answer": journal.entry[:280]}] if journal.entry else []
        )
    if "importance" in wanted:
        out["importance"] = 3
    if "completion" in wanted:
        out["completion"] = "open"
    return out
