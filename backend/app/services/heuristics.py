from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable

from app.models import ChatMessage, MessageRole, SessionCategory
from app.schemas.processing import ClassificationResult, IdeaResult, JournalResult, TripletResult
from app.services.text import compact_lines, normalize_whitespace, take_sentences, truncate_text


JOURNAL_TERMS = {
    "today",
    "tomorrow",
    "week",
    "schedule",
    "routine",
    "habit",
    "family",
    "friend",
    "feeling",
    "reflect",
    "reflection",
    "life",
    "personal",
    "health",
    "stress",
    "journal",
}
IDEA_TERMS = {
    "idea",
    "brainstorm",
    "concept",
    "creative",
    "story",
    "startup",
    "thesis",
    "pitch",
    "brand",
    "experiment",
    "what if",
    "vision",
    "product",
}
FACTUAL_TERMS = {
    "api",
    "code",
    "debug",
    "error",
    "history",
    "science",
    "math",
    "explain",
    "how",
    "why",
    "what",
    "fastapi",
    "python",
    "typescript",
}

ACTION_PATTERNS = (
    re.compile(r"\b(?:need to|should|must|todo|next step|remember to)\b(?P<rest>[^.!\n]+)", re.I),
    re.compile(r"\b(?:action item|follow up):\s*(?P<rest>[^.!\n]+)", re.I),
)
FALLBACK_ACTION_RE = re.compile(r"\b(?:next|try|consider|start)\b", re.I)

TRIPLET_PATTERNS = (
    (re.compile(r"(?P<subject>[A-Za-z][A-Za-z0-9_.+\-/ ]{1,80}?)\s+uses\s+(?P<object>[A-Za-z][A-Za-z0-9_.+\-/ ]{1,80})"), "uses"),
    (re.compile(r"(?P<subject>[A-Za-z][A-Za-z0-9_.+\-/ ]{1,80}?)\s+supports\s+(?P<object>[A-Za-z][A-Za-z0-9_.+\-/ ]{1,80})"), "supports"),
    (re.compile(r"(?P<subject>[A-Za-z][A-Za-z0-9_.+\-/ ]{1,80}?)\s+runs on\s+(?P<object>[A-Za-z][A-Za-z0-9_.+\-/ ]{1,80})"), "runs_on"),
    (re.compile(r"(?P<subject>[A-Za-z][A-Za-z0-9_.+\-/ ]{1,80}?)\s+is\s+(?:an?|the)?\s*(?P<object>[A-Za-z][A-Za-z0-9_.+\-/ ]{1,80})"), "is"),
)
QUESTIONISH_SUBJECT_PREFIXES = (
    "explain ",
    "explain how ",
    "how ",
    "why ",
    "what ",
    "tell me ",
    "show me ",
    "describe ",
)


def message_texts(messages: Iterable[ChatMessage], role: MessageRole | None = None) -> list[str]:
    values: list[str] = []
    for message in messages:
        if role is not None and message.role != role:
            continue
        cleaned = normalize_whitespace(message.content)
        if cleaned:
            values.append(cleaned)
    return values


def heuristic_classification(messages: list[ChatMessage]) -> ClassificationResult:
    user_text = " ".join(message_texts(messages, MessageRole.USER))
    transcript = " ".join(message_texts(messages))
    lowered = transcript.lower()
    scores = Counter(
        {
            SessionCategory.JOURNAL: sum(term in lowered for term in JOURNAL_TERMS) + user_text.lower().count(" i "),
            SessionCategory.IDEAS: sum(term in lowered for term in IDEA_TERMS),
            SessionCategory.FACTUAL: sum(term in lowered for term in FACTUAL_TERMS),
        }
    )

    if "what if" in lowered or "brainstorm" in lowered:
        scores[SessionCategory.IDEAS] += 2
    if any(word in lowered for word in ("today", "tomorrow", "my day", "i feel", "i'm feeling")):
        scores[SessionCategory.JOURNAL] += 2
    if "```" in transcript or any(word in lowered for word in ("stack trace", "exception", "endpoint")):
        scores[SessionCategory.FACTUAL] += 2

    category = max(scores, key=scores.get)
    if scores[category] == 0:
        category = SessionCategory.FACTUAL

    reason = {
        SessionCategory.JOURNAL: "Heuristic classifier detected personal context, reflection, or task-planning language.",
        SessionCategory.FACTUAL: "Heuristic classifier detected explanatory, technical, or objective language.",
        SessionCategory.IDEAS: "Heuristic classifier detected ideation, brainstorming, or concept-development language.",
    }[category]
    return ClassificationResult(category=category, reason=reason)


def extract_action_items(messages: list[ChatMessage]) -> list[str]:
    items: list[str] = []
    for text in message_texts(messages):
        for pattern in ACTION_PATTERNS:
            for match in pattern.finditer(text):
                candidate = normalize_whitespace(match.group("rest"))
                if candidate:
                    items.append(candidate[:1].upper() + candidate[1:])
    if not items:
        assistant_texts = message_texts(messages, MessageRole.ASSISTANT)
        for line in assistant_texts[:3]:
            if FALLBACK_ACTION_RE.search(line):
                candidate = take_sentences(line, 1)
                if candidate:
                    items.append(candidate)
    deduped: list[str] = []
    seen: set[str] = set()
    for item in items:
        key = item.lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped[:5]


def heuristic_journal(messages: list[ChatMessage]) -> JournalResult:
    user_lines = message_texts(messages, MessageRole.USER)[:4]
    assistant_lines = message_texts(messages, MessageRole.ASSISTANT)[:2]
    summary_bits = compact_lines(
        [
            *(take_sentences(line, 1) for line in user_lines[:2]),
            *(take_sentences(line, 2) for line in assistant_lines[:1]),
        ]
    )
    summary = " ".join(summary_bits)
    if not summary:
        summary = "The session focused on personal context and planning."
    return JournalResult(entry=summary, action_items=extract_action_items(messages))


def heuristic_triplets(messages: list[ChatMessage]) -> list[TripletResult]:
    transcript = "\n".join(message_texts(messages))
    triplets: list[TripletResult] = []
    seen: set[tuple[str, str, str]] = set()
    for pattern, predicate in TRIPLET_PATTERNS:
        for match in pattern.finditer(transcript):
            subject = normalize_whitespace(match.group("subject")).strip(" .,:;")
            obj = normalize_whitespace(match.group("object")).strip(" .,:;")
            subject_lower = subject.lower()
            if subject_lower.startswith(QUESTIONISH_SUBJECT_PREFIXES):
                continue
            triple_key = (subject.lower(), predicate.lower(), obj.lower())
            if not subject or not obj or triple_key in seen:
                continue
            seen.add(triple_key)
            triplets.append(
                TripletResult(
                    subject=subject,
                    predicate=predicate,
                    object=obj,
                    confidence=0.45,
                )
            )
    return triplets[:12]


def heuristic_idea(messages: list[ChatMessage]) -> IdeaResult:
    user_lines = message_texts(messages, MessageRole.USER)
    assistant_lines = message_texts(messages, MessageRole.ASSISTANT)
    core_idea_source = user_lines[0] if user_lines else (assistant_lines[0] if assistant_lines else "Explore the main concept from the session.")
    core_idea = truncate_text(core_idea_source, 220)

    pros = [
        truncate_text(line, 120)
        for line in assistant_lines
        if any(word in line.lower() for word in ("benefit", "advantage", "help", "improve", "valuable"))
    ][:3]
    if not pros:
        pros = [
            "The concept can be evaluated quickly with a narrow prototype.",
            "The session already surfaced enough context to define an initial thesis.",
        ]

    cons = [
        truncate_text(line, 120)
        for line in assistant_lines
        if any(word in line.lower() for word in ("risk", "downside", "tradeoff", "concern", "constraint"))
    ][:3]
    if not cons:
        cons = [
            "The core assumption still needs validation against real usage.",
            "The implementation details may change once the first prototype is tested.",
        ]

    next_steps = extract_action_items(messages)
    if not next_steps:
        next_steps = [
            "Define the narrowest useful prototype.",
            "List the highest-risk assumption and test it directly.",
        ]

    share_post = truncate_text(
        f"{core_idea} The interesting part is turning the raw discussion into a concrete prototype with clear next steps.",
        280,
    )
    return IdeaResult(
        core_idea=core_idea,
        pros=pros,
        cons=cons,
        next_steps=next_steps[:5],
        share_post=share_post,
    )
