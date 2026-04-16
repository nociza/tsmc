from __future__ import annotations

import plistlib
from pathlib import Path

from app.cli_config import CLIConfig, default_cli_config, merge_cli_config, parse_cli_config, render_cli_config
from app.cli_paths import CLIPaths, default_cli_paths
from app.cli_service import render_launchd_plist, render_systemd_unit


def make_paths(tmp_path: Path) -> CLIPaths:
    config_dir = tmp_path / "config"
    data_dir = tmp_path / "data"
    return CLIPaths(
        config_dir=config_dir,
        config_path=config_dir / "config.toml",
        env_path=config_dir / "savemycontext.env",
        data_dir=data_dir,
        markdown_dir=data_dir / "markdown",
        database_path=data_dir / "savemycontext.db",
        systemd_user_dir=tmp_path / "systemd-user",
        unit_path=tmp_path / "systemd-user" / "savemycontext.service",
    )


def test_cli_config_round_trip(tmp_path: Path) -> None:
    paths = make_paths(tmp_path)
    config = merge_cli_config(
        default_cli_config(paths),
        host="0.0.0.0",
        port=8123,
        data_dir=tmp_path / "srv" / "savemycontext",
        markdown_dir=tmp_path / "srv" / "savemycontext" / "markdown",
        public_url="https://example.test/savemycontext",
    )

    paths.config_path.parent.mkdir(parents=True, exist_ok=True)
    paths.config_path.write_text(render_cli_config(config), encoding="utf-8")

    parsed = parse_cli_config(paths.config_path, paths=paths)

    assert parsed.host == "0.0.0.0"
    assert parsed.port == 8123
    assert parsed.data_dir == (tmp_path / "srv" / "savemycontext").resolve()
    assert parsed.markdown_dir == (tmp_path / "srv" / "savemycontext" / "markdown").resolve()
    assert parsed.public_url == "https://example.test/savemycontext"
    assert parsed.browser_llm_model == "browser-gemini"
    assert parsed.browser_llm_state_path == (tmp_path / "srv" / "savemycontext" / "browser-llm-state.json").resolve()
    assert parsed.browser_profile_dir == (tmp_path / "srv" / "savemycontext" / "browser-profile").resolve()
    assert parsed.browser_headless is True
    assert parsed.browser_channel == "chromium"


def test_render_systemd_unit_uses_savemycontext_run_command(tmp_path: Path) -> None:
    paths = make_paths(tmp_path)
    config = CLIConfig(
        host="127.0.0.1",
        port=18888,
        data_dir=(tmp_path / "srv" / "savemycontext").resolve(),
        markdown_dir=(tmp_path / "srv" / "savemycontext" / "markdown").resolve(),
        llm_backend="auto",
        browser_llm_model="browser-gemini",
        browser_llm_state_path=(tmp_path / "srv" / "savemycontext" / "browser-llm-state.json").resolve(),
        public_url=None,
        service_name="savemycontext",
        browser_profile_dir=(tmp_path / "srv" / "savemycontext" / "browser-profile").resolve(),
        browser_headless=True,
        browser_channel="chromium",
        browser_executable_path=None,
        browser_timeout_seconds=120.0,
    )

    unit = render_systemd_unit(config, paths)

    assert "Managed by SaveMyContext" in unit
    assert "ExecStart=" in unit
    assert " run --config " in unit
    assert str(paths.config_path) in unit
    assert str(paths.env_path) in unit


def test_default_cli_paths_use_launchagents_on_macos(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)

    paths = default_cli_paths(system_name="Darwin")

    assert paths.config_path == (tmp_path / "Library" / "Application Support" / "savemycontext" / "config.toml")
    assert paths.data_dir == (tmp_path / "Library" / "Application Support" / "savemycontext" / "data")
    assert paths.service_definition_path == (tmp_path / "Library" / "LaunchAgents" / "savemycontext.plist")


def test_default_cli_paths_keep_launchagents_on_macos_even_with_xdg_overrides(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / ".config"))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / ".local" / "share"))

    paths = default_cli_paths(system_name="Darwin")

    assert paths.config_dir == (tmp_path / ".config" / "savemycontext")
    assert paths.data_dir == (tmp_path / ".local" / "share" / "savemycontext")
    assert paths.service_definition_path == (tmp_path / "Library" / "LaunchAgents" / "savemycontext.plist")


def test_render_launchd_plist_sources_env_and_runs_savemycontext(tmp_path: Path) -> None:
    paths = make_paths(tmp_path)
    paths = CLIPaths(
        config_dir=paths.config_dir,
        config_path=paths.config_path,
        env_path=paths.env_path,
        data_dir=paths.data_dir,
        markdown_dir=paths.markdown_dir,
        database_path=paths.database_path,
        systemd_user_dir=tmp_path / "LaunchAgents",
        unit_path=tmp_path / "LaunchAgents" / "savemycontext.plist",
    )
    config = default_cli_config(paths)

    payload = plistlib.loads(render_launchd_plist(config, paths))

    assert payload["Label"] == "savemycontext"
    assert payload["ProgramArguments"][0:2] == ["/bin/sh", "-lc"]
    assert str(paths.env_path) in payload["ProgramArguments"][2]
    assert " run --config " in payload["ProgramArguments"][2]
    assert payload["WorkingDirectory"] == str(config.data_dir)
    assert payload["StandardOutPath"].endswith("service.stdout.log")
    assert payload["StandardErrorPath"].endswith("service.stderr.log")
    assert payload["SaveMyContextManaged"] is True
