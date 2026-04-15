from __future__ import annotations

import asyncio
import logging
import shutil
import subprocess
from pathlib import Path

from app.core.config import Settings, get_settings


logger = logging.getLogger(__name__)


class GitVersioningService:
    def __init__(
        self,
        *,
        repo_root: Path | None = None,
        settings: Settings | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.repo_root = repo_root or self.settings.resolved_vault_root

    @property
    def enabled(self) -> bool:
        return self.settings.git_versioning_enabled

    @property
    def executable(self) -> str:
        return self.settings.git_executable

    def is_available(self) -> bool:
        return shutil.which(self.executable) is not None

    async def ensure_repo(self) -> bool:
        if not self.enabled or not self.is_available():
            return False
        try:
            return await asyncio.to_thread(self._ensure_repo_sync)
        except Exception:  # pragma: no cover
            logger.exception("Failed to initialize the SaveMyContext vault git repository.")
            return False

    async def commit_all(self, *, message: str) -> bool:
        if not self.enabled or not self.is_available():
            return False
        try:
            return await asyncio.to_thread(self._commit_all_sync, message)
        except Exception:  # pragma: no cover
            logger.exception("Failed to commit SaveMyContext vault changes.")
            return False

    def _commit_all_sync(self, message: str) -> bool:
        self._ensure_repo_sync()
        self._run("add", "--all", ".")
        status = self._run("status", "--porcelain", "--untracked-files=all", capture_output=True)
        if not status.stdout.strip():
            return False
        self._run("commit", "--no-gpg-sign", "-m", message)
        return True

    def _ensure_repo_sync(self) -> bool:
        self.repo_root.mkdir(parents=True, exist_ok=True)
        git_dir = self.repo_root / ".git"
        if not git_dir.exists():
            self._run("init")
        self._run("config", "user.name", self.settings.git_author_name)
        self._run("config", "user.email", self.settings.git_author_email)
        return True

    def _run(self, *args: str, capture_output: bool = False) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [self.executable, *args],
            cwd=self.repo_root,
            check=True,
            capture_output=capture_output,
            text=True,
        )
