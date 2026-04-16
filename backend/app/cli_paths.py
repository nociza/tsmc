from __future__ import annotations

import os
import platform
from dataclasses import dataclass
from pathlib import Path


def xdg_config_home() -> Path:
    return Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")).expanduser().resolve()


def xdg_data_home() -> Path:
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")).expanduser().resolve()


def macos_application_support_home() -> Path:
    base = Path(os.environ.get("SAVEMYCONTEXT_APP_SUPPORT_HOME", Path.home() / "Library" / "Application Support"))
    return base.expanduser().resolve()


def host_platform(system_name: str | None = None) -> str:
    normalized = (system_name or platform.system()).strip().lower()
    if normalized == "darwin":
        return "macos"
    if normalized == "linux":
        return "linux"
    return normalized or "unknown"


@dataclass(frozen=True)
class CLIPaths:
    config_dir: Path
    config_path: Path
    env_path: Path
    data_dir: Path
    markdown_dir: Path
    database_path: Path
    systemd_user_dir: Path
    unit_path: Path

    @property
    def service_definition_dir(self) -> Path:
        return self.systemd_user_dir

    @property
    def service_definition_path(self) -> Path:
        return self.unit_path


def default_cli_paths(system_name: str | None = None) -> CLIPaths:
    current_platform = host_platform(system_name)
    xdg_config_override = os.environ.get("XDG_CONFIG_HOME")
    xdg_data_override = os.environ.get("XDG_DATA_HOME")

    if current_platform == "macos":
        if xdg_config_override:
            config_dir = xdg_config_home() / "savemycontext"
        else:
            config_dir = macos_application_support_home() / "savemycontext"
        if xdg_data_override:
            data_dir = xdg_data_home() / "savemycontext"
        else:
            data_dir = config_dir / "data"
        service_dir = Path.home().expanduser().resolve() / "Library" / "LaunchAgents"
        service_path = service_dir / "savemycontext.plist"
    else:
        config_dir = xdg_config_home() / "savemycontext"
        data_dir = xdg_data_home() / "savemycontext"
        service_dir = xdg_config_home() / "systemd" / "user"
        service_path = service_dir / "savemycontext.service"

    return CLIPaths(
        config_dir=config_dir,
        config_path=config_dir / "config.toml",
        env_path=config_dir / "savemycontext.env",
        data_dir=data_dir,
        markdown_dir=data_dir / "markdown",
        database_path=data_dir / "savemycontext.db",
        systemd_user_dir=service_dir,
        unit_path=service_path,
    )
