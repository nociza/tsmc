from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv
from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


BACKEND_DIR = Path(__file__).resolve().parents[2]
ROOT_DIR = BACKEND_DIR.parent
DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
DEFAULT_OPENAI_MODEL = "gpt-5-mini"
DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_OPENROUTER_MODEL = "openai/gpt-4.1-mini"


load_dotenv(BACKEND_DIR / ".env", override=False)
load_dotenv(ROOT_DIR / ".env", override=False)


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
    experimental_browser_automation: bool = Field(
        default=False,
        validation_alias=AliasChoices(
            "TSMC_EXPERIMENTAL_BROWSER_AUTOMATION",
            "TSMC_EXPERIMENTAL_BROWSER_PROXY",
        ),
    )
    browser_profile_dir: Path = Field(default=BACKEND_DIR / "data" / "browser-profile")
    browser_llm_model: str = "browser-gemini"
    browser_llm_state_path: Path = Field(default=BACKEND_DIR / "data" / "browser-llm-state.json")
    processing_batch_size: int = 2
    processing_batch_max_chars: int = 12_000
    browser_headless: bool = True
    browser_channel: str | None = "chromium"
    browser_executable_path: str | None = None
    browser_timeout_seconds: float = 120.0
    openai_api_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "TSMC_OPENAI_API_KEY",
            "TSMC_OPENAI_COMPATIBLE_API_KEY",
            "OPENAI_API_KEY",
            "OPENROUTER_API_KEY",
        ),
    )
    openai_base_url: str = Field(
        default=DEFAULT_OPENAI_BASE_URL,
        validation_alias=AliasChoices(
            "TSMC_OPENAI_BASE_URL",
            "TSMC_OPENAI_COMPATIBLE_BASE_URL",
            "OPENAI_BASE_URL",
            "OPENROUTER_BASE_URL",
        ),
    )
    openai_model: str = Field(
        default=DEFAULT_OPENAI_MODEL,
        validation_alias=AliasChoices(
            "TSMC_OPENAI_MODEL",
            "TSMC_OPENAI_COMPATIBLE_MODEL",
            "OPENAI_MODEL",
            "OPENROUTER_MODEL",
        ),
    )
    openai_site_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "TSMC_OPENAI_SITE_URL",
            "TSMC_OPENAI_COMPATIBLE_SITE_URL",
            "OPENAI_SITE_URL",
            "OPENROUTER_SITE_URL",
        ),
    )
    openai_app_name: str = Field(
        default="TSMC",
        validation_alias=AliasChoices(
            "TSMC_OPENAI_APP_NAME",
            "TSMC_OPENAI_COMPATIBLE_APP_NAME",
            "OPENAI_APP_NAME",
            "OPENROUTER_APP_NAME",
        ),
    )
    google_api_key: str | None = None
    google_model: str = "gemini-2.5-flash"
    request_timeout_seconds: float = 30.0
    git_versioning_enabled: bool = True
    git_executable: str = "git"
    git_author_name: str = "TSMC"
    git_author_email: str = "tsmc@localhost"
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
    def openrouter_key_detected(self) -> bool:
        if not self.openai_api_key:
            return False
        return self.openai_api_key.startswith("sk-or-")

    @property
    def resolved_openai_base_url(self) -> str:
        if self.openrouter_key_detected and self.openai_base_url == DEFAULT_OPENAI_BASE_URL:
            return DEFAULT_OPENROUTER_BASE_URL
        return self.openai_base_url

    @property
    def resolved_openai_model(self) -> str:
        if self.openrouter_key_detected and self.openai_model == DEFAULT_OPENAI_MODEL:
            return DEFAULT_OPENROUTER_MODEL
        return self.openai_model

    @property
    def resolved_vault_root(self) -> Path:
        return self.resolved_markdown_dir / self.vault_root_name

    @property
    def resolved_browser_profile_dir(self) -> Path:
        if self.browser_profile_dir.is_absolute():
            return self.browser_profile_dir
        return (BACKEND_DIR / self.browser_profile_dir).resolve()

    @property
    def resolved_browser_llm_state_path(self) -> Path:
        if self.browser_llm_state_path.is_absolute():
            return self.browser_llm_state_path
        return (BACKEND_DIR / self.browser_llm_state_path).resolve()


@lru_cache
def get_settings() -> Settings:
    return Settings()
