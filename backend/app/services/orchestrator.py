from __future__ import annotations

from typing import TYPE_CHECKING

from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.models import ChatMessage
from app.models.enums import SessionCategory
from app.prompts import BUILT_IN_PILE_RULES
from app.schemas.processing import (
    ClassificationResult,
    FactualResult,
    IdeaResult,
    JournalResult,
    PileClassificationResult,
    SegmentedClassificationResult,
    SegmentRouting,
    TodoResult,
    TripletResult,
)
from app.services.heuristics import (
    _slice_is_explicit_todo_request,
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
from app.services.prompt_templates import PromptTemplateService
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


def render_indexed_transcript(messages: list[ChatMessage]) -> str:
    """Transcript with a leading message index so the classifier can carve ranges."""
    lines: list[str] = []
    for index, message in enumerate(messages):
        lines.append(f"[{index}] {message.role.value.upper()}: {message.content.strip()}")
    return "\n".join(lines).strip()


class ProcessingOrchestrator:
    def __init__(self, browser_proxy: BrowserProxyService | None = None, db: AsyncSession | None = None) -> None:
        self.settings: Settings = get_settings()
        self.db = db
        self.browser_proxy = browser_proxy
        self.prompts = PromptTemplateService(db)
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
        discard_addendum_block = ""
        if cleaned_discard:
            joined = "; ".join(f"'{item}'" for item in cleaned_discard)
            discard_addendum_block = (
                "\nIf the transcript clearly fits one of the user's auto-discard categories "
                f"({joined}), return category='discarded' with a short reason naming the matching category. "
                "Otherwise, never use 'discarded'."
            )

        try:
            prompt = await self.prompts.render(
                "processing.classify",
                values={
                    "built_in_pile_rules": BUILT_IN_PILE_RULES,
                    "discard_addendum_block": discard_addendum_block,
                    "transcript": transcript,
                },
            )
            classification = await self.client.generate_json(
                system_prompt=prompt.system_prompt,
                user_prompt=prompt.user_prompt,
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

    async def classify_pile(
        self,
        messages: list[ChatMessage],
        *,
        candidates: list[tuple[str, str]],
        auto_discard_categories: list[str] | None = None,
    ) -> PileClassificationResult | None:
        """Pick a pile slug from the supplied candidate list.

        `candidates` is an ordered list of (slug, description) tuples representing
        every active pile the user wants the classifier to consider. Returns
        `None` when no transcript / no LLM, so callers can fall back to the
        built-in 4-bucket heuristic. Returns `None` if the model picks a slug
        not in `candidates` (treated as a hallucination).
        """
        if not candidates:
            return None
        transcript = render_transcript(messages)
        if not transcript or not self.client:
            return None

        candidate_lines = "\n".join(f"- '{slug}': {description.strip()}" for slug, description in candidates)
        cleaned_discard = [item.strip() for item in (auto_discard_categories or []) if item and item.strip()]
        discard_addendum_block = ""
        if cleaned_discard:
            joined = "; ".join(f"'{item}'" for item in cleaned_discard)
            discard_addendum_block = (
                f"\nIf the transcript clearly fits an auto-discard category ({joined}), pick the 'discarded' pile."
            )

        valid_slugs = {slug for slug, _ in candidates}

        try:
            prompt = await self.prompts.render(
                "processing.classify_pile",
                values={
                    "discard_addendum_block": discard_addendum_block,
                    "candidate_lines": candidate_lines,
                    "transcript": transcript,
                },
            )
            result = await self.client.generate_json(
                system_prompt=prompt.system_prompt,
                user_prompt=prompt.user_prompt,
                schema=PileClassificationResult,
            )
            slug = (result.pile_slug or "").strip()
            if slug not in valid_slugs:
                return None
            if slug == "discarded" and not cleaned_discard:
                # Don't trust a 'discarded' pick when auto-discard isn't configured.
                return None
            if slug == "todo" and not is_explicit_todo_request(messages):
                # Same guardrail as the legacy classifier.
                return None
            return PileClassificationResult(pile_slug=slug, reason=result.reason)
        except Exception:
            return None

    async def classify_segments(
        self,
        messages: list[ChatMessage],
        *,
        candidates: list[tuple[str, str]] | None = None,
        auto_discard_categories: list[str] | None = None,
    ) -> list[SegmentRouting]:
        """Split a session into contiguous segments, each routed to a pile.

        Returns `[]` when no LLM is configured or when the model's response is
        unusable; callers should fall back to single-pile classification. When
        the transcript is short or clearly on a single topic, the model is free
        to return a single segment spanning the whole session.
        """
        if not messages:
            return []
        transcript = render_indexed_transcript(messages)
        if not transcript or not self.client:
            return []

        if not candidates:
            candidates = [
                ("journal", "Personal day-to-day life, routines, relationships, reflection."),
                ("factual", "Objective reference knowledge: coding, research, explanation."),
                ("ideas", "The user's own original thoughts, brainstorming, speculation."),
                ("todo", "Explicit add/edit/remove on the shared to-do list."),
            ]
        candidate_lines = "\n".join(f"- '{slug}': {description.strip()}" for slug, description in candidates)
        valid_slugs = {slug for slug, _ in candidates}
        total = len(messages)
        cleaned_discard = [item.strip() for item in (auto_discard_categories or []) if item and item.strip()]

        try:
            prompt = await self.prompts.render(
                "processing.segment",
                values={
                    "built_in_pile_rules": BUILT_IN_PILE_RULES,
                    "candidate_lines": candidate_lines,
                    "last_message_index": max(total - 1, 0),
                    "transcript": transcript,
                },
            )
            result = await self.client.generate_json(
                system_prompt=prompt.system_prompt,
                user_prompt=prompt.user_prompt,
                schema=SegmentedClassificationResult,
            )
        except Exception:
            return []

        segments = [seg for seg in result.segments if seg.pile_slug in valid_slugs]
        if not segments:
            return []
        segments.sort(key=lambda seg: seg.start_index)
        # Clip to valid range and ensure contiguity.
        cleaned: list[SegmentRouting] = []
        cursor = 0
        for seg in segments:
            start = max(seg.start_index, cursor)
            end = min(seg.end_index, total - 1)
            if end < start:
                continue
            if seg.pile_slug == "discarded" and not cleaned_discard:
                # Don't trust 'discarded' unless auto-discard is configured.
                continue
            if seg.pile_slug == "todo" and not _slice_is_explicit_todo_request(messages, start, end):
                # Same guardrail as the single-shot classifier.
                continue
            cleaned.append(
                SegmentRouting(
                    pile_slug=seg.pile_slug,
                    reason=seg.reason,
                    start_index=start,
                    end_index=end,
                )
            )
            cursor = end + 1
        if not cleaned:
            return []
        if cleaned[-1].end_index < total - 1:
            # Extend the last segment to cover any trailing messages the model skipped.
            last = cleaned[-1]
            cleaned[-1] = SegmentRouting(
                pile_slug=last.pile_slug,
                reason=last.reason,
                start_index=last.start_index,
                end_index=total - 1,
            )
        # Collapse consecutive segments that pick the same pile.
        merged: list[SegmentRouting] = []
        for seg in cleaned:
            if merged and merged[-1].pile_slug == seg.pile_slug and merged[-1].end_index + 1 == seg.start_index:
                prev = merged[-1]
                merged[-1] = SegmentRouting(
                    pile_slug=prev.pile_slug,
                    reason=prev.reason,
                    start_index=prev.start_index,
                    end_index=seg.end_index,
                )
            else:
                merged.append(seg)
        return merged

    async def journal(self, messages: list[ChatMessage], *, prompt_addendum: str | None = None) -> JournalResult:
        transcript = render_transcript(messages)
        if not transcript or not self.client:
            return heuristic_journal(messages)

        try:
            prompt = await self.prompts.render(
                "processing.journal",
                values={
                    "pile_addendum_block": self._pile_addendum_block(prompt_addendum),
                    "transcript": transcript,
                },
            )
            return await self.client.generate_json(
                system_prompt=prompt.system_prompt,
                user_prompt=prompt.user_prompt,
                schema=JournalResult,
            )
        except Exception:
            return heuristic_journal(messages)

    async def factual_triplets(
        self,
        messages: list[ChatMessage],
        *,
        prompt_addendum: str | None = None,
    ) -> list[TripletResult]:
        result = await self.factual(messages, prompt_addendum=prompt_addendum)
        return result.triplets

    async def factual(self, messages: list[ChatMessage], *, prompt_addendum: str | None = None) -> FactualResult:
        """Factuals are a lightweight substrate: a queryable dump of the user's
        referenced facts. Triplets are emitted for rough semantic anchoring, not
        for strong graph enforcement. Graph visualization renders these as a
        loose concept map rather than a dependency DAG.
        """
        transcript = render_transcript(messages)
        if not transcript or not self.client:
            return FactualResult(triplets=heuristic_triplets(messages))

        try:
            prompt = await self.prompts.render(
                "processing.factual",
                values={
                    "pile_addendum_block": self._pile_addendum_block(prompt_addendum),
                    "transcript": transcript,
                },
            )
            wrapper = await self.client.generate_json(
                system_prompt=prompt.system_prompt,
                user_prompt=prompt.user_prompt,
                schema=FactualResult,
            )
            return wrapper
        except Exception:
            return FactualResult(triplets=heuristic_triplets(messages))

    async def todo(
        self,
        messages: list[ChatMessage],
        current_markdown: str,
        *,
        prompt_addendum: str | None = None,
    ) -> TodoResult:
        transcript = render_transcript(messages)
        if not transcript or not self.client:
            return heuristic_todo_result(messages, current_markdown)

        try:
            prompt = await self.prompts.render(
                "processing.todo",
                values={
                    "pile_addendum_block": self._pile_addendum_block(prompt_addendum),
                    "current_todo_markdown": current_markdown,
                    "transcript": transcript,
                },
            )
            return await self.client.generate_json(
                system_prompt=prompt.system_prompt,
                user_prompt=prompt.user_prompt,
                schema=TodoResult,
            )
        except Exception:
            return heuristic_todo_result(messages, current_markdown)

    async def ideas(self, messages: list[ChatMessage], *, prompt_addendum: str | None = None) -> IdeaResult:
        """Ideas are dynamic. Each idea can evolve across sessions, conflict
        with prior threads, and anchor on facts. The structured output keeps
        the graph of threads rich enough to visualize reasoning steps later.
        """
        transcript = render_transcript(messages)
        if not transcript or not self.client:
            return heuristic_idea(messages)

        try:
            prompt = await self.prompts.render(
                "processing.ideas",
                values={
                    "pile_addendum_block": self._pile_addendum_block(prompt_addendum),
                    "transcript": transcript,
                },
            )
            return await self.client.generate_json(
                system_prompt=prompt.system_prompt,
                user_prompt=prompt.user_prompt,
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

        prompt = await self.prompts.render(
            "processing.user_pile",
            values={
                "requested_fields": "\n".join(attr_lines),
                "pile_addendum_block": self._pile_addendum_block(custom_prompt_addendum),
                "transcript": transcript,
            },
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
                system_prompt=prompt.system_prompt,
                user_prompt=prompt.user_prompt,
                schema=_GenericPileOutput,
            )
            payload = raw.model_dump(exclude_none=True)
            return {key: value for key, value in payload.items() if key in wanted}
        except Exception:
            return _heuristic_pile_outputs(messages, wanted)

    @staticmethod
    def _pile_addendum_block(prompt_addendum: str | None) -> str:
        cleaned = (prompt_addendum or "").strip()
        if not cleaned:
            return ""
        return f"\n\nAdditional pile-specific instructions:\n{cleaned}"


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
