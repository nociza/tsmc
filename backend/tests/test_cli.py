from __future__ import annotations

import os
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.cli import build_parser, main
from app.cli_config import default_cli_config, load_cli_config, load_env_file
from app.cli_paths import CLIPaths, default_cli_paths
from app.cli_service import fetch_health, get_service_status, service_control


def reset_runtime_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in list(os.environ):
        if key.startswith("SAVEMYCONTEXT_") or key.startswith("OPENAI_") or key.startswith("OPENROUTER_"):
            monkeypatch.delenv(key, raising=False)


def configure_xdg(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> CLIPaths:
    config_home = tmp_path / ".config"
    data_home = tmp_path / ".local" / "share"
    monkeypatch.setenv("XDG_CONFIG_HOME", str(config_home))
    monkeypatch.setenv("XDG_DATA_HOME", str(data_home))
    return default_cli_paths()


def test_config_init_bootstraps_local_runtime(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    reset_runtime_env(monkeypatch)
    paths = configure_xdg(monkeypatch, tmp_path)

    exit_code = main(
        [
            "config",
            "init",
            "--port",
            "19999",
            "--llm-backend",
            "openai",
            "--openai-api-key",
            "sk-test",
            "--openai-model",
            "openai/gpt-4.1-mini",
        ]
    )

    assert exit_code == 0
    assert paths.config_path.exists()
    assert paths.env_path.exists()
    assert paths.data_dir.exists()
    assert paths.markdown_dir.exists()
    assert paths.database_path.exists()

    config = load_cli_config(paths.config_path, paths=paths)
    env_values = load_env_file(paths.env_path)
    output = capsys.readouterr().out

    assert config.port == 19999
    assert config.llm_backend == "openai"
    assert env_values["SAVEMYCONTEXT_OPENAI_API_KEY"] == "sk-test"
    assert env_values["SAVEMYCONTEXT_OPENAI_MODEL"] == "openai/gpt-4.1-mini"
    assert "savemycontext service install --start" in output


def test_config_set_updates_storage_and_env_settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    reset_runtime_env(monkeypatch)
    paths = configure_xdg(monkeypatch, tmp_path)
    main(["config", "init"])

    custom_markdown_dir = tmp_path / "vault"
    exit_code = main(
        [
            "config",
            "set",
            "--markdown-dir",
            str(custom_markdown_dir),
            "--openai-base-url",
            "https://openrouter.ai/api/v1",
            "--no-git-versioning",
        ]
    )

    assert exit_code == 0

    config = load_cli_config(paths.config_path, paths=paths)
    env_values = load_env_file(paths.env_path)

    assert config.markdown_dir == custom_markdown_dir.resolve()
    assert env_values["SAVEMYCONTEXT_OPENAI_BASE_URL"] == "https://openrouter.ai/api/v1"
    assert env_values["SAVEMYCONTEXT_GIT_VERSIONING_ENABLED"] == "false"


def test_config_help_lists_init_and_set_commands(capsys: pytest.CaptureFixture[str]) -> None:
    parser = build_parser()

    with pytest.raises(SystemExit):
        parser.parse_args(["config", "--help"])

    output = capsys.readouterr().out
    assert "init" in output
    assert "set" in output


def test_fetch_health_rejects_unexpected_payload(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    class FakeResponse:
        status = 200

        def __enter__(self) -> "FakeResponse":
            return self

        def __exit__(self, exc_type, exc, tb) -> bool:
            return False

        def read(self) -> bytes:
            return b'{"status":"ok"}'

    monkeypatch.setattr("app.cli_service.urllib.request.urlopen", lambda *args, **kwargs: FakeResponse())
    config = default_cli_config(
        CLIPaths(
            config_dir=tmp_path / "config",
            config_path=tmp_path / "config" / "config.toml",
            env_path=tmp_path / "config" / "savemycontext.env",
            data_dir=tmp_path / "data",
            markdown_dir=tmp_path / "data" / "markdown",
            database_path=tmp_path / "data" / "savemycontext.db",
            systemd_user_dir=tmp_path / "systemd",
            unit_path=tmp_path / "systemd" / "savemycontext.service",
        )
    )

    health_ok, health_status_code, health_error = fetch_health(config)

    assert health_ok is False
    assert health_status_code == 200
    assert health_error == "health payload does not look like SaveMyContext"


def test_get_service_status_uses_launchd_on_macos(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    paths = CLIPaths(
        config_dir=tmp_path / "config",
        config_path=tmp_path / "config" / "config.toml",
        env_path=tmp_path / "config" / "savemycontext.env",
        data_dir=tmp_path / "data",
        markdown_dir=tmp_path / "data" / "markdown",
        database_path=tmp_path / "data" / "savemycontext.db",
        systemd_user_dir=tmp_path / "LaunchAgents",
        unit_path=tmp_path / "LaunchAgents" / "savemycontext.plist",
    )
    paths.service_definition_path.parent.mkdir(parents=True, exist_ok=True)
    paths.service_definition_path.write_text("managed", encoding="utf-8")

    monkeypatch.setattr("app.cli_service.current_service_manager", lambda system_name=None: "launchd")
    monkeypatch.setattr("app.cli_service.service_manager_display_name", lambda system_name=None: "launchd")
    monkeypatch.setattr("app.cli_service.launchd_is_loaded", lambda config: (True, "running"))
    monkeypatch.setattr("app.cli_service.fetch_health", lambda config: (True, 200, None))

    status = get_service_status(default_cli_config(paths), paths)

    assert status.active is True
    assert status.enabled is True
    assert status.manager_name == "launchd"
    assert status.manager_state == "running"
    assert status.health_ok is True


def test_doctor_fails_when_healthcheck_is_down(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    reset_runtime_env(monkeypatch)
    configure_xdg(monkeypatch, tmp_path)
    assert main(["config", "init"]) == 0

    monkeypatch.setattr("app.cli.current_service_manager", lambda: "launchd")
    monkeypatch.setattr("app.cli.port_is_open", lambda host, port: False)
    monkeypatch.setattr(
        "app.cli.get_service_status",
        lambda config, paths: SimpleNamespace(
            active=False,
            enabled=False,
            manager_name="launchd",
            manager_state="unloaded",
            health_ok=False,
            health_status_code=None,
            health_error="connection refused",
        ),
    )
    monkeypatch.setattr(
        "app.cli.shutil.which",
        lambda command: "/usr/bin/launchctl" if command == "launchctl" else "/usr/bin/git",
    )

    exit_code = main(["doctor"])
    output = capsys.readouterr().out

    assert exit_code == 1
    assert "Health check failed" in output


def test_service_control_start_reloads_launchd_job(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    paths = CLIPaths(
        config_dir=tmp_path / "config",
        config_path=tmp_path / "config" / "config.toml",
        env_path=tmp_path / "config" / "savemycontext.env",
        data_dir=tmp_path / "data",
        markdown_dir=tmp_path / "data" / "markdown",
        database_path=tmp_path / "data" / "savemycontext.db",
        systemd_user_dir=tmp_path / "LaunchAgents",
        unit_path=tmp_path / "LaunchAgents" / "savemycontext.plist",
    )
    paths.service_definition_path.parent.mkdir(parents=True, exist_ok=True)
    paths.service_definition_path.write_text("managed", encoding="utf-8")
    config = default_cli_config(paths)
    commands: list[list[str]] = []

    monkeypatch.setattr("app.cli_service.current_service_manager", lambda system_name=None: "launchd")
    monkeypatch.setattr("app.cli_service.launchd_is_loaded", lambda config: (True, "running"))

    def fake_run_command(command: list[str], *, check: bool = True, capture_output: bool = True) -> subprocess.CompletedProcess[str]:
        commands.append(command)
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr("app.cli_service.run_command", fake_run_command)

    service_control("start", config, paths)

    assert ["launchctl", "bootout", f"gui/{os.getuid()}/{config.service_name}"] in commands
    assert ["launchctl", "bootstrap", f"gui/{os.getuid()}", str(paths.service_definition_path)] in commands
    assert ["launchctl", "kickstart", "-k", f"gui/{os.getuid()}/{config.service_name}"] in commands
