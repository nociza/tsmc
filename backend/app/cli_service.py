from __future__ import annotations

import shutil
import socket
import subprocess
import sys
import textwrap
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from app.cli_config import CLIConfig
from app.cli_paths import CLIPaths


MANAGED_UNIT_HEADER = "# Managed by SaveMyContext. Manual edits may be overwritten.\n"


@dataclass(frozen=True)
class ServiceStatus:
    active: bool
    enabled: bool
    systemd_state: str
    health_ok: bool
    health_status_code: int | None
    health_error: str | None


def savemycontext_executable_path() -> Path:
    executable = shutil.which("savemycontext")
    if executable:
        return Path(executable).resolve()
    return Path(sys.argv[0]).resolve()


def render_systemd_unit(config: CLIConfig, paths: CLIPaths) -> str:
    return textwrap.dedent(
        f"""\
        {MANAGED_UNIT_HEADER}[Unit]
        Description=SaveMyContext backend
        After=network.target

        [Service]
        Type=simple
        ExecStart={savemycontext_executable_path()} run --config {paths.config_path}
        EnvironmentFile={paths.env_path}
        WorkingDirectory={config.data_dir}
        Restart=on-failure
        RestartSec=2

        [Install]
        WantedBy=default.target
        """
    )


def run_command(command: list[str], *, check: bool = True, capture_output: bool = True) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            check=check,
            text=True,
            capture_output=capture_output,
        )
    except FileNotFoundError as error:  # pragma: no cover - platform dependent
        raise RuntimeError(f"Required command is not available: {command[0]}") from error
    except subprocess.CalledProcessError as error:
        stderr = (error.stderr or "").strip()
        stdout = (error.stdout or "").strip()
        detail = stderr or stdout or f"exit code {error.returncode}"
        raise RuntimeError(f"{' '.join(command)} failed: {detail}") from error


def ensure_systemd_user_available() -> None:
    run_command(["systemctl", "--user", "show-environment"])


def write_systemd_unit(config: CLIConfig, paths: CLIPaths, *, force: bool = False) -> Path:
    if paths.unit_path.exists():
        existing = paths.unit_path.read_text(encoding="utf-8")
        if MANAGED_UNIT_HEADER not in existing and not force:
            raise RuntimeError(
                f"Refusing to overwrite unmanaged unit file at {paths.unit_path}. Re-run with --force if you want SaveMyContext to replace it."
            )

    paths.unit_path.parent.mkdir(parents=True, exist_ok=True)
    paths.unit_path.write_text(render_systemd_unit(config, paths), encoding="utf-8")
    return paths.unit_path


def daemon_reload() -> None:
    run_command(["systemctl", "--user", "daemon-reload"])


def service_control(action: str, service_name: str) -> None:
    run_command(["systemctl", "--user", action, f"{service_name}.service"])


def maybe_warn_about_linger() -> str | None:
    loginctl = shutil.which("loginctl")
    if not loginctl:
        return None

    try:
        result = run_command(
            ["loginctl", "show-user", str(Path.home().owner()), "--property=Linger", "--value"],
            capture_output=True,
        )
    except (RuntimeError, KeyError):  # pragma: no cover - platform specific
        return None

    if result.stdout.strip().lower() == "yes":
        return None

    username = Path.home().owner()
    return (
        "SaveMyContext will start when your user session starts.\n"
        f"To keep it running at boot without login, enable lingering:\n  sudo loginctl enable-linger {username}"
    )


def health_url(config: CLIConfig) -> str:
    host = "127.0.0.1" if config.host in {"0.0.0.0", "::"} else config.host
    return f"http://{host}:{config.port}/api/v1/health"


def fetch_health(config: CLIConfig, *, timeout_seconds: float = 2.0) -> tuple[bool, int | None, str | None]:
    try:
        with urllib.request.urlopen(health_url(config), timeout=timeout_seconds) as response:
            return 200 <= response.status < 300, response.status, None
    except urllib.error.HTTPError as error:
        return False, error.code, str(error)
    except OSError as error:
        return False, None, str(error)


def get_service_status(config: CLIConfig, service_name: str) -> ServiceStatus:
    try:
        active_result = run_command(
            ["systemctl", "--user", "is-active", f"{service_name}.service"],
            check=False,
        )
        enabled_result = run_command(
            ["systemctl", "--user", "is-enabled", f"{service_name}.service"],
            check=False,
        )
    except RuntimeError:
        active_result = subprocess.CompletedProcess([], 1, "", "")
        enabled_result = subprocess.CompletedProcess([], 1, "", "")

    active = active_result.stdout.strip() == "active"
    enabled = enabled_result.stdout.strip() == "enabled"
    health_ok, health_status_code, health_error = fetch_health(config)
    return ServiceStatus(
        active=active,
        enabled=enabled,
        systemd_state=active_result.stdout.strip() or "unknown",
        health_ok=health_ok,
        health_status_code=health_status_code,
        health_error=health_error,
    )


def stream_service_logs(service_name: str, *, follow: bool = False, lines: int = 100, since: str | None = None) -> int:
    command = ["journalctl", "--user", "-u", f"{service_name}.service", "-n", str(lines)]
    if follow:
        command.append("-f")
    if since:
        command.extend(["--since", since])
    result = subprocess.run(command, text=True)
    return result.returncode


def port_is_open(host: str, port: int) -> bool:
    candidate_host = "127.0.0.1" if host in {"0.0.0.0", "::"} else host
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex((candidate_host, port)) == 0
