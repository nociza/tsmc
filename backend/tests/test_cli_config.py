from __future__ import annotations

from pathlib import Path

from app.cli_config import CLIConfig, default_cli_config, merge_cli_config, parse_cli_config, render_cli_config
from app.cli_paths import CLIPaths
from app.cli_service import render_systemd_unit


def make_paths(tmp_path: Path) -> CLIPaths:
    config_dir = tmp_path / "config"
    data_dir = tmp_path / "data"
    return CLIPaths(
        config_dir=config_dir,
        config_path=config_dir / "config.toml",
        env_path=config_dir / "tsmc.env",
        data_dir=data_dir,
        markdown_dir=data_dir / "markdown",
        database_path=data_dir / "tsmc.db",
        systemd_user_dir=tmp_path / "systemd-user",
        unit_path=tmp_path / "systemd-user" / "tsmc.service",
    )


def test_cli_config_round_trip(tmp_path: Path) -> None:
    paths = make_paths(tmp_path)
    config = merge_cli_config(
        default_cli_config(paths),
        host="0.0.0.0",
        port=8123,
        data_dir=tmp_path / "srv" / "tsmc",
        markdown_dir=tmp_path / "srv" / "tsmc" / "markdown",
        public_url="https://example.test/tsmc",
    )

    paths.config_path.parent.mkdir(parents=True, exist_ok=True)
    paths.config_path.write_text(render_cli_config(config), encoding="utf-8")

    parsed = parse_cli_config(paths.config_path, paths=paths)

    assert parsed.host == "0.0.0.0"
    assert parsed.port == 8123
    assert parsed.data_dir == (tmp_path / "srv" / "tsmc").resolve()
    assert parsed.markdown_dir == (tmp_path / "srv" / "tsmc" / "markdown").resolve()
    assert parsed.public_url == "https://example.test/tsmc"
    assert parsed.browser_llm_model == "browser-gemini"
    assert parsed.browser_llm_state_path == (tmp_path / "srv" / "tsmc" / "browser-llm-state.json").resolve()
    assert parsed.browser_profile_dir == (tmp_path / "srv" / "tsmc" / "browser-profile").resolve()
    assert parsed.browser_headless is True
    assert parsed.browser_channel == "chromium"


def test_render_systemd_unit_uses_tsmc_run_command(tmp_path: Path) -> None:
    paths = make_paths(tmp_path)
    config = CLIConfig(
        host="127.0.0.1",
        port=18888,
        data_dir=(tmp_path / "srv" / "tsmc").resolve(),
        markdown_dir=(tmp_path / "srv" / "tsmc" / "markdown").resolve(),
        llm_backend="auto",
        browser_llm_model="browser-gemini",
        browser_llm_state_path=(tmp_path / "srv" / "tsmc" / "browser-llm-state.json").resolve(),
        public_url=None,
        service_name="tsmc",
        browser_profile_dir=(tmp_path / "srv" / "tsmc" / "browser-profile").resolve(),
        browser_headless=True,
        browser_channel="chromium",
        browser_executable_path=None,
        browser_timeout_seconds=120.0,
    )

    unit = render_systemd_unit(config, paths)

    assert "Managed by TSMC" in unit
    assert "ExecStart=" in unit
    assert " run --config " in unit
    assert str(paths.config_path) in unit
    assert str(paths.env_path) in unit
