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


def env_alias(name: str, *extra_names: str) -> AliasChoices:
    return AliasChoices(f"SAVEMYCONTEXT_{name}", *extra_names)


class Settings(BaseSettings):
    app_name: str = Field(default="SaveMyContext API", validation_alias=env_alias("APP_NAME"))
    debug: bool = Field(default=False, validation_alias=env_alias("DEBUG"))
    api_v1_prefix: str = "/api/v1"
    database_url: str = Field(
        default="sqlite+aiosqlite:///./data/savemycontext.db",
        validation_alias=env_alias("DATABASE_URL"),
    )
    markdown_dir: Path = Field(default=BACKEND_DIR / "data" / "markdown", validation_alias=env_alias("MARKDOWN_DIR"))
    vault_root_name: str = Field(default="SaveMyContext", validation_alias=env_alias("VAULT_ROOT_NAME"))
    public_url: str | None = Field(default=None, validation_alias=env_alias("PUBLIC_URL"))
    minimum_extension_version: str = Field(default="0.2.0", validation_alias=env_alias("MINIMUM_EXTENSION_VERSION"))
    llm_backend: str = Field(default="auto", validation_alias=env_alias("LLM_BACKEND"))
    experimental_browser_automation: bool = Field(
        default=False,
        validation_alias=AliasChoices(
            "SAVEMYCONTEXT_EXPERIMENTAL_BROWSER_AUTOMATION",
            "SAVEMYCONTEXT_EXPERIMENTAL_BROWSER_PROXY",
        ),
    )
    browser_profile_dir: Path = Field(default=BACKEND_DIR / "data" / "browser-profile", validation_alias=env_alias("BROWSER_PROFILE_DIR"))
    browser_llm_model: str = Field(default="browser-gemini", validation_alias=env_alias("BROWSER_LLM_MODEL"))
    browser_llm_state_path: Path = Field(
        default=BACKEND_DIR / "data" / "browser-llm-state.json",
        validation_alias=env_alias("BROWSER_LLM_STATE_PATH"),
    )
    processing_batch_size: int = Field(default=2, validation_alias=env_alias("PROCESSING_BATCH_SIZE"))
    processing_batch_max_chars: int = Field(default=12_000, validation_alias=env_alias("PROCESSING_BATCH_MAX_CHARS"))
    browser_headless: bool = Field(default=True, validation_alias=env_alias("BROWSER_HEADLESS"))
    browser_channel: str | None = Field(default="chromium", validation_alias=env_alias("BROWSER_CHANNEL"))
    browser_executable_path: str | None = Field(default=None, validation_alias=env_alias("BROWSER_EXECUTABLE_PATH"))
    browser_timeout_seconds: float = Field(default=120.0, validation_alias=env_alias("BROWSER_TIMEOUT_SECONDS"))
    openai_api_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "SAVEMYCONTEXT_OPENAI_API_KEY",
            "SAVEMYCONTEXT_OPENAI_COMPATIBLE_API_KEY",
            "OPENAI_API_KEY",
            "OPENROUTER_API_KEY",
        ),
    )
    openai_base_url: str = Field(
        default=DEFAULT_OPENAI_BASE_URL,
        validation_alias=AliasChoices(
            "SAVEMYCONTEXT_OPENAI_BASE_URL",
            "SAVEMYCONTEXT_OPENAI_COMPATIBLE_BASE_URL",
            "OPENAI_BASE_URL",
            "OPENROUTER_BASE_URL",
        ),
    )
    openai_model: str = Field(
        default=DEFAULT_OPENAI_MODEL,
        validation_alias=AliasChoices(
            "SAVEMYCONTEXT_OPENAI_MODEL",
            "SAVEMYCONTEXT_OPENAI_COMPATIBLE_MODEL",
            "OPENAI_MODEL",
            "OPENROUTER_MODEL",
        ),
    )
    openai_site_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "SAVEMYCONTEXT_OPENAI_SITE_URL",
            "SAVEMYCONTEXT_OPENAI_COMPATIBLE_SITE_URL",
            "OPENAI_SITE_URL",
            "OPENROUTER_SITE_URL",
        ),
    )
    openai_app_name: str = Field(
        default="SaveMyContext",
        validation_alias=AliasChoices(
            "SAVEMYCONTEXT_OPENAI_APP_NAME",
            "SAVEMYCONTEXT_OPENAI_COMPATIBLE_APP_NAME",
            "OPENAI_APP_NAME",
            "OPENROUTER_APP_NAME",
        ),
    )
    google_api_key: str | None = Field(default=None, validation_alias=env_alias("GOOGLE_API_KEY"))
    google_model: str = Field(default="gemini-2.5-flash", validation_alias=env_alias("GOOGLE_MODEL"))
    request_timeout_seconds: float = Field(default=30.0, validation_alias=env_alias("REQUEST_TIMEOUT_SECONDS"))
    git_versioning_enabled: bool = Field(default=True, validation_alias=env_alias("GIT_VERSIONING_ENABLED"))
    git_executable: str = Field(default="git", validation_alias=env_alias("GIT_EXECUTABLE"))
    git_author_name: str = Field(default="SaveMyContext", validation_alias=env_alias("GIT_AUTHOR_NAME"))
    git_author_email: str = Field(default="savemycontext@localhost", validation_alias=env_alias("GIT_AUTHOR_EMAIL"))
    cors_origins: list[str] = Field(default_factory=list, validation_alias=env_alias("CORS_ORIGINS"))
    cors_origin_regex: str | None = Field(default=r"chrome-extension://[a-p]{32}", validation_alias=env_alias("CORS_ORIGIN_REGEX"))

    model_config = SettingsConfigDict(
        env_prefix="SAVEMYCONTEXT_",
        extra="ignore",
        populate_by_name=True,
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
