from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from typing import Mapping

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import PromptTemplate
from app.prompts.templates import PROMPT_TEMPLATE_ORDER, PromptTemplateDefinition, get_prompt_template_definition


PLACEHOLDER_RE = re.compile(r"\{\{\s*([A-Za-z0-9_]+)\s*\}\}")


@dataclass(frozen=True)
class ResolvedPromptTemplate:
    key: str
    title: str
    group: str
    description: str
    system_prompt: str
    user_prompt: str
    default_system_prompt: str
    default_user_prompt: str
    has_override: bool
    updated_at: datetime | None
    definition: PromptTemplateDefinition


@dataclass(frozen=True)
class RenderedPromptTemplate:
    key: str
    system_prompt: str
    user_prompt: str


class PromptTemplateNotFoundError(LookupError):
    def __init__(self, key: str) -> None:
        super().__init__(f"Prompt template not found: {key}")
        self.key = key


class PromptTemplateService:
    def __init__(self, db: AsyncSession | None = None) -> None:
        self.db = db

    async def list_templates(self) -> list[ResolvedPromptTemplate]:
        overrides = await self._override_map()
        return [self._resolve_template(key, overrides.get(key)) for key in PROMPT_TEMPLATE_ORDER]

    async def get_template(self, key: str) -> ResolvedPromptTemplate:
        definition = self._definition(key)
        override = await self._get_override(key)
        return self._build_resolved_template(definition, override)

    async def update_template(self, key: str, *, system_prompt: str, user_prompt: str) -> ResolvedPromptTemplate:
        if self.db is None:
            raise RuntimeError("PromptTemplateService.update_template requires a database session.")
        definition = self._definition(key)
        override = await self._get_override(key)
        if override is None:
            override = PromptTemplate(
                key=key,
                system_prompt=system_prompt.strip(),
                user_prompt=user_prompt.strip(),
            )
            self.db.add(override)
        else:
            override.system_prompt = system_prompt.strip()
            override.user_prompt = user_prompt.strip()
        await self.db.commit()
        await self.db.refresh(override)
        return self._build_resolved_template(definition, override)

    async def reset_template(self, key: str) -> None:
        if self.db is None:
            raise RuntimeError("PromptTemplateService.reset_template requires a database session.")
        self._definition(key)
        override = await self._get_override(key)
        if override is None:
            return
        await self.db.delete(override)
        await self.db.commit()

    async def render(self, key: str, values: Mapping[str, object]) -> RenderedPromptTemplate:
        template = await self.get_template(key)
        return RenderedPromptTemplate(
            key=template.key,
            system_prompt=render_prompt_text(template.system_prompt, values),
            user_prompt=render_prompt_text(template.user_prompt, values),
        )

    def validate_placeholders(self, key: str, *, system_prompt: str, user_prompt: str) -> list[str]:
        definition = self._definition(key)
        allowed = {variable.name for variable in definition.variables}
        discovered = extract_placeholders(system_prompt) | extract_placeholders(user_prompt)
        return sorted(discovered - allowed)

    async def _override_map(self) -> dict[str, PromptTemplate]:
        if self.db is None:
            return {}
        result = await self.db.execute(select(PromptTemplate))
        return {row.key: row for row in result.scalars().all()}

    async def _get_override(self, key: str) -> PromptTemplate | None:
        if self.db is None:
            return None
        result = await self.db.execute(select(PromptTemplate).where(PromptTemplate.key == key))
        return result.scalar_one_or_none()

    def _definition(self, key: str) -> PromptTemplateDefinition:
        try:
            return get_prompt_template_definition(key)
        except KeyError as exc:
            raise PromptTemplateNotFoundError(key) from exc

    def _resolve_template(self, key: str, override: PromptTemplate | None) -> ResolvedPromptTemplate:
        definition = self._definition(key)
        return self._build_resolved_template(definition, override)

    @staticmethod
    def _build_resolved_template(
        definition: PromptTemplateDefinition,
        override: PromptTemplate | None,
    ) -> ResolvedPromptTemplate:
        return ResolvedPromptTemplate(
            key=definition.key,
            title=definition.title,
            group=definition.group,
            description=definition.description,
            system_prompt=override.system_prompt if override is not None else definition.system_prompt,
            user_prompt=override.user_prompt if override is not None else definition.user_prompt,
            default_system_prompt=definition.system_prompt,
            default_user_prompt=definition.user_prompt,
            has_override=override is not None,
            updated_at=override.updated_at if override is not None else None,
            definition=definition,
        )


def extract_placeholders(text: str) -> set[str]:
    return {match.group(1) for match in PLACEHOLDER_RE.finditer(text or "")}


def render_prompt_text(template: str, values: Mapping[str, object]) -> str:
    def replace(match: re.Match[str]) -> str:
        raw_value = values.get(match.group(1), "")
        if raw_value is None:
            return ""
        return str(raw_value)

    return PLACEHOLDER_RE.sub(replace, template).strip()
