from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.models.enums import PileKind, SessionCategory


PILE_ATTRIBUTES: frozenset[str] = frozenset(
    {
        "summary",
        "chronological",
        "queryable_qa",
        "knowledge_graph",
        "share_post",
        "alternate_phrasings",
        "importance",
        "deadline",
        "completion",
    }
)


@dataclass(frozen=True)
class PileSeed:
    slug: str
    name: str
    description: str
    kind: PileKind
    folder_label: str
    attributes: tuple[str, ...]
    pipeline_config: dict[str, Any] = field(default_factory=dict)
    is_visible_on_dashboard: bool = True
    sort_order: int = 0

    def attributes_list(self) -> list[str]:
        return list(self.attributes)


DEFAULT_PILES: tuple[PileSeed, ...] = (
    PileSeed(
        slug="journal",
        name="Journal",
        description=(
            "Personal context, day-to-day planning, reminders, prioritization, and reflection. "
            "Stored chronologically with action items extracted from the conversation."
        ),
        kind=PileKind.BUILT_IN_JOURNAL,
        folder_label="Journal",
        attributes=("summary", "chronological", "queryable_qa"),
        sort_order=10,
    ),
    PileSeed(
        slug="factual",
        name="Factual",
        description=(
            "Coding, research, explanation, and objective Q&A. Triplets are extracted into the "
            "shared knowledge graph alongside a short summary."
        ),
        kind=PileKind.BUILT_IN_FACTUAL,
        folder_label="Factual",
        attributes=("summary", "knowledge_graph"),
        sort_order=20,
    ),
    PileSeed(
        slug="ideas",
        name="Ideas",
        description=(
            "Brainstorming, creative exploration, and original concepts. Produces a structured "
            "summary, alternate phrasings of the core idea, and a shareable post."
        ),
        kind=PileKind.BUILT_IN_IDEAS,
        folder_label="Ideas",
        attributes=("summary", "knowledge_graph", "share_post", "alternate_phrasings"),
        sort_order=30,
    ),
    PileSeed(
        slug="todo",
        name="Todo",
        description=(
            "Explicit edits to the shared to-do list. The to-do pile updates Dashboards/To-Do List.md "
            "with importance, deadline, and completion attributes."
        ),
        kind=PileKind.BUILT_IN_TODO,
        folder_label="Todo",
        attributes=("chronological", "importance", "deadline", "completion"),
        sort_order=40,
    ),
    PileSeed(
        slug="discarded",
        name="Discarded",
        description=(
            "Captured but not processed. Sessions land here when a discard word is detected at the "
            "start of the conversation, when the LLM matches an auto-discard category, or when the "
            "user manually moves them. Discarded notes are kept chronologically and never appear on "
            "the main dashboard, but stay recoverable."
        ),
        kind=PileKind.BUILT_IN_DISCARDED,
        folder_label="Discarded",
        attributes=("chronological",),
        pipeline_config={
            "auto_discard_categories": [],
            "custom_prompt_addendum": None,
        },
        is_visible_on_dashboard=False,
        sort_order=900,
    ),
)


SLUG_BY_BUILT_IN_KIND: dict[PileKind, str] = {seed.kind: seed.slug for seed in DEFAULT_PILES}
BUILT_IN_KIND_BY_SLUG: dict[str, PileKind] = {seed.slug: seed.kind for seed in DEFAULT_PILES}


CATEGORY_TO_BUILT_IN_SLUG: dict[SessionCategory, str] = {
    SessionCategory.JOURNAL: "journal",
    SessionCategory.FACTUAL: "factual",
    SessionCategory.IDEAS: "ideas",
    SessionCategory.TODO: "todo",
    SessionCategory.DISCARDED: "discarded",
}


BUILT_IN_SLUG_TO_CATEGORY: dict[str, SessionCategory] = {
    slug: category for category, slug in CATEGORY_TO_BUILT_IN_SLUG.items()
}


def category_for_pile_slug(slug: str | None) -> SessionCategory | None:
    if not slug:
        return None
    return BUILT_IN_SLUG_TO_CATEGORY.get(slug)


def pile_slug_for_category(category: SessionCategory | None) -> str | None:
    if category is None:
        return None
    return CATEGORY_TO_BUILT_IN_SLUG.get(category)


def is_built_in_slug(slug: str | None) -> bool:
    return bool(slug) and slug in BUILT_IN_KIND_BY_SLUG


def pipeline_prompt_addendum_from_config(config: dict[str, Any] | None) -> str | None:
    if not isinstance(config, dict):
        return None
    for key in ("pipeline_prompt_addendum", "custom_prompt_addendum"):
        value = config.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None
