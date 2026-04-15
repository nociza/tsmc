from __future__ import annotations

import os
import textwrap
import tomllib
from dataclasses import dataclass
from pathlib import Path

from app.cli_paths import CLIPaths, default_cli_paths


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 18888
DEFAULT_LLM_BACKEND = "auto"
DEFAULT_SERVICE_NAME = "tsmc"
DEFAULT_BROWSER_TIMEOUT_SECONDS = 120.0


@dataclass(frozen=True)
class CLIConfig:
    host: str
    port: int
    data_dir: Path
    markdown_dir: Path
    llm_backend: str
    browser_llm_model: str
    browser_llm_state_path: Path
    public_url: str | None
    service_name: str
    browser_profile_dir: Path
    browser_headless: bool
    browser_channel: str | None
    browser_executable_path: str | None
    browser_timeout_seconds: float

    @property
    def database_path(self) -> Path:
        return self.data_dir / "tsmc.db"

    @property
    def database_url(self) -> str:
        return f"sqlite+aiosqlite:///{self.database_path}"


def default_cli_config(paths: CLIPaths | None = None) -> CLIConfig:
    resolved_paths = paths or default_cli_paths()
    return CLIConfig(
        host=DEFAULT_HOST,
        port=DEFAULT_PORT,
        data_dir=resolved_paths.data_dir,
        markdown_dir=resolved_paths.markdown_dir,
        llm_backend=DEFAULT_LLM_BACKEND,
        browser_llm_model="browser-gemini",
        browser_llm_state_path=resolved_paths.data_dir / "browser-llm-state.json",
        public_url=None,
        service_name=DEFAULT_SERVICE_NAME,
        browser_profile_dir=resolved_paths.data_dir / "browser-profile",
        browser_headless=True,
        browser_channel="chromium",
        browser_executable_path=None,
        browser_timeout_seconds=DEFAULT_BROWSER_TIMEOUT_SECONDS,
    )


def render_cli_config(config: CLIConfig) -> str:
    public_url_line = f'public_url = "{config.public_url}"' if config.public_url else "public_url = \"\""
    return textwrap.dedent(
        f"""\
        [server]
        host = "{config.host}"
        port = {config.port}
        public_url = {public_url_line.split(' = ', 1)[1]}

        [storage]
        data_dir = "{config.data_dir}"
        markdown_dir = "{config.markdown_dir}"

        [processing]
        llm_backend = "{config.llm_backend}"
        browser_llm_model = "{config.browser_llm_model}"
        browser_llm_state_path = "{config.browser_llm_state_path}"

        [browser]
        profile_dir = "{config.browser_profile_dir}"
        headless = {str(config.browser_headless).lower()}
        channel = "{config.browser_channel or ''}"
        executable_path = "{config.browser_executable_path or ''}"
        timeout_seconds = {config.browser_timeout_seconds}

        [service]
        name = "{config.service_name}"
        """
    )


def parse_cli_config(config_path: Path, *, paths: CLIPaths | None = None) -> CLIConfig:
    resolved_paths = paths or default_cli_paths()
    default_config = default_cli_config(resolved_paths)

    with config_path.open("rb") as handle:
        raw = tomllib.load(handle)

    server = raw.get("server", {})
    storage = raw.get("storage", {})
    processing = raw.get("processing", {})
    browser = raw.get("browser", {})
    service = raw.get("service", {})

    data_dir = Path(storage.get("data_dir", default_config.data_dir)).expanduser().resolve()
    markdown_dir = Path(storage.get("markdown_dir", data_dir / "markdown")).expanduser().resolve()

    return CLIConfig(
        host=str(server.get("host", default_config.host)),
        port=int(server.get("port", default_config.port)),
        data_dir=data_dir,
        markdown_dir=markdown_dir,
        llm_backend=str(processing.get("llm_backend", default_config.llm_backend)),
        browser_llm_model=str(processing.get("browser_llm_model", default_config.browser_llm_model)),
        browser_llm_state_path=Path(
            processing.get("browser_llm_state_path", default_config.browser_llm_state_path)
        ).expanduser().resolve(),
        public_url=(str(server.get("public_url")).strip() if server.get("public_url") else None),
        service_name=str(service.get("name", default_config.service_name)),
        browser_profile_dir=Path(browser.get("profile_dir", default_config.browser_profile_dir)).expanduser().resolve(),
        browser_headless=bool(browser.get("headless", default_config.browser_headless)),
        browser_channel=(str(browser.get("channel")).strip() if browser.get("channel") else default_config.browser_channel),
        browser_executable_path=(
            str(browser.get("executable_path")).strip() if browser.get("executable_path") else default_config.browser_executable_path
        ),
        browser_timeout_seconds=float(browser.get("timeout_seconds", default_config.browser_timeout_seconds)),
    )


def load_cli_config(config_path: Path | None = None, *, paths: CLIPaths | None = None) -> CLIConfig:
    resolved_paths = paths or default_cli_paths()
    candidate = (config_path or resolved_paths.config_path).expanduser().resolve()
    if not candidate.exists():
        return default_cli_config(resolved_paths)
    return parse_cli_config(candidate, paths=resolved_paths)


def save_cli_config(config: CLIConfig, config_path: Path | None = None) -> Path:
    paths = default_cli_paths()
    candidate = (config_path or paths.config_path).expanduser().resolve()
    candidate.parent.mkdir(parents=True, exist_ok=True)
    candidate.write_text(render_cli_config(config), encoding="utf-8")
    return candidate


def merge_cli_config(
    base: CLIConfig,
    *,
    host: str | None = None,
    port: int | None = None,
    data_dir: Path | None = None,
    markdown_dir: Path | None = None,
    llm_backend: str | None = None,
    browser_llm_model: str | None = None,
    browser_llm_state_path: Path | None = None,
    public_url: str | None = None,
    service_name: str | None = None,
    browser_profile_dir: Path | None = None,
    browser_headless: bool | None = None,
    browser_channel: str | None = None,
    browser_executable_path: str | None = None,
    browser_timeout_seconds: float | None = None,
) -> CLIConfig:
    next_data_dir = (data_dir or base.data_dir).expanduser().resolve()
    if markdown_dir is not None:
        next_markdown_dir = markdown_dir.expanduser().resolve()
    elif data_dir is not None and base.markdown_dir == (base.data_dir / "markdown"):
        next_markdown_dir = (next_data_dir / "markdown").resolve()
    else:
        next_markdown_dir = base.markdown_dir.expanduser().resolve()
    if browser_profile_dir is not None:
        next_browser_profile_dir = browser_profile_dir.expanduser().resolve()
    elif data_dir is not None and base.browser_profile_dir == (base.data_dir / "browser-profile"):
        next_browser_profile_dir = (next_data_dir / "browser-profile").resolve()
    else:
        next_browser_profile_dir = base.browser_profile_dir.expanduser().resolve()
    if browser_llm_state_path is not None:
        next_browser_llm_state_path = browser_llm_state_path.expanduser().resolve()
    elif data_dir is not None and base.browser_llm_state_path == (base.data_dir / "browser-llm-state.json"):
        next_browser_llm_state_path = (next_data_dir / "browser-llm-state.json").resolve()
    else:
        next_browser_llm_state_path = base.browser_llm_state_path.expanduser().resolve()
    return CLIConfig(
        host=host or base.host,
        port=port or base.port,
        data_dir=next_data_dir,
        markdown_dir=next_markdown_dir,
        llm_backend=llm_backend or base.llm_backend,
        browser_llm_model=browser_llm_model or base.browser_llm_model,
        browser_llm_state_path=next_browser_llm_state_path,
        public_url=public_url if public_url is not None else base.public_url,
        service_name=service_name or base.service_name,
        browser_profile_dir=next_browser_profile_dir,
        browser_headless=base.browser_headless if browser_headless is None else browser_headless,
        browser_channel=base.browser_channel if browser_channel is None else browser_channel,
        browser_executable_path=(
            base.browser_executable_path if browser_executable_path is None else browser_executable_path
        ),
        browser_timeout_seconds=base.browser_timeout_seconds if browser_timeout_seconds is None else browser_timeout_seconds,
    )


def ensure_cli_directories(config: CLIConfig, paths: CLIPaths | None = None) -> None:
    resolved_paths = paths or default_cli_paths()
    resolved_paths.config_dir.mkdir(parents=True, exist_ok=True)
    config.data_dir.mkdir(parents=True, exist_ok=True)
    config.markdown_dir.mkdir(parents=True, exist_ok=True)
    config.browser_profile_dir.mkdir(parents=True, exist_ok=True)
    config.browser_llm_state_path.parent.mkdir(parents=True, exist_ok=True)
    resolved_paths.systemd_user_dir.mkdir(parents=True, exist_ok=True)


def ensure_env_file(env_path: Path | None = None, *, force: bool = False) -> Path:
    paths = default_cli_paths()
    candidate = (env_path or paths.env_path).expanduser().resolve()
    if candidate.exists() and not force:
        return candidate

    candidate.parent.mkdir(parents=True, exist_ok=True)
    candidate.write_text(
        textwrap.dedent(
            """\
            TSMC_EXPERIMENTAL_BROWSER_AUTOMATION=false
            TSMC_OPENAI_API_KEY=
            TSMC_OPENAI_BASE_URL=https://openrouter.ai/api/v1
            TSMC_OPENAI_MODEL=openai/gpt-4.1-mini
            TSMC_OPENAI_APP_NAME=TSMC
            TSMC_OPENAI_SITE_URL=
            TSMC_GOOGLE_API_KEY=
            TSMC_GIT_VERSIONING_ENABLED=true
            TSMC_CORS_ORIGIN_REGEX=chrome-extension://[a-p]{32}
            """
        ),
        encoding="utf-8",
    )
    return candidate


def load_env_file(env_path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not env_path.exists():
        return values

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key:
            values[key] = value.strip()
    return values


def apply_runtime_environment(config: CLIConfig, env_path: Path) -> None:
    for key, value in load_env_file(env_path).items():
        os.environ.setdefault(key, value)

    os.environ.setdefault("TSMC_DATABASE_URL", config.database_url)
    os.environ.setdefault("TSMC_MARKDOWN_DIR", str(config.markdown_dir))
    os.environ.setdefault("TSMC_LLM_BACKEND", config.llm_backend)
    os.environ.setdefault("TSMC_BROWSER_LLM_MODEL", config.browser_llm_model)
    os.environ.setdefault("TSMC_BROWSER_LLM_STATE_PATH", str(config.browser_llm_state_path))
    if config.public_url:
        os.environ.setdefault("TSMC_PUBLIC_URL", config.public_url)
    os.environ.setdefault("TSMC_BROWSER_PROFILE_DIR", str(config.browser_profile_dir))
    os.environ.setdefault("TSMC_BROWSER_HEADLESS", "true" if config.browser_headless else "false")
    if config.browser_channel:
        os.environ.setdefault("TSMC_BROWSER_CHANNEL", config.browser_channel)
    if config.browser_executable_path:
        os.environ.setdefault("TSMC_BROWSER_EXECUTABLE_PATH", config.browser_executable_path)
    os.environ.setdefault("TSMC_BROWSER_TIMEOUT_SECONDS", str(config.browser_timeout_seconds))
