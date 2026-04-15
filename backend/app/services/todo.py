from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from app.core.config import get_settings
from app.models import ChatMessage
from app.models.enums import MessageRole
from app.schemas.processing import TodoResult
from app.services.text import compact_lines, normalize_whitespace, take_sentences


TODO_TITLE = "To-Do List"
TODO_FILE_NAME = "To-Do List.md"
CHECKLIST_RE = re.compile(r"^\s*-\s\[(?P<done>[ xX])\]\s+(?P<text>.+?)\s*$")
ADD_PATTERNS = (
    re.compile(r"\badd\s+(?P<item>.+?)\s+to\s+(?:my\s+)?(?:to-?do|todo|task)\s+list\b", re.I),
    re.compile(r"\bput\s+(?P<item>.+?)\s+on\s+(?:my\s+)?(?:to-?do|todo|task)\s+list\b", re.I),
)
REMOVE_PATTERNS = (
    re.compile(r"\b(?:remove|delete|drop)\s+(?P<item>.+?)\s+from\s+(?:my\s+)?(?:to-?do|todo|task)\s+list\b", re.I),
)
COMPLETE_PATTERNS = (
    re.compile(r"\b(?:mark|set|check off)\s+(?P<item>.+?)\s+as\s+(?:done|complete|completed|finished)\b", re.I),
    re.compile(r"\b(?:finish|complete)\s+(?P<item>.+?)\s+on\s+(?:my\s+)?(?:to-?do|todo|task)\s+list\b", re.I),
)
REOPEN_PATTERNS = (
    re.compile(r"\b(?:reopen|uncheck|mark)\s+(?P<item>.+?)\s+as\s+(?:active|open|not done|incomplete)\b", re.I),
)


@dataclass
class TodoItem:
    text: str
    done: bool = False


class TodoListService:
    def __init__(self, *, base_dir: Path | None = None, vault_root_name: str | None = None) -> None:
        settings = get_settings()
        self.base_dir = base_dir or settings.resolved_markdown_dir
        self.vault_root_name = vault_root_name or settings.vault_root_name

    @property
    def vault_root(self) -> Path:
        return self.base_dir / self.vault_root_name

    @property
    def path(self) -> Path:
        return self.vault_root / "Dashboards" / TODO_FILE_NAME

    def ensure_exists(self) -> Path:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self.path.write_text(default_todo_markdown(), encoding="utf-8")
        return self.path

    def read_markdown(self) -> str:
        return self.ensure_exists().read_text(encoding="utf-8")

    def write_markdown(self, markdown: str) -> Path:
        target = self.ensure_exists()
        target.write_text(normalize_todo_markdown(markdown), encoding="utf-8")
        return target


def default_todo_markdown() -> str:
    return "\n".join(
        [
            f"# {TODO_TITLE}",
            "",
            "## Active",
            "",
            "## Done",
            "",
        ]
    )


def normalize_todo_markdown(markdown: str) -> str:
    cleaned = markdown.strip()
    if not cleaned:
        return default_todo_markdown()
    if not cleaned.startswith("#"):
        cleaned = f"# {TODO_TITLE}\n\n{cleaned}"
    if "## Active" not in cleaned:
        cleaned = f"{cleaned}\n\n## Active\n"
    if "## Done" not in cleaned:
        cleaned = f"{cleaned.rstrip()}\n\n## Done\n"
    return cleaned.rstrip() + "\n"


def parse_todo_items(markdown: str) -> list[TodoItem]:
    items: list[TodoItem] = []
    for raw_line in markdown.splitlines():
        match = CHECKLIST_RE.match(raw_line)
        if not match:
            continue
        text = normalize_whitespace(match.group("text"))
        if not text:
            continue
        items.append(TodoItem(text=text, done=match.group("done").lower() == "x"))
    return items


def render_todo_markdown(items: list[TodoItem]) -> str:
    active = [item for item in items if not item.done]
    done = [item for item in items if item.done]
    lines = [f"# {TODO_TITLE}", "", "## Active"]
    lines.extend(f"- [ ] {item.text}" for item in active)
    lines.extend(["", "## Done"])
    lines.extend(f"- [x] {item.text}" for item in done)
    lines.append("")
    return "\n".join(lines)


def heuristic_todo_result(messages: list[ChatMessage], current_markdown: str) -> TodoResult:
    items = parse_todo_items(current_markdown)
    operations: list[str] = []
    for text in _message_texts(messages, MessageRole.USER):
        operations.extend(_apply_patterns(items, text, ADD_PATTERNS, _add_item))
        operations.extend(_apply_patterns(items, text, REMOVE_PATTERNS, _remove_item))
        operations.extend(_apply_patterns(items, text, COMPLETE_PATTERNS, _complete_item))
        operations.extend(_apply_patterns(items, text, REOPEN_PATTERNS, _reopen_item))

    if not operations:
        fallback = compact_lines(take_sentences(text, 1) for text in _message_texts(messages, MessageRole.USER)[:2])
        summary = (
            "Captured a to-do list update request, but the heuristic parser could not safely apply a structured change. "
            f"Review manually: {' '.join(fallback)}"
        ).strip()
        return TodoResult(summary=summary, updated_markdown=render_todo_markdown(items))

    summary = "; ".join(operations)
    return TodoResult(summary=summary, updated_markdown=render_todo_markdown(items))


def _message_texts(messages: list[ChatMessage], role: MessageRole | None = None) -> list[str]:
    values: list[str] = []
    for message in messages:
        if role is not None and message.role != role:
            continue
        cleaned = normalize_whitespace(message.content)
        if cleaned:
            values.append(cleaned)
    return values


def _apply_patterns(
    items: list[TodoItem],
    text: str,
    patterns: tuple[re.Pattern[str], ...],
    handler,
) -> list[str]:
    operations: list[str] = []
    for pattern in patterns:
        for match in pattern.finditer(text):
            raw_item = normalize_whitespace(match.group("item")).strip(" .,:;")
            for item_text in _split_item_candidates(raw_item):
                applied = handler(items, item_text)
                if applied:
                    operations.append(applied)
    return operations


def _split_item_candidates(value: str) -> list[str]:
    cleaned = normalize_whitespace(value)
    if not cleaned:
        return []
    parts = [part.strip(" .") for part in re.split(r"\s*(?:,|;)\s*", cleaned) if part.strip(" .")]
    return parts or [cleaned]


def _normalize_item_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def _find_item(items: list[TodoItem], query: str) -> TodoItem | None:
    query_key = _normalize_item_key(query)
    if not query_key:
        return None
    for item in items:
        item_key = _normalize_item_key(item.text)
        if item_key == query_key:
            return item
    for item in items:
        item_key = _normalize_item_key(item.text)
        if query_key in item_key or item_key in query_key:
            return item
    return None


def _add_item(items: list[TodoItem], value: str) -> str | None:
    existing = _find_item(items, value)
    if existing is not None:
        existing.done = False
        existing.text = value
        return f"Reopened '{value}'"
    items.append(TodoItem(text=value, done=False))
    return f"Added '{value}'"


def _remove_item(items: list[TodoItem], value: str) -> str | None:
    existing = _find_item(items, value)
    if existing is None:
        return None
    items.remove(existing)
    return f"Removed '{existing.text}'"


def _complete_item(items: list[TodoItem], value: str) -> str | None:
    existing = _find_item(items, value)
    if existing is None:
        items.append(TodoItem(text=value, done=True))
        return f"Marked '{value}' done"
    existing.done = True
    return f"Marked '{existing.text}' done"


def _reopen_item(items: list[TodoItem], value: str) -> str | None:
    existing = _find_item(items, value)
    if existing is None:
        items.append(TodoItem(text=value, done=False))
        return f"Added '{value}' as active"
    existing.done = False
    return f"Marked '{existing.text}' active"
