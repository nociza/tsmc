from __future__ import annotations

from collections import Counter, defaultdict
from datetime import timedelta
from pathlib import Path
import re

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import get_settings
from app.models import ChatSession, ProviderName, SessionCategory
from app.schemas.explorer import (
    ActivityBucket,
    CategoryGraph,
    CategoryStats,
    ExplorerGraphEdge,
    ExplorerGraphNode,
    LabelCount,
    ProviderCount,
)
from app.services.graph import entity_id, entity_note_path


STOPWORDS = {
    "about",
    "after",
    "again",
    "also",
    "among",
    "and",
    "any",
    "are",
    "back",
    "been",
    "before",
    "being",
    "between",
    "both",
    "but",
    "can",
    "could",
    "does",
    "each",
    "from",
    "have",
    "into",
    "just",
    "like",
    "many",
    "more",
    "most",
    "must",
    "need",
    "notes",
    "only",
    "other",
    "over",
    "same",
    "save",
    "savemycontext",
    "session",
    "should",
    "some",
    "that",
    "their",
    "them",
    "there",
    "these",
    "they",
    "this",
    "those",
    "through",
    "todo",
    "very",
    "want",
    "what",
    "when",
    "which",
    "with",
    "would",
    "your",
}

TOKEN_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]+")


def session_related_entities(session: ChatSession) -> list[str]:
    entities = {triplet.subject.strip() for triplet in session.triplets if triplet.subject.strip()}
    entities.update(triplet.object.strip() for triplet in session.triplets if triplet.object.strip())
    return sorted(entities, key=str.lower)


def read_session_markdown(session: ChatSession) -> str | None:
    if not session.markdown_path:
        return None

    candidate = Path(session.markdown_path).expanduser()
    try:
        resolved = candidate.resolve()
    except OSError:
        return None

    settings = get_settings()
    allowed_roots = (settings.resolved_vault_root.resolve(), settings.resolved_markdown_dir.resolve())
    if not any(root == resolved or root in resolved.parents for root in allowed_roots):
        return None

    if not resolved.exists() or not resolved.is_file():
        return None

    return resolved.read_text(encoding="utf-8")


def session_word_count(session: ChatSession, raw_markdown: str | None = None) -> int:
    source = raw_markdown
    if not source:
        text_parts = [
            session.title or "",
            session.classification_reason or "",
            session.journal_entry or "",
            session.todo_summary or "",
            session.share_post or "",
            *(message.content for message in session.messages),
        ]
        if session.idea_summary:
            text_parts.extend(str(value) for value in session.idea_summary.values())
        source = "\n".join(text_parts)

    return len(re.findall(r"\b\w+\b", source))


def _session_text(session: ChatSession) -> str:
    parts = [
        session.title or "",
        session.classification_reason or "",
        session.journal_entry or "",
        session.todo_summary or "",
        session.share_post or "",
    ]
    if session.idea_summary:
        core_idea = session.idea_summary.get("core_idea")
        if core_idea:
            parts.append(str(core_idea))
        for key in ("pros", "cons", "next_steps"):
            value = session.idea_summary.get(key)
            if isinstance(value, list):
                parts.extend(str(item) for item in value)
    parts.extend(message.content for message in session.messages[:8])
    return "\n".join(part for part in parts if part)


def _tokenize_text(value: str) -> set[str]:
    tokens: set[str] = set()
    for token in TOKEN_PATTERN.findall(value.lower()):
        if len(token) < 3 or token.isdigit() or token in STOPWORDS:
            continue
        tokens.add(token)
    return tokens


class ExplorerService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def category_stats(
        self,
        category: SessionCategory,
        *,
        session_ids: list[str] | None = None,
        provider: ProviderName | None = None,
    ) -> CategoryStats:
        sessions = await self._sessions(category, session_ids=session_ids, provider=provider)
        total_sessions = len(sessions)
        total_messages = sum(len(session.messages) for session in sessions)
        total_triplets = sum(len(session.triplets) for session in sessions)
        latest_updated_at = max((session.updated_at for session in sessions), default=None)

        provider_counts = [
            ProviderCount(provider=provider, count=count)
            for provider, count in sorted(Counter(session.provider for session in sessions).items(), key=lambda item: item[0].value)
        ]

        activity = self._activity_buckets(sessions, latest_updated_at)
        top_tags = self._label_counts(
            tag
            for session in sessions
            for tag in session.custom_tags
            if tag and tag.strip() and tag.strip().lower() != "savemycontext"
        )
        top_entities = self._label_counts(
            entity
            for session in sessions
            for triplet in session.triplets
            for entity in (triplet.subject.strip(), triplet.object.strip())
            if entity
        )
        top_predicates = self._label_counts(
            triplet.predicate.strip()
            for session in sessions
            for triplet in session.triplets
            if triplet.predicate.strip()
        )

        avg_messages_per_session = (total_messages / total_sessions) if total_sessions else 0.0
        avg_triplets_per_session = (total_triplets / total_sessions) if total_sessions else 0.0

        return CategoryStats(
            category=category,
            total_sessions=total_sessions,
            total_messages=total_messages,
            total_triplets=total_triplets,
            latest_updated_at=latest_updated_at,
            avg_messages_per_session=avg_messages_per_session,
            avg_triplets_per_session=avg_triplets_per_session,
            notes_with_share_post=sum(1 for session in sessions if (session.share_post or "").strip()),
            notes_with_idea_summary=sum(1 for session in sessions if session.idea_summary),
            notes_with_journal_entry=sum(1 for session in sessions if (session.journal_entry or "").strip()),
            notes_with_todo_summary=sum(1 for session in sessions if (session.todo_summary or "").strip()),
            provider_counts=provider_counts,
            activity=activity,
            top_tags=top_tags,
            top_entities=top_entities,
            top_predicates=top_predicates,
        )

    async def category_graph(
        self,
        category: SessionCategory,
        *,
        session_ids: list[str] | None = None,
        provider: ProviderName | None = None,
    ) -> CategoryGraph:
        sessions = await self._sessions(category, session_ids=session_ids, provider=provider)

        if category == SessionCategory.FACTUAL:
            nodes, edges = self._factual_graph(category, sessions)
        else:
            nodes, edges = self._similarity_graph(category, sessions)

        return CategoryGraph(
            category=category,
            node_count=len(nodes),
            edge_count=len(edges),
            nodes=nodes,
            edges=edges,
        )

    async def _sessions(
        self,
        category: SessionCategory,
        *,
        session_ids: list[str] | None = None,
        provider: ProviderName | None = None,
    ) -> list[ChatSession]:
        statement = (
            select(ChatSession)
            .options(
                selectinload(ChatSession.messages),
                selectinload(ChatSession.triplets),
            )
            .where(ChatSession.category == category)
            .order_by(ChatSession.updated_at.desc())
        )
        if session_ids:
            statement = statement.where(ChatSession.id.in_(session_ids))
        if provider:
            statement = statement.where(ChatSession.provider == provider)

        result = await self.db.execute(statement)
        return list(result.scalars().unique().all())

    def _activity_buckets(
        self,
        sessions: list[ChatSession],
        latest_updated_at,
    ) -> list[ActivityBucket]:
        if latest_updated_at is None:
            return []

        latest_day = latest_updated_at.date()
        counts = Counter(session.updated_at.date().isoformat() for session in sessions if session.updated_at is not None)
        buckets: list[ActivityBucket] = []
        for offset in range(13, -1, -1):
            day = (latest_day - timedelta(days=offset)).isoformat()
            buckets.append(ActivityBucket(bucket=day, count=counts.get(day, 0)))
        return buckets

    def _label_counts(self, labels) -> list[LabelCount]:
        counter = Counter(label.strip() for label in labels if label and label.strip())
        return [
            LabelCount(label=label, count=count)
            for label, count in counter.most_common(8)
        ]

    def _factual_graph(
        self,
        category: SessionCategory,
        sessions: list[ChatSession],
    ) -> tuple[list[ExplorerGraphNode], list[ExplorerGraphEdge]]:
        node_sessions: dict[str, set[str]] = defaultdict(set)
        node_degrees: Counter[str] = Counter()
        node_labels: dict[str, str] = {}
        edge_sessions: dict[tuple[str, str, str], set[str]] = defaultdict(set)

        for session in sessions:
            for triplet in session.triplets:
                source = entity_id(triplet.subject)
                target = entity_id(triplet.object)
                node_labels[source] = triplet.subject
                node_labels[target] = triplet.object
                node_sessions[source].add(session.id)
                node_sessions[target].add(session.id)
                node_degrees[source] += 1
                node_degrees[target] += 1
                edge_sessions[(source, triplet.predicate, target)].add(session.id)

        ranked_nodes = sorted(node_degrees.items(), key=lambda item: (-item[1], node_labels.get(item[0], item[0]).lower()))[:40]
        allowed_node_ids = {node_id for node_id, _ in ranked_nodes}

        nodes = [
            ExplorerGraphNode(
                id=node_id,
                label=node_labels[node_id],
                kind="entity",
                size=degree,
                session_ids=sorted(node_sessions[node_id]),
                category=category,
                note_path=entity_note_path(node_labels[node_id]),
            )
            for node_id, degree in ranked_nodes
        ]

        edges = [
            ExplorerGraphEdge(
                id=f"{source}:{predicate}:{target}",
                source=source,
                target=target,
                label=predicate,
                weight=len(session_ids),
                session_ids=sorted(session_ids),
            )
            for (source, predicate, target), session_ids in sorted(
                edge_sessions.items(),
                key=lambda item: (-len(item[1]), item[0][1], item[0][0], item[0][2]),
            )
            if source in allowed_node_ids and target in allowed_node_ids
        ][:80]

        return nodes, edges

    def _similarity_graph(
        self,
        category: SessionCategory,
        sessions: list[ChatSession],
    ) -> tuple[list[ExplorerGraphNode], list[ExplorerGraphEdge]]:
        tokens_by_session = {session.id: _tokenize_text(_session_text(session)) for session in sessions}

        nodes = [
            ExplorerGraphNode(
                id=session.id,
                label=session.title or session.external_session_id,
                kind="session",
                size=max(len(session.messages), 1),
                session_ids=[session.id],
                provider=session.provider,
                category=category,
                updated_at=session.updated_at,
                note_path=session.markdown_path,
            )
            for session in sessions[:36]
        ]
        visible_ids = {node.id for node in nodes}

        edges: list[ExplorerGraphEdge] = []
        visible_sessions = [session for session in sessions if session.id in visible_ids]
        for index, left in enumerate(visible_sessions):
            left_tokens = tokens_by_session.get(left.id, set())
            if not left_tokens:
                continue
            for right in visible_sessions[index + 1 :]:
                shared = sorted(left_tokens & tokens_by_session.get(right.id, set()))
                if len(shared) < 2:
                    continue
                label = ", ".join(shared[:3])
                edges.append(
                    ExplorerGraphEdge(
                        id=f"{left.id}:{right.id}",
                        source=left.id,
                        target=right.id,
                        label=label,
                        weight=min(len(shared), 8),
                        session_ids=[left.id, right.id],
                    )
                )

        edges.sort(key=lambda edge: (-edge.weight, edge.label or "", edge.source, edge.target))
        return nodes, edges[:72]
