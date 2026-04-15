from __future__ import annotations

import os
from pathlib import Path

from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.cli_config import load_cli_config, merge_cli_config, save_cli_config
from app.cli_paths import CLIPaths, default_cli_paths
from app.core.config import BACKEND_DIR, get_settings
from app.schemas.system import StorageSettingsResponse
from app.services.git_versioning import GitVersioningService
from app.services.markdown import MarkdownExporter
from app.services.todo import TodoListService


class StorageConfigService:
    def __init__(self, db: AsyncSession | None = None) -> None:
        self.db = db

    def read(self) -> StorageSettingsResponse:
        settings = get_settings()
        return StorageSettingsResponse(
            markdown_root=str(settings.resolved_markdown_dir),
            vault_root=str(settings.resolved_vault_root),
            todo_list_path=str(TodoListService().ensure_exists()),
            persistence_kind=self._persistence_kind(),
            persisted_to=self._persistence_target(),
            regenerated_session_count=0,
            git_initialized=False,
        )

    async def update_markdown_root(self, raw_path: str) -> StorageSettingsResponse:
        markdown_root = self._validate_markdown_root(raw_path)
        persistence_kind, persisted_to = self._persist_markdown_root(markdown_root)
        os.environ["SAVEMYCONTEXT_MARKDOWN_DIR"] = str(markdown_root)
        get_settings.cache_clear()

        exporter = MarkdownExporter(self.db)
        regenerated_session_count = await exporter.rebuild_vault()
        if self.db is not None:
            await self.db.flush()
            await self.db.commit()

        todo_path = TodoListService().ensure_exists()
        git_service = GitVersioningService(repo_root=get_settings().resolved_vault_root)
        git_initialized = await git_service.ensure_repo()
        await git_service.commit_all(message=f"Relocate SaveMyContext vault to {get_settings().resolved_vault_root}")

        settings = get_settings()
        return StorageSettingsResponse(
            markdown_root=str(settings.resolved_markdown_dir),
            vault_root=str(settings.resolved_vault_root),
            todo_list_path=str(todo_path),
            persistence_kind=persistence_kind,
            persisted_to=persisted_to,
            regenerated_session_count=regenerated_session_count,
            git_initialized=git_initialized,
        )

    def _validate_markdown_root(self, raw_path: str) -> Path:
        candidate = Path(raw_path.strip()).expanduser()
        if not raw_path.strip():
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="A markdown root path is required.",
            )
        if not candidate.is_absolute():
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="The knowledge storage path must be an absolute path or use ~.",
            )
        if candidate.exists() and not candidate.is_dir():
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="The knowledge storage path must point to a directory.",
            )

        try:
            candidate.mkdir(parents=True, exist_ok=True)
            probe = candidate / ".savemycontext-write-test"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink(missing_ok=True)
        except OSError as error:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"The knowledge storage path is not writable: {error}",
            ) from error

        return candidate.resolve()

    def _persist_markdown_root(self, markdown_root: Path) -> tuple[str, str | None]:
        config_path_value = os.environ.get("SAVEMYCONTEXT_CLI_CONFIG_PATH", "").strip()
        if config_path_value:
            config_path = Path(config_path_value).expanduser().resolve()
            defaults = default_cli_paths()
            paths = CLIPaths(
                config_dir=config_path.parent,
                config_path=config_path,
                env_path=config_path.parent / "savemycontext.env",
                data_dir=defaults.data_dir,
                markdown_dir=defaults.markdown_dir,
                database_path=defaults.database_path,
                systemd_user_dir=defaults.systemd_user_dir,
                unit_path=defaults.unit_path,
            )
            config = load_cli_config(config_path, paths=paths)
            merged = merge_cli_config(config, markdown_dir=markdown_root)
            save_cli_config(merged, config_path)
            return "cli_config", str(config_path)

        env_path = BACKEND_DIR / ".env"
        self._upsert_env_var(env_path, "SAVEMYCONTEXT_MARKDOWN_DIR", str(markdown_root))
        return "backend_env", str(env_path)

    def _persistence_kind(self) -> str:
        config_path_value = os.environ.get("SAVEMYCONTEXT_CLI_CONFIG_PATH", "").strip()
        return "cli_config" if config_path_value else "backend_env"

    def _persistence_target(self) -> str | None:
        config_path_value = os.environ.get("SAVEMYCONTEXT_CLI_CONFIG_PATH", "").strip()
        if config_path_value:
            return str(Path(config_path_value).expanduser().resolve())
        return str(BACKEND_DIR / ".env")

    def _upsert_env_var(self, env_path: Path, key: str, value: str) -> None:
        env_path.parent.mkdir(parents=True, exist_ok=True)
        existing_lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []
        rendered = f"{key}={value}"
        updated_lines: list[str] = []
        replaced = False
        for line in existing_lines:
            if line.startswith(f"{key}="):
                updated_lines.append(rendered)
                replaced = True
            else:
                updated_lines.append(line)
        if not replaced:
            updated_lines.append(rendered)
        env_path.write_text("\n".join(updated_lines).rstrip() + "\n", encoding="utf-8")
