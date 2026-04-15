from __future__ import annotations

import hashlib
import json
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import inspect, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import NO_VALUE
from sqlalchemy.orm import selectinload

from app.core.config import get_settings
from app.models import ChatMessage, ChatSession, FactTriplet, SessionCategory, SyncEvent
from app.services.git_versioning import GitVersioningService
from app.services.todo import TodoListService, TODO_TITLE


CATEGORY_LABELS = {
    SessionCategory.JOURNAL: "Journal",
    SessionCategory.FACTUAL: "Factual",
    SessionCategory.IDEAS: "Ideas",
    SessionCategory.TODO: "Todo",
}


def slugify(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    return normalized or hashlib.sha1(value.encode("utf-8")).hexdigest()[:10]


def yaml_scalar(value: object) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, datetime):
        return json.dumps(normalize_datetime(value).isoformat())
    if hasattr(value, "isoformat"):
        return json.dumps(value.isoformat())
    return json.dumps(str(value))


def normalize_datetime(value: datetime) -> datetime:
    if value.tzinfo is None or value.tzinfo.utcoffset(value) is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def datetime_isoformat(value: datetime | None) -> str | None:
    if value is None:
        return None
    return normalize_datetime(value).isoformat()


def datetime_sort_key(value: datetime | None) -> tuple[int, float]:
    if value is None:
        return (1, float("-inf"))
    return (0, normalize_datetime(value).timestamp())


class MarkdownExporter:
    def __init__(self, db: AsyncSession | None = None) -> None:
        settings = get_settings()
        self.db = db
        self.base_dir = settings.resolved_markdown_dir
        self.vault_root_name = settings.vault_root_name

    async def write_session(self, session: ChatSession) -> Path:
        self._ensure_directories()
        target = self._session_note_path(session)
        source_target = self._source_note_path(session)
        previous_path = Path(session.markdown_path).expanduser() if session.markdown_path else None
        if previous_path and previous_path != target and previous_path.exists():
            previous_path.unlink()
        target.write_text(self.render_session(session), encoding="utf-8")
        source_target.write_text(self.render_source_session(session), encoding="utf-8")
        await self._write_graph_notes()
        await self._write_dashboards()
        await self._commit_vault(session)
        return target

    def render(self, session: ChatSession) -> str:
        return self.render_session(session)

    def render_source(self, session: ChatSession) -> str:
        return self.render_source_session(session)

    def render_session(self, session: ChatSession) -> str:
        front_matter = self._session_front_matter(session)
        title = session.title or f"{session.provider.value} {session.external_session_id}"
        lines = [
            "---",
            *front_matter,
            "---",
            "",
            f"# {title}",
            "",
            "## Metadata",
            "",
            f"- Provider: `{session.provider.value}`",
            f"- External Session ID: `{session.external_session_id}`",
            f"- Category: `{session.category.value if session.category else 'unclassified'}`",
            f"- Tags: {', '.join(session.custom_tags) if session.custom_tags else 'none'}",
            f"- Last Captured: {datetime_isoformat(session.last_captured_at) or 'n/a'}",
            "",
            "## Source",
            "",
            f"- Session URL: {session.source_url or 'n/a'}",
            f"- Source Document: {self._wiki_link(self._source_note_path(session), 'Source Document')}",
            "",
            "## Transcript",
            "",
        ]
        for message in session.messages:
            header = f"### {message.role.value.title()}"
            if message.occurred_at:
                header += f" ({datetime_isoformat(message.occurred_at)})"
            lines.extend([header, "", message.content.strip(), ""])

        if session.journal_entry:
            lines.extend(["## Journal Entry", "", session.journal_entry.strip(), ""])

        if session.todo_summary:
            lines.extend(
                [
                    "## To-Do Update",
                    "",
                    session.todo_summary.strip(),
                    "",
                    f"- Shared List: {self._wiki_link(self._todo_list_path(), TODO_TITLE)}",
                    "",
                ]
            )

        if session.triplets:
            lines.extend(["## Fact Triplets", ""])
            for triplet in session.triplets:
                lines.append(f"- {triplet.subject} | {triplet.predicate} | {triplet.object}")
            lines.append("")
            lines.extend(["## Related Entities", ""])
            for entity in self._session_entities(session):
                entity_path = self._entity_note_path(entity)
                lines.append(f"- {self._wiki_link(entity_path, entity)}")
            lines.append("")

        if session.idea_summary:
            lines.extend(self._render_idea_summary(session.idea_summary))

        if session.share_post:
            lines.extend(["## Share Post", "", session.share_post.strip(), ""])

        return "\n".join(lines).strip() + "\n"

    def render_source_session(self, session: ChatSession) -> str:
        title = session.title or f"{session.provider.value} {session.external_session_id}"
        lines = [
            "---",
            f"id: {yaml_scalar(f'tsmc-source-{session.id}')}",
            f"type: {yaml_scalar('session_source')}",
            f"provider: {yaml_scalar(session.provider.value)}",
            f"external_session_id: {yaml_scalar(session.external_session_id)}",
            f"session_note: {yaml_scalar(self._session_note_path(session).relative_to(self.vault_root).as_posix())}",
            f"captured_at: {yaml_scalar(session.last_captured_at)}",
            f"updated_at: {yaml_scalar(session.updated_at)}",
            "---",
            "",
            f"# Source Document: {title}",
            "",
            "## Overview",
            "",
            f"- Session Note: {self._wiki_link(self._session_note_path(session), title)}",
            f"- Session URL: {session.source_url or 'n/a'}",
            f"- Provider: `{session.provider.value}`",
            f"- External Session ID: `{session.external_session_id}`",
            "",
            "## Raw Sync Captures",
            "",
        ]

        sync_events = sorted(self._loaded_relationship_items(session, "sync_events"), key=lambda item: datetime_sort_key(item.created_at))
        raw_sync_events = [event for event in sync_events if event.raw_capture is not None]
        if raw_sync_events:
            for index, event in enumerate(raw_sync_events, start=1):
                lines.extend(self._render_sync_event_source(index, event))
        else:
            lines.extend(["No raw sync capture payloads were stored for this session.", ""])

        lines.extend(["## Raw Message Payloads", ""])
        messages = self._loaded_relationship_items(session, "messages")
        if messages:
            for message in messages:
                lines.extend(self._render_message_source(message))
        else:
            lines.extend(["No messages were stored for this session.", ""])

        return "\n".join(lines).strip() + "\n"

    async def _write_graph_notes(self) -> None:
        if self.db is None:
            return
        entities_dir = self.vault_root / "Graph" / "Entities"
        indexes_dir = self.vault_root / "Graph" / "Indexes"
        for managed_file in entities_dir.glob("*.md"):
            managed_file.unlink()
        for managed_file in indexes_dir.glob("*.md"):
            managed_file.unlink()

        triplets = (
            await self.db.execute(select(FactTriplet).options(selectinload(FactTriplet.session)))
        ).scalars().all()
        by_entity: dict[str, list[FactTriplet]] = defaultdict(list)
        for triplet in triplets:
            by_entity[triplet.subject].append(triplet)
            if triplet.object != triplet.subject:
                by_entity[triplet.object].append(triplet)

        for entity, entity_triplets in by_entity.items():
            note_path = self._entity_note_path(entity)
            related_sessions = {
                triplet.session for triplet in entity_triplets if triplet.session is not None
            }
            lines = [
                "---",
                f"id: {yaml_scalar(f'tsmc-entity-{slugify(entity)}')}",
                f"type: {yaml_scalar('entity')}",
                f"entity: {yaml_scalar(entity)}",
                "---",
                "",
                f"# {entity}",
                "",
                "## Facts",
                "",
            ]
            for triplet in entity_triplets:
                lines.append(f"- {triplet.subject} | {triplet.predicate} | {triplet.object}")
            lines.extend(["", "## Source Sessions", ""])
            for session in sorted(related_sessions, key=lambda item: datetime_sort_key(item.updated_at), reverse=True):
                lines.append(
                    f"- {self._wiki_link(self._session_note_path(session), session.title or session.external_session_id)}"
                )
            note_path.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")

        entity_index_lines = [
            "# Entity Index",
            "",
            f"- Total entities: {len(by_entity)}",
            "",
        ]
        for entity in sorted(by_entity):
            entity_index_lines.append(f"- {self._wiki_link(self._entity_note_path(entity), entity)}")
        (self.vault_root / "Graph" / "Indexes" / "Entity Index.md").write_text(
            "\n".join(entity_index_lines).strip() + "\n",
            encoding="utf-8",
        )

        relationship_lines = [
            "# Relationship Index",
            "",
        ]
        for triplet in sorted(triplets, key=lambda item: (item.subject.lower(), item.predicate.lower(), item.object.lower())):
            relationship_lines.append(f"- {triplet.subject} | {triplet.predicate} | {triplet.object}")
        (self.vault_root / "Graph" / "Indexes" / "Relationship Index.md").write_text(
            "\n".join(relationship_lines).strip() + "\n",
            encoding="utf-8",
        )

    async def _write_dashboards(self) -> None:
        if self.db is None:
            return
        sessions = (
            await self.db.execute(select(ChatSession).order_by(ChatSession.updated_at.desc()))
        ).scalars().all()

        dashboards_dir = self.vault_root / "Dashboards"
        for category, label in CATEGORY_LABELS.items():
            lines = [f"# {label} Index", ""]
            category_sessions = [session for session in sessions if session.category == category]
            lines.append(f"- Total sessions: {len(category_sessions)}")
            lines.append("")
            if category == SessionCategory.TODO:
                lines.append(f"- Shared List: {self._wiki_link(self._todo_list_path(), TODO_TITLE)}")
                lines.append("")
            for session in category_sessions:
                lines.append(
                    f"- {self._wiki_link(self._session_note_path(session), session.title or session.external_session_id)}"
                )
            (dashboards_dir / f"{label} Index.md").write_text(
                "\n".join(lines).strip() + "\n",
                encoding="utf-8",
            )

        graph_index_lines = [
            "# Graph Index",
            "",
            f"- {self._wiki_link(self.vault_root / 'Graph' / 'Indexes' / 'Entity Index.md', 'Entity Index')}",
            f"- {self._wiki_link(self.vault_root / 'Graph' / 'Indexes' / 'Relationship Index.md', 'Relationship Index')}",
        ]
        (dashboards_dir / "Graph Index.md").write_text(
            "\n".join(graph_index_lines).strip() + "\n",
            encoding="utf-8",
        )

    def _session_front_matter(self, session: ChatSession) -> list[str]:
        lines = [
            f"id: {yaml_scalar(session.id)}",
            f"type: {yaml_scalar('session')}",
            f"provider: {yaml_scalar(session.provider.value)}",
            f"external_session_id: {yaml_scalar(session.external_session_id)}",
            f"category: {yaml_scalar(session.category.value if session.category else 'unclassified')}",
            f"source_url: {yaml_scalar(session.source_url or '')}",
            f"captured_at: {yaml_scalar(session.last_captured_at)}",
            f"updated_at: {yaml_scalar(session.updated_at)}",
            "tags:",
            "  - tsmc",
        ]
        if session.category:
            lines.append(f"  - {session.category.value}")
        for tag in session.custom_tags or []:
            lines.append(f"  - {tag}")
        return lines

    def _ensure_directories(self) -> None:
        self.base_dir.mkdir(parents=True, exist_ok=True)
        for category_label in CATEGORY_LABELS.values():
            (self.vault_root / category_label).mkdir(parents=True, exist_ok=True)
        (self.vault_root / "Sessions").mkdir(parents=True, exist_ok=True)
        (self.vault_root / "Sources").mkdir(parents=True, exist_ok=True)
        (self.vault_root / "Graph" / "Entities").mkdir(parents=True, exist_ok=True)
        (self.vault_root / "Graph" / "Indexes").mkdir(parents=True, exist_ok=True)
        (self.vault_root / "Dashboards").mkdir(parents=True, exist_ok=True)
        TodoListService(base_dir=self.base_dir, vault_root_name=self.vault_root_name).ensure_exists()

    def _session_note_path(self, session: ChatSession) -> Path:
        category_dir = CATEGORY_LABELS.get(session.category, "Sessions")
        filename = f"{session.provider.value}--{slugify(session.external_session_id)}.md"
        return self.vault_root / category_dir / filename

    def _entity_note_path(self, entity: str) -> Path:
        return self.vault_root / "Graph" / "Entities" / f"{slugify(entity)}.md"

    def _source_note_path(self, session: ChatSession) -> Path:
        filename = f"{session.provider.value}--{slugify(session.external_session_id)}--source.md"
        return self.vault_root / "Sources" / filename

    def _todo_list_path(self) -> Path:
        return TodoListService(base_dir=self.base_dir, vault_root_name=self.vault_root_name).path

    def _session_entities(self, session: ChatSession) -> list[str]:
        entities = {triplet.subject for triplet in session.triplets} | {triplet.object for triplet in session.triplets}
        return sorted(entities, key=str.lower)

    def _wiki_link(self, path: Path, label: str | None = None) -> str:
        relative = path.relative_to(self.vault_root).with_suffix("")
        if label:
            return f"[[{relative.as_posix()}|{label}]]"
        return f"[[{relative.as_posix()}]]"

    def _render_idea_summary(self, idea_summary: dict[str, object]) -> list[str]:
        lines = ["## Idea Summary", ""]

        core_idea = str(idea_summary.get("core_idea", "")).strip()
        if core_idea:
            lines.extend(["### Core Idea", "", core_idea, ""])

        for heading, key in (
            ("Pros", "pros"),
            ("Cons", "cons"),
            ("Next Steps", "next_steps"),
        ):
            values = idea_summary.get(key)
            lines.extend([f"### {heading}", ""])
            if isinstance(values, list) and values:
                lines.extend(f"- {str(value).strip()}" for value in values if str(value).strip())
            else:
                lines.append("- None")
            lines.append("")

        return lines

    def _render_sync_event_source(self, index: int, event: SyncEvent) -> list[str]:
        lines = [f"### Capture {index}", ""]
        lines.append(f"- Captured At: {datetime_isoformat(event.created_at) or 'n/a'}")
        lines.append(f"- Message Count: {event.message_count}")
        lines.append("")
        lines.extend(self._fenced_block("json", self._json_dump(event.raw_capture)))
        lines.append("")
        return lines

    def _render_message_source(self, message: ChatMessage) -> list[str]:
        header = f"### {message.role.value.title()} `{message.external_message_id}`"
        lines = [header, ""]
        lines.append(f"- Occurred At: {datetime_isoformat(message.occurred_at) or 'n/a'}")
        lines.append(f"- Parent Message ID: `{message.parent_external_message_id or 'n/a'}`")
        lines.append("")
        lines.extend(["#### Stored Content", ""])
        lines.extend(self._fenced_block("text", message.content.strip()))
        lines.append("")
        lines.extend(["#### Raw Payload", ""])
        if message.raw_payload is None:
            lines.append("No raw payload was stored for this message.")
            lines.append("")
            return lines
        lines.extend(self._fenced_block("json", self._json_dump(message.raw_payload)))
        lines.append("")
        return lines

    def _fenced_block(self, language: str, value: str) -> list[str]:
        return [f"```{language}", value, "```"]

    def _json_dump(self, value: object) -> str:
        return json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True)

    def _loaded_relationship_items(self, session: ChatSession, relationship_name: str) -> list[object]:
        state = inspect(session)
        attribute = state.attrs[relationship_name]
        loaded = attribute.loaded_value
        if loaded is NO_VALUE:
            return []
        return list(loaded or [])

    @property
    def vault_root(self) -> Path:
        return self.base_dir / self.vault_root_name

    async def _commit_vault(self, session: ChatSession) -> None:
        message = f"Update vault for {session.provider.value}:{session.external_session_id}"
        if session.category == SessionCategory.TODO:
            message = f"Update to-do list from {session.provider.value}:{session.external_session_id}"
        await GitVersioningService(repo_root=self.vault_root).commit_all(message=message)
