from __future__ import annotations

import hashlib
import json
import re
from collections import defaultdict
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import get_settings
from app.models import ChatSession, FactTriplet, SessionCategory


CATEGORY_LABELS = {
    SessionCategory.JOURNAL: "Journal",
    SessionCategory.FACTUAL: "Factual",
    SessionCategory.IDEAS: "Ideas",
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
    if hasattr(value, "isoformat"):
        return json.dumps(value.isoformat())
    return json.dumps(str(value))


class MarkdownExporter:
    def __init__(self, db: AsyncSession | None = None) -> None:
        settings = get_settings()
        self.db = db
        self.base_dir = settings.resolved_markdown_dir
        self.vault_root_name = settings.vault_root_name

    async def write_session(self, session: ChatSession) -> Path:
        self._ensure_directories()
        target = self._session_note_path(session)
        previous_path = Path(session.markdown_path).expanduser() if session.markdown_path else None
        if previous_path and previous_path != target and previous_path.exists():
            previous_path.unlink()
        target.write_text(self.render_session(session), encoding="utf-8")
        await self._write_graph_notes()
        await self._write_dashboards()
        return target

    def render(self, session: ChatSession) -> str:
        return self.render_session(session)

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
            f"- Source URL: {session.source_url or 'n/a'}",
            f"- Tags: {', '.join(session.custom_tags) if session.custom_tags else 'none'}",
            f"- Last Captured: {session.last_captured_at.isoformat() if session.last_captured_at else 'n/a'}",
            "",
            "## Transcript",
            "",
        ]
        for message in session.messages:
            header = f"### {message.role.value.title()}"
            if message.occurred_at:
                header += f" ({message.occurred_at.isoformat()})"
            lines.extend([header, "", message.content.strip(), ""])

        if session.journal_entry:
            lines.extend(["## Journal Entry", "", session.journal_entry.strip(), ""])

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
            lines.extend(
                [
                    "## Idea Summary",
                    "",
                    "```json",
                    json.dumps(session.idea_summary, indent=2),
                    "```",
                    "",
                ]
            )

        if session.share_post:
            lines.extend(["## Share Post", "", session.share_post.strip(), ""])

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
            for session in sorted(related_sessions, key=lambda item: item.updated_at, reverse=True):
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
        for tag in session.custom_tags:
            lines.append(f"  - {tag}")
        return lines

    def _ensure_directories(self) -> None:
        self.base_dir.mkdir(parents=True, exist_ok=True)
        for category_label in CATEGORY_LABELS.values():
            (self.vault_root / category_label).mkdir(parents=True, exist_ok=True)
        (self.vault_root / "Sessions").mkdir(parents=True, exist_ok=True)
        (self.vault_root / "Graph" / "Entities").mkdir(parents=True, exist_ok=True)
        (self.vault_root / "Graph" / "Indexes").mkdir(parents=True, exist_ok=True)
        (self.vault_root / "Dashboards").mkdir(parents=True, exist_ok=True)

    def _session_note_path(self, session: ChatSession) -> Path:
        category_dir = CATEGORY_LABELS.get(session.category, "Sessions")
        filename = f"{session.provider.value}--{slugify(session.external_session_id)}.md"
        return self.vault_root / category_dir / filename

    def _entity_note_path(self, entity: str) -> Path:
        return self.vault_root / "Graph" / "Entities" / f"{slugify(entity)}.md"

    def _session_entities(self, session: ChatSession) -> list[str]:
        entities = {triplet.subject for triplet in session.triplets} | {triplet.object for triplet in session.triplets}
        return sorted(entities, key=str.lower)

    def _wiki_link(self, path: Path, label: str | None = None) -> str:
        relative = path.relative_to(self.base_dir).with_suffix("")
        if label:
            return f"[[{relative.as_posix()}|{label}]]"
        return f"[[{relative.as_posix()}]]"

    @property
    def vault_root(self) -> Path:
        return self.base_dir / self.vault_root_name
