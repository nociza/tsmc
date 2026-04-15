from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def xdg_config_home() -> Path:
    return Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")).expanduser().resolve()


def xdg_data_home() -> Path:
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")).expanduser().resolve()


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


def default_cli_paths() -> CLIPaths:
    config_dir = xdg_config_home() / "savemycontext"
    data_dir = xdg_data_home() / "savemycontext"
    return CLIPaths(
        config_dir=config_dir,
        config_path=config_dir / "config.toml",
        env_path=config_dir / "savemycontext.env",
        data_dir=data_dir,
        markdown_dir=data_dir / "markdown",
        database_path=data_dir / "savemycontext.db",
        systemd_user_dir=xdg_config_home() / "systemd" / "user",
        unit_path=xdg_config_home() / "systemd" / "user" / "savemycontext.service",
    )
