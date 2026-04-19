from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import AuthContext, require_scope
from app.db.session import get_db_session
from app.schemas.prompt_template import PromptTemplateRead, PromptTemplateUpdate, PromptTemplateVariableRead
from app.services.prompt_templates import PromptTemplateNotFoundError, PromptTemplateService


router = APIRouter(prefix="/prompts")


def _serialize(template) -> PromptTemplateRead:
    return PromptTemplateRead(
        key=template.key,
        title=template.title,
        group=template.group,
        description=template.description,
        system_prompt=template.system_prompt,
        user_prompt=template.user_prompt,
        default_system_prompt=template.default_system_prompt,
        default_user_prompt=template.default_user_prompt,
        has_override=template.has_override,
        updated_at=template.updated_at,
        variables=[
            PromptTemplateVariableRead(name=variable.name, description=variable.description)
            for variable in template.definition.variables
        ],
    )


@router.get("/templates", response_model=list[PromptTemplateRead])
async def list_prompt_templates(
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> list[PromptTemplateRead]:
    templates = await PromptTemplateService(db).list_templates()
    return [_serialize(template) for template in templates]


@router.get("/templates/{key:path}", response_model=PromptTemplateRead)
async def get_prompt_template(
    key: str,
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> PromptTemplateRead:
    try:
        template = await PromptTemplateService(db).get_template(key)
    except PromptTemplateNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return _serialize(template)


@router.put("/templates/{key:path}", response_model=PromptTemplateRead)
async def update_prompt_template(
    key: str,
    payload: PromptTemplateUpdate,
    _: AuthContext = Depends(require_scope("admin")),
    db: AsyncSession = Depends(get_db_session),
) -> PromptTemplateRead:
    service = PromptTemplateService(db)
    try:
        unknown_placeholders = service.validate_placeholders(
            key,
            system_prompt=payload.system_prompt,
            user_prompt=payload.user_prompt,
        )
    except PromptTemplateNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

    if unknown_placeholders:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Unknown prompt variables: "
                + ", ".join(sorted(unknown_placeholders))
            ),
        )

    template = await service.update_template(
        key,
        system_prompt=payload.system_prompt,
        user_prompt=payload.user_prompt,
    )
    return _serialize(template)


@router.delete("/templates/{key:path}", status_code=status.HTTP_204_NO_CONTENT)
async def reset_prompt_template(
    key: str,
    _: AuthContext = Depends(require_scope("admin")),
    db: AsyncSession = Depends(get_db_session),
) -> None:
    try:
        await PromptTemplateService(db).reset_template(key)
    except PromptTemplateNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
