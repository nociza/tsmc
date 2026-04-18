from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Pile
from app.models.enums import PileKind, SessionCategory
from app.services.piles import (
    BUILT_IN_KIND_BY_SLUG,
    BUILT_IN_SLUG_TO_CATEGORY,
    CATEGORY_TO_BUILT_IN_SLUG,
    is_built_in_slug,
)


class PileService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def list_piles(
        self,
        *,
        active_only: bool = True,
        include_hidden: bool = True,
    ) -> list[Pile]:
        statement = select(Pile)
        if active_only:
            statement = statement.where(Pile.is_active.is_(True))
        if not include_hidden:
            statement = statement.where(Pile.is_visible_on_dashboard.is_(True))
        statement = statement.order_by(Pile.sort_order.asc(), Pile.name.asc())
        result = await self.db.execute(statement)
        return list(result.scalars().all())

    async def get_by_slug(self, slug: str) -> Pile | None:
        if not slug:
            return None
        result = await self.db.execute(select(Pile).where(Pile.slug == slug))
        return result.scalar_one_or_none()

    async def get_by_id(self, pile_id: str) -> Pile | None:
        if not pile_id:
            return None
        result = await self.db.execute(select(Pile).where(Pile.id == pile_id))
        return result.scalar_one_or_none()

    async def require_by_slug(self, slug: str) -> Pile:
        pile = await self.get_by_slug(slug)
        if pile is None:
            raise PileNotFoundError(slug)
        return pile

    async def discarded_pile(self) -> Pile | None:
        return await self.get_by_slug("discarded")

    async def slug_map(self, slugs: Iterable[str]) -> dict[str, Pile]:
        wanted = [slug for slug in slugs if slug]
        if not wanted:
            return {}
        result = await self.db.execute(select(Pile).where(Pile.slug.in_(wanted)))
        return {pile.slug: pile for pile in result.scalars().all()}

    async def id_map_by_slug(self, slugs: Iterable[str]) -> dict[str, str]:
        piles = await self.slug_map(slugs)
        return {slug: pile.id for slug, pile in piles.items()}

    async def resolve_pile_for_category(self, category: SessionCategory | None) -> Pile | None:
        slug = CATEGORY_TO_BUILT_IN_SLUG.get(category) if category else None
        if not slug:
            return None
        return await self.get_by_slug(slug)

    @staticmethod
    def category_for_pile(pile: Pile | None) -> SessionCategory | None:
        if pile is None:
            return None
        return BUILT_IN_SLUG_TO_CATEGORY.get(pile.slug)

    @staticmethod
    def is_built_in(pile: Pile | None) -> bool:
        if pile is None:
            return False
        return pile.kind in {
            PileKind.BUILT_IN_JOURNAL,
            PileKind.BUILT_IN_FACTUAL,
            PileKind.BUILT_IN_IDEAS,
            PileKind.BUILT_IN_TODO,
            PileKind.BUILT_IN_DISCARDED,
        }

    @staticmethod
    def folder_label_for_slug(slug: str) -> str | None:
        if not is_built_in_slug(slug):
            return None
        for kind, mapped_slug in {kind: slug_value for slug_value, kind in BUILT_IN_KIND_BY_SLUG.items()}.items():
            if mapped_slug == slug:
                return kind.value
        return None


class PileNotFoundError(LookupError):
    def __init__(self, slug: str) -> None:
        super().__init__(f"Pile not found: {slug}")
        self.slug = slug
