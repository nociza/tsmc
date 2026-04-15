from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.dependencies import AuthContext, require_scope
from app.schemas.todo import TodoListRead
from app.services.git_versioning import GitVersioningService
from app.services.todo import TODO_TITLE, TodoListService


router = APIRouter()


@router.get("/todo", response_model=TodoListRead)
async def read_todo_list(
    _: AuthContext = Depends(require_scope("read")),
) -> TodoListRead:
    todo_service = TodoListService()
    git_service = GitVersioningService(repo_root=todo_service.vault_root)
    return TodoListRead(
        title=TODO_TITLE,
        markdown_path=str(todo_service.ensure_exists()),
        content=todo_service.read_markdown(),
        git_versioning_enabled=git_service.enabled,
        git_available=git_service.is_available(),
    )
