from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


BACKEND_DIR = Path(__file__).resolve().parents[2]
ROOT_DIR = BACKEND_DIR.parent


class Settings(BaseSettings):
    app_name: str = "TSMC API"
    debug: bool = False
    api_v1_prefix: str = "/api/v1"
    database_url: str = "sqlite+aiosqlite:///./data/tsmc.db"
    markdown_dir: Path = Field(default=BACKEND_DIR / "data" / "markdown")
    vault_root_name: str = "TSMC"
    public_url: str | None = None
    minimum_extension_version: str = "0.2.0"
    llm_backend: str = "auto"
    openai_api_key: str | None = None
    openai_model: str = "gpt-5-mini"
    google_api_key: str | None = None
    google_model: str = "gemini-2.5-flash"
    request_timeout_seconds: float = 30.0
    cors_origins: list[str] = Field(default_factory=list)
    cors_origin_regex: str | None = r"chrome-extension://[a-p]{32}"

    model_config = SettingsConfigDict(
        env_prefix="TSMC_",
        extra="ignore",
        env_file=(
            str(ROOT_DIR / ".env"),
            str(BACKEND_DIR / ".env"),
        ),
    )

    @property
    def resolved_database_url(self) -> str:
        if self.database_url.startswith("sqlite") and ":///" in self.database_url:
            prefix, path = self.database_url.split(":///", maxsplit=1)
            if path.startswith("."):
                absolute = (BACKEND_DIR / path).resolve()
                return f"{prefix}:///{absolute}"
        return self.database_url

    @property
    def resolved_markdown_dir(self) -> Path:
        if self.markdown_dir.is_absolute():
            return self.markdown_dir
        return (BACKEND_DIR / self.markdown_dir).resolve()

    @property
    def resolved_vault_root(self) -> Path:
        return self.resolved_markdown_dir / self.vault_root_name


@lru_cache
def get_settings() -> Settings:
    return Settings()
