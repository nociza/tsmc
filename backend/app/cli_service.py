from __future__ import annotations

import json
import os
import plistlib
import shlex
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
from app.cli_paths import CLIPaths, host_platform


MANAGED_UNIT_HEADER = "# Managed by SaveMyContext. Manual edits may be overwritten.\n"
MANAGED_PLIST_KEY = "SaveMyContextManaged"
CLI_CONFIG_PATH_ENV = "SAVEMYCONTEXT_CLI_CONFIG_PATH"


@dataclass(frozen=True)
class ServiceStatus:
    active: bool
    enabled: bool
    manager_name: str
    manager_state: str
    health_ok: bool
    health_status_code: int | None
    health_error: str | None


def current_service_manager(system_name: str | None = None) -> str:
    platform_name = host_platform(system_name)
    if platform_name == "linux":
        return "systemd"
    if platform_name == "macos":
        return "launchd"
    return "unsupported"


def service_manager_display_name(system_name: str | None = None) -> str:
    manager = current_service_manager(system_name)
    if manager == "systemd":
        return "systemd"
    if manager == "launchd":
        return "launchd"
    return "unsupported"


def savemycontext_executable_path() -> Path:
    executable = shutil.which("savemycontext")
    if executable:
        return Path(executable).resolve()
    return Path(sys.argv[0]).resolve()


def service_stdout_log_path(config: CLIConfig) -> Path:
    return config.data_dir / "logs" / "service.stdout.log"


def service_stderr_log_path(config: CLIConfig) -> Path:
    return config.data_dir / "logs" / "service.stderr.log"


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


def render_launchd_plist(config: CLIConfig, paths: CLIPaths) -> bytes:
    command = (
        f". {shlex.quote(str(paths.env_path))} && "
        f"exec {shlex.quote(str(savemycontext_executable_path()))} run --config {shlex.quote(str(paths.config_path))}"
    )
    payload = {
        "Label": launchd_label(config),
        "ProgramArguments": ["/bin/sh", "-lc", command],
        "WorkingDirectory": str(config.data_dir),
        "EnvironmentVariables": {
            CLI_CONFIG_PATH_ENV: str(paths.config_path),
        },
        "RunAtLoad": True,
        "KeepAlive": True,
        "ProcessType": "Background",
        "StandardOutPath": str(service_stdout_log_path(config)),
        "StandardErrorPath": str(service_stderr_log_path(config)),
        MANAGED_PLIST_KEY: True,
    }
    return plistlib.dumps(payload, sort_keys=True)


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


def ensure_service_manager_available() -> str:
    manager = current_service_manager()
    if manager == "systemd":
        run_command(["systemctl", "--user", "show-environment"])
        return manager
    if manager == "launchd":
        if not shutil.which("launchctl"):
            raise RuntimeError("launchctl is not available.")
        return manager
    raise RuntimeError("Background service management is not supported on this operating system. Use `savemycontext run` instead.")


def is_managed_service_definition(path: Path) -> bool:
    if not path.exists():
        return False
    if path.suffix == ".plist":
        try:
            payload = plistlib.loads(path.read_bytes())
        except Exception:
            return False
        return bool(payload.get(MANAGED_PLIST_KEY))
    return MANAGED_UNIT_HEADER in path.read_text(encoding="utf-8")


def write_service_definition(config: CLIConfig, paths: CLIPaths, *, force: bool = False) -> Path:
    destination = paths.service_definition_path
    if destination.exists() and not is_managed_service_definition(destination) and not force:
        raise RuntimeError(
            f"Refusing to overwrite unmanaged service definition at {destination}. Re-run with --force if you want SaveMyContext to replace it."
        )

    destination.parent.mkdir(parents=True, exist_ok=True)
    service_stdout_log_path(config).parent.mkdir(parents=True, exist_ok=True)

    manager = current_service_manager()
    if manager == "systemd":
        destination.write_text(render_systemd_unit(config, paths), encoding="utf-8")
        return destination
    if manager == "launchd":
        destination.write_bytes(render_launchd_plist(config, paths))
        return destination
    raise RuntimeError("Background service management is not supported on this operating system. Use `savemycontext run` instead.")


def reload_service_manager() -> None:
    manager = current_service_manager()
    if manager == "systemd":
        run_command(["systemctl", "--user", "daemon-reload"])
        return
    if manager == "launchd":
        return
    raise RuntimeError("Background service management is not supported on this operating system.")


def maybe_warn_about_service_manager() -> str | None:
    if current_service_manager() != "systemd":
        return None

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
            payload = json.loads(response.read().decode("utf-8"))
            if not isinstance(payload, dict):
                return False, response.status, "unexpected health payload"
            if payload.get("status") != "ok":
                return False, response.status, "health endpoint did not report ok"
            if "version" not in payload or "app" not in payload:
                return False, response.status, "health payload does not look like SaveMyContext"
            return True, response.status, None
    except urllib.error.HTTPError as error:
        return False, error.code, str(error)
    except json.JSONDecodeError:
        return False, None, "health endpoint returned invalid JSON"
    except OSError as error:
        return False, None, str(error)


def launchd_label(config: CLIConfig) -> str:
    return config.service_name


def launchd_domain() -> str:
    return f"gui/{os.getuid()}"


def launchd_target(config: CLIConfig) -> str:
    return f"{launchd_domain()}/{launchd_label(config)}"


def launchd_is_loaded(config: CLIConfig) -> tuple[bool, str]:
    result = run_command(
        ["launchctl", "print", launchd_target(config)],
        check=False,
    )
    if result.returncode != 0:
        return False, "unloaded"

    state = "loaded"
    for line in result.stdout.splitlines():
        candidate = line.strip()
        if candidate.startswith("state ="):
            state = candidate.split("=", 1)[1].strip()
            break
    return True, state


def bootstrap_launchd_service(config: CLIConfig, paths: CLIPaths) -> None:
    if not paths.service_definition_path.exists():
        raise RuntimeError(f"LaunchAgent file does not exist: {paths.service_definition_path}")

    loaded, _state = launchd_is_loaded(config)
    if loaded:
        run_command(["launchctl", "bootout", launchd_target(config)], check=False)
    run_command(["launchctl", "bootstrap", launchd_domain(), str(paths.service_definition_path)])


def bootout_launchd_service(config: CLIConfig) -> None:
    loaded, _state = launchd_is_loaded(config)
    if loaded:
        run_command(["launchctl", "bootout", launchd_target(config)])


def service_control(action: str, config: CLIConfig, paths: CLIPaths) -> None:
    manager = current_service_manager()
    if manager == "systemd":
        run_command(["systemctl", "--user", action, f"{config.service_name}.service"])
        return
    if manager != "launchd":
        raise RuntimeError("Background service management is not supported on this operating system.")

    if action in {"start", "restart"}:
        bootstrap_launchd_service(config, paths)
        run_command(["launchctl", "kickstart", "-k", launchd_target(config)])
        return
    if action == "enable":
        bootstrap_launchd_service(config, paths)
        return
    if action in {"stop", "disable"}:
        bootout_launchd_service(config)
        return
    raise RuntimeError(f"Unsupported service action: {action}")


def get_service_status(config: CLIConfig, paths: CLIPaths) -> ServiceStatus:
    manager = current_service_manager()
    if manager == "systemd":
        try:
            active_result = run_command(
                ["systemctl", "--user", "is-active", f"{config.service_name}.service"],
                check=False,
            )
            enabled_result = run_command(
                ["systemctl", "--user", "is-enabled", f"{config.service_name}.service"],
                check=False,
            )
        except RuntimeError:
            active_result = subprocess.CompletedProcess([], 1, "", "")
            enabled_result = subprocess.CompletedProcess([], 1, "", "")

        active = active_result.stdout.strip() == "active"
        enabled = enabled_result.stdout.strip() == "enabled"
        manager_state = active_result.stdout.strip() or "unknown"
    elif manager == "launchd":
        try:
            active, manager_state = launchd_is_loaded(config)
        except RuntimeError:
            active, manager_state = False, "unknown"
        enabled = paths.service_definition_path.exists()
    else:
        active = False
        enabled = False
        manager_state = "unsupported"

    health_ok, health_status_code, health_error = fetch_health(config)
    return ServiceStatus(
        active=active,
        enabled=enabled,
        manager_name=service_manager_display_name(),
        manager_state=manager_state,
        health_ok=health_ok,
        health_status_code=health_status_code,
        health_error=health_error,
    )


def stream_service_logs(config: CLIConfig, *, follow: bool = False, lines: int = 100, since: str | None = None) -> int:
    manager = current_service_manager()
    if manager == "systemd":
        command = ["journalctl", "--user", "-u", f"{config.service_name}.service", "-n", str(lines)]
        if follow:
            command.append("-f")
        if since:
            command.extend(["--since", since])
        result = subprocess.run(command, text=True)
        return result.returncode
    if manager == "launchd":
        stdout_path = service_stdout_log_path(config)
        stderr_path = service_stderr_log_path(config)
        command = ["tail", "-n", str(lines)]
        if follow:
            command.append("-f")
        command.extend([str(stdout_path), str(stderr_path)])
        result = subprocess.run(command, text=True)
        return result.returncode
    raise RuntimeError("Background service log streaming is not supported on this operating system.")


def port_is_open(host: str, port: int) -> bool:
    candidate_host = "127.0.0.1" if host in {"0.0.0.0", "::"} else host
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex((candidate_host, port)) == 0
