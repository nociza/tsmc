from __future__ import annotations

from app.models import MessageRole, SessionCategory
from app.schemas.ingest import IngestMessage
from app.services.heuristics import heuristic_classification, heuristic_idea, heuristic_journal, heuristic_triplets


class StubMessage:
    def __init__(self, role: MessageRole, content: str) -> None:
        self.role = role
        self.content = content


def test_classifies_journal_like_conversation() -> None:
    messages = [
        StubMessage(MessageRole.USER, "Today I need to sort out my schedule and family plans."),
        StubMessage(MessageRole.ASSISTANT, "Start by blocking the important errands."),
    ]

    result = heuristic_classification(messages)  # type: ignore[arg-type]
    assert result.category == SessionCategory.JOURNAL


def test_extracts_triplets_from_factual_text() -> None:
    messages = [
        StubMessage(MessageRole.USER, "FastAPI uses uvloop. SQLite supports lightweight local storage."),
    ]

    triplets = heuristic_triplets(messages)  # type: ignore[arg-type]
    assert any(triplet.subject == "FastAPI" and triplet.predicate == "uses" for triplet in triplets)


def test_does_not_extract_triplet_from_question_prompt() -> None:
    messages = [
        StubMessage(MessageRole.USER, "Explain how FastAPI uses uvloop in an async backend."),
        StubMessage(MessageRole.ASSISTANT, "FastAPI uses uvloop to run the event loop with high-performance async I/O."),
    ]

    triplets = heuristic_triplets(messages)  # type: ignore[arg-type]
    assert not any(triplet.subject.lower().startswith("explain") for triplet in triplets)
    assert any(triplet.subject == "FastAPI" and triplet.predicate == "uses" for triplet in triplets)


def test_idea_summary_generates_share_post() -> None:
    messages = [
        StubMessage(MessageRole.USER, "Brainstorm a local-first extension that turns AI chats into structured notes."),
        StubMessage(MessageRole.ASSISTANT, "A prototype would help validate the workflow quickly."),
    ]

    result = heuristic_idea(messages)  # type: ignore[arg-type]
    assert result.share_post
    assert len(result.share_post) <= 280


def test_journal_summary_includes_action_items() -> None:
    messages = [
        StubMessage(MessageRole.USER, "I need to call the contractor and should book the inspection tomorrow."),
        StubMessage(MessageRole.ASSISTANT, "Next, consider preparing the permit paperwork."),
    ]

    result = heuristic_journal(messages)  # type: ignore[arg-type]
    assert "call the contractor" in " ".join(result.action_items).lower()


def test_journal_summary_does_not_emit_ellipsis_for_long_assistant_message() -> None:
    messages = [
        StubMessage(MessageRole.USER, "What should I bring on a ski trip tomorrow?"),
        StubMessage(
            MessageRole.ASSISTANT,
            (
                "For your trip tomorrow, bring warm layers and waterproof gloves. "
                "Check the snow forecast before you leave. "
                "Pack sunscreen because the snow reflects UV strongly."
            ),
        ),
    ]

    result = heuristic_journal(messages)  # type: ignore[arg-type]
    assert "…" not in result.entry
    assert "For your trip tomorrow, bring warm layers and waterproof gloves." in result.entry


def test_journal_fallback_action_items_do_not_match_partial_words() -> None:
    messages = [
        StubMessage(MessageRole.USER, "What should I bring on a ski trip tomorrow?"),
        StubMessage(
            MessageRole.ASSISTANT,
            "Snow is starting in the late evening, but the current forecast is still uncertain.",
        ),
    ]

    result = heuristic_journal(messages)  # type: ignore[arg-type]
    assert not any("starting in the late evening" in item.lower() for item in result.action_items)
