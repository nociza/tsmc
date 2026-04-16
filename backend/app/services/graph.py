from __future__ import annotations

from collections import Counter, defaultdict

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import get_settings
from app.models import FactTriplet
from app.schemas.graph import GraphEdge, GraphNode
from app.services.markdown import stable_note_token


def entity_id(value: str) -> str:
    return stable_note_token(value, fallback="entity")


def entity_note_path(label: str) -> str:
    settings = get_settings()
    return str(settings.resolved_vault_root / "Graph" / "Entities" / f"{stable_note_token(label, fallback='entity')}.md")


class GraphService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def nodes(self) -> list[GraphNode]:
        triplets = await self._triplets()
        degrees: Counter[str] = Counter()
        labels: dict[str, str] = {}

        for triplet in triplets:
            subject_id = entity_id(triplet.subject)
            object_id = entity_id(triplet.object)
            labels[subject_id] = triplet.subject
            labels[object_id] = triplet.object
            degrees[subject_id] += 1
            degrees[object_id] += 1

        return [
            GraphNode(
                id=node_id,
                label=labels[node_id],
                kind="entity",
                degree=degree,
                note_path=entity_note_path(labels[node_id]),
            )
            for node_id, degree in sorted(degrees.items(), key=lambda item: (-item[1], item[0]))
        ]

    async def edges(self) -> list[GraphEdge]:
        triplets = await self._triplets()
        grouped: dict[tuple[str, str, str], set[str]] = defaultdict(set)

        for triplet in triplets:
            source = entity_id(triplet.subject)
            target = entity_id(triplet.object)
            grouped[(source, triplet.predicate, target)].add(triplet.session_id)

        return [
            GraphEdge(
                id=f"{source}:{predicate}:{target}",
                source=source,
                target=target,
                predicate=predicate,
                support_count=len(session_ids),
                session_ids=sorted(session_ids),
            )
            for (source, predicate, target), session_ids in sorted(grouped.items())
        ]

    async def _triplets(self) -> list[FactTriplet]:
        result = await self.db.execute(select(FactTriplet).options(selectinload(FactTriplet.session)))
        return result.scalars().all()
