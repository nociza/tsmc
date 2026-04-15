from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import os
import shutil
import sys
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.cli_config import (
    CLIConfig,
    apply_runtime_environment,
    ensure_cli_directories,
    ensure_env_file,
    load_cli_config,
    merge_cli_config,
    save_cli_config,
)
from app.cli_paths import CLIPaths, default_cli_paths
from app.cli_service import (
    daemon_reload,
    ensure_systemd_user_available,
    get_service_status,
    maybe_warn_about_linger,
    port_is_open,
    service_control,
    stream_service_logs,
    write_systemd_unit,
)
from app.models import APIToken, ProviderName, User
from app.models.base import Base
from app.services.auth import create_api_token, ensure_admin_user, revoke_api_token


PACKAGE_NAME = "savemycontext"
CLI_CONFIG_PATH_ENV = "SAVEMYCONTEXT_CLI_CONFIG_PATH"


def package_version() -> str:
    try:
        return version(PACKAGE_NAME)
    except PackageNotFoundError:
        return "0.0.0"


def resolve_cli_paths(config_path: Path | None = None) -> CLIPaths:
    defaults = default_cli_paths()
    if config_path is None:
        return defaults

    resolved_config_path = config_path.expanduser().resolve()
    return CLIPaths(
        config_dir=resolved_config_path.parent,
        config_path=resolved_config_path,
        env_path=resolved_config_path.parent / "savemycontext.env",
        data_dir=defaults.data_dir,
        markdown_dir=defaults.markdown_dir,
        database_path=defaults.database_path,
        systemd_user_dir=defaults.systemd_user_dir,
        unit_path=defaults.unit_path,
    )


def load_effective_config(args: argparse.Namespace) -> tuple[CLIPaths, CLIConfig]:
    paths = resolve_cli_paths(getattr(args, "config", None))
    loaded = load_cli_config(paths.config_path, paths=paths)
    merged = merge_cli_config(
        loaded,
        host=getattr(args, "host", None),
        port=getattr(args, "port", None),
        data_dir=getattr(args, "data_dir", None),
        markdown_dir=getattr(args, "markdown_dir", None),
        llm_backend=getattr(args, "llm_backend", None),
        browser_llm_model=getattr(args, "browser_llm_model", None),
        browser_llm_state_path=getattr(args, "browser_llm_state_path", None),
        public_url=getattr(args, "public_url", None),
        browser_profile_dir=getattr(args, "browser_profile_dir", None),
        browser_headless=getattr(args, "browser_headless", None),
        browser_channel=getattr(args, "browser_channel", None),
        browser_executable_path=getattr(args, "browser_executable_path", None),
        browser_timeout_seconds=getattr(args, "browser_timeout_seconds", None),
    )
    return paths, merged


def print_kv(label: str, value: object) -> None:
    print(f"{label}: {value}")


def print_json(payload: object) -> None:
    print(json.dumps(payload, indent=2))


async def open_cli_session(config: CLIConfig, paths: CLIPaths):
    os.environ[CLI_CONFIG_PATH_ENV] = str(paths.config_path)
    ensure_cli_directories(config, paths)
    ensure_env_file(paths.env_path)
    apply_runtime_environment(config, paths.env_path)
    engine = create_async_engine(config.database_url)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    return engine, session_factory


def command_run(args: argparse.Namespace) -> int:
    paths, config = load_effective_config(args)
    os.environ[CLI_CONFIG_PATH_ENV] = str(paths.config_path)
    ensure_cli_directories(config, paths)
    ensure_env_file(paths.env_path)
    apply_runtime_environment(config, paths.env_path)

    import uvicorn

    host = args.host or config.host
    port = args.port or config.port
    uvicorn.run("app.main:app", host=host, port=port, reload=False)
    return 0


def command_service_install(args: argparse.Namespace) -> int:
    ensure_systemd_user_available()
    paths, config = load_effective_config(args)
    effective_config = merge_cli_config(
        config,
        data_dir=args.data_dir or config.data_dir,
        markdown_dir=args.markdown_dir or config.markdown_dir,
        browser_profile_dir=args.browser_profile_dir or config.browser_profile_dir,
        browser_headless=args.browser_headless if args.browser_headless is not None else config.browser_headless,
        browser_channel=args.browser_channel if args.browser_channel is not None else config.browser_channel,
        browser_executable_path=(
            args.browser_executable_path if args.browser_executable_path is not None else config.browser_executable_path
        ),
        browser_timeout_seconds=(
            args.browser_timeout_seconds if args.browser_timeout_seconds is not None else config.browser_timeout_seconds
        ),
    )

    ensure_cli_directories(effective_config, paths)
    save_cli_config(effective_config, paths.config_path)
    ensure_env_file(paths.env_path, force=args.force)
    write_systemd_unit(effective_config, paths, force=args.force)
    daemon_reload()

    if args.enable or args.start:
        service_control("enable", effective_config.service_name)
    if args.start:
        service_control("start", effective_config.service_name)

    print("SaveMyContext service installed.")
    print_kv("Service", f"{effective_config.service_name}.service")
    print_kv("URL", f"http://{effective_config.host}:{effective_config.port}")
    print_kv("Config", paths.config_path)
    print_kv("Env", paths.env_path)
    print_kv("Data", effective_config.data_dir)
    print_kv("Markdown", effective_config.markdown_dir)
    print_kv("Database", effective_config.database_path)
    print_kv("Browser Profile", effective_config.browser_profile_dir)
    print_kv("Browser LLM Model", effective_config.browser_llm_model)
    print_kv("Browser LLM State", effective_config.browser_llm_state_path)
    linger_warning = maybe_warn_about_linger()
    if linger_warning:
        print()
        print(linger_warning)
    return 0


def command_service_control(args: argparse.Namespace) -> int:
    paths = resolve_cli_paths(getattr(args, "config", None))
    config = load_cli_config(paths.config_path, paths=paths)
    ensure_systemd_user_available()
    service_control(args.action, config.service_name)
    past_tense = {
        "start": "Started",
        "stop": "Stopped",
        "restart": "Restarted",
    }[args.action]
    print(f"{past_tense} {config.service_name}.service")
    return 0


def command_service_status(args: argparse.Namespace) -> int:
    paths = resolve_cli_paths(getattr(args, "config", None))
    config = load_cli_config(paths.config_path, paths=paths)
    status = get_service_status(config, config.service_name)
    print_kv("Service", f"{config.service_name}.service")
    print_kv("Systemd", status.systemd_state)
    print_kv("Enabled", "yes" if status.enabled else "no")
    print_kv("Health", "ok" if status.health_ok else f"failed ({status.health_status_code or status.health_error or 'unreachable'})")
    print_kv("Config", paths.config_path)
    print_kv("Env", paths.env_path)
    print_kv("Data", config.data_dir)
    print_kv("Markdown", config.markdown_dir)
    print_kv("Database", config.database_path)
    print_kv("Browser Profile", config.browser_profile_dir)
    print_kv("Browser LLM Model", config.browser_llm_model)
    print_kv("Browser LLM State", config.browser_llm_state_path)
    return 0 if status.active else 1


def command_service_logs(args: argparse.Namespace) -> int:
    paths = resolve_cli_paths(getattr(args, "config", None))
    config = load_cli_config(paths.config_path, paths=paths)
    return stream_service_logs(config.service_name, follow=args.follow, lines=args.lines, since=args.since)


def command_service_uninstall(args: argparse.Namespace) -> int:
    paths = resolve_cli_paths(getattr(args, "config", None))
    config = load_cli_config(paths.config_path, paths=paths)
    try:
        ensure_systemd_user_available()
        service_control("stop", config.service_name)
    except RuntimeError:
        pass
    try:
        service_control("disable", config.service_name)
    except RuntimeError:
        pass

    if paths.unit_path.exists():
        paths.unit_path.unlink()
        try:
            daemon_reload()
        except RuntimeError:
            pass

    if args.purge_data:
        if paths.config_dir.exists():
            shutil.rmtree(paths.config_dir)
        if config.data_dir.exists():
            shutil.rmtree(config.data_dir)
        print("Removed SaveMyContext service, config, and data.")
        return 0

    print("Removed SaveMyContext service. Config and data were kept.")
    print_kv("Config", paths.config_dir)
    print_kv("Data", config.data_dir)
    return 0


def command_doctor(args: argparse.Namespace) -> int:
    paths = resolve_cli_paths(getattr(args, "config", None))
    config = load_cli_config(paths.config_path, paths=paths)
    status = get_service_status(config, config.service_name)
    problems: list[str] = []

    if not shutil.which("systemctl"):
        problems.append("systemctl is not available.")
    if not shutil.which("git"):
        problems.append("git is not available, so vault and to-do versioning will be disabled.")
    if not paths.config_path.exists():
        problems.append(f"Config file is missing: {paths.config_path}")
    if not paths.env_path.exists():
        problems.append(f"Env file is missing: {paths.env_path}")
    if not config.data_dir.exists():
        problems.append(f"Data directory is missing: {config.data_dir}")
    if not config.markdown_dir.exists():
        problems.append(f"Markdown directory is missing: {config.markdown_dir}")
    if not status.active and port_is_open(config.host, config.port):
        problems.append(f"Port {config.port} is already open but {config.service_name}.service is not active.")

    print_kv("Service", f"{config.service_name}.service")
    print_kv("Health", "ok" if status.health_ok else f"failed ({status.health_status_code or status.health_error or 'unreachable'})")
    print_kv("Config", paths.config_path)
    print_kv("Markdown", config.markdown_dir)
    print_kv("Database", config.database_path)
    print_kv("Browser Profile", config.browser_profile_dir)

    if problems:
        print()
        print("Problems:")
        for problem in problems:
            print(f"- {problem}")
        return 1

    print()
    print("No obvious problems found.")
    return 0


def command_config_show(args: argparse.Namespace) -> int:
    paths = resolve_cli_paths(getattr(args, "config", None))
    config = load_cli_config(paths.config_path, paths=paths)
    payload = {
        "server": {
            "host": config.host,
            "port": config.port,
            "public_url": config.public_url,
        },
        "storage": {
            "data_dir": str(config.data_dir),
            "markdown_dir": str(config.markdown_dir),
            "database_path": str(config.database_path),
        },
        "processing": {
            "llm_backend": config.llm_backend,
            "browser_llm_model": config.browser_llm_model,
            "browser_llm_state_path": str(config.browser_llm_state_path),
        },
        "browser": {
            "profile_dir": str(config.browser_profile_dir),
            "headless": config.browser_headless,
            "channel": config.browser_channel,
            "executable_path": config.browser_executable_path,
            "timeout_seconds": config.browser_timeout_seconds,
        },
        "service": {
            "name": config.service_name,
        },
    }
    print(json.dumps(payload, indent=2))
    return 0


def command_config_path(args: argparse.Namespace) -> int:
    paths = resolve_cli_paths(getattr(args, "config", None))
    config = load_cli_config(paths.config_path, paths=paths)
    print_kv("Config", paths.config_path)
    print_kv("Env", paths.env_path)
    print_kv("Unit", paths.unit_path)
    print_kv("Data", config.data_dir)
    print_kv("Markdown", config.markdown_dir)
    print_kv("Database", config.database_path)
    print_kv("Browser Profile", config.browser_profile_dir)
    print_kv("Browser LLM Model", config.browser_llm_model)
    print_kv("Browser LLM State", config.browser_llm_state_path)
    return 0


def command_browser_install(_args: argparse.Namespace) -> int:
    print("Experimental browser automation is disabled by default.")
    print("Use an OpenAI-compatible API key and model for backend processing instead.")
    return 1


def command_browser_login(args: argparse.Namespace) -> int:
    provider = ProviderName(args.provider)
    payload = {
        "provider": provider.value,
        "status": "disabled",
        "message": (
            "Experimental browser automation is disabled by default. "
            "Configure an OpenAI-compatible API key for backend processing instead."
        ),
    }
    if args.json:
        print_json(payload)
    else:
        print(payload["message"])
    return 1


def _prompt_password(password: str | None) -> str:
    if password:
        return password
    first = getpass.getpass("Password: ")
    second = getpass.getpass("Confirm password: ")
    if first != second:
        raise RuntimeError("Passwords did not match.")
    if len(first) < 12:
        raise RuntimeError("Password must be at least 12 characters.")
    return first


def command_init_admin(args: argparse.Namespace) -> int:
    paths, config = load_effective_config(args)
    password = _prompt_password(args.password)

    async def run() -> dict[str, object]:
        engine, session_factory = await open_cli_session(config, paths)
        try:
            async with session_factory() as session:
                user = await ensure_admin_user(
                    session,
                    username=args.username,
                    password=password,
                    force=args.force,
                )
                return {
                    "id": user.id,
                    "username": user.username,
                    "is_admin": user.is_admin,
                }
        finally:
            await engine.dispose()

    payload = asyncio.run(run())
    if args.json:
        print_json(payload)
    else:
        print("Admin user initialized.")
        print_kv("Username", payload["username"])
        print_kv("User ID", payload["id"])
    return 0


def command_token_create(args: argparse.Namespace) -> int:
    paths, config = load_effective_config(args)
    scopes = sorted(set(args.scope or ["ingest", "read"]))

    async def run() -> dict[str, object]:
        engine, session_factory = await open_cli_session(config, paths)
        try:
            async with session_factory() as session:
                created = await create_api_token(
                    session,
                    username=args.username,
                    name=args.name,
                    scopes=scopes,
                )
                return {
                    "id": created.token.id,
                    "name": created.token.name,
                    "token": created.plain_text,
                    "token_prefix": created.token.token_prefix,
                    "scopes": created.token.scopes,
                }
        finally:
            await engine.dispose()

    payload = asyncio.run(run())
    if args.json:
        print_json(payload)
    else:
        print("Created API token.")
        print_kv("Token ID", payload["id"])
        print_kv("Name", payload["name"])
        print_kv("Scopes", ", ".join(payload["scopes"]))
        print()
        print(payload["token"])
    return 0


def command_token_list(args: argparse.Namespace) -> int:
    paths, config = load_effective_config(args)

    async def run() -> list[dict[str, object]]:
        engine, session_factory = await open_cli_session(config, paths)
        try:
            async with session_factory() as session:
                result = await session.execute(select(APIToken).order_by(APIToken.created_at.desc()))
                rows = result.scalars().all()
                return [
                    {
                        "id": token.id,
                        "name": token.name,
                        "token_prefix": token.token_prefix,
                        "scopes": token.scopes,
                        "is_active": token.is_active,
                        "revoked_at": token.revoked_at.isoformat() if token.revoked_at else None,
                    }
                    for token in rows
                ]
        finally:
            await engine.dispose()

    payload = asyncio.run(run())
    if args.json:
        print_json(payload)
        return 0

    if not payload:
        print("No API tokens found.")
        return 0

    for token in payload:
        print(f"{token['id']}  {token['name']}  scopes={','.join(token['scopes'])}  active={token['is_active']}")
    return 0


def command_token_revoke(args: argparse.Namespace) -> int:
    paths, config = load_effective_config(args)

    async def run() -> dict[str, object]:
        engine, session_factory = await open_cli_session(config, paths)
        try:
            async with session_factory() as session:
                token = await revoke_api_token(session, token_id=args.token_id)
                return {
                    "id": token.id,
                    "name": token.name,
                    "is_active": token.is_active,
                    "revoked_at": token.revoked_at.isoformat() if token.revoked_at else None,
                }
        finally:
            await engine.dispose()

    payload = asyncio.run(run())
    if args.json:
        print_json(payload)
    else:
        print(f"Revoked token {payload['id']}.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="savemycontext", description="SaveMyContext backend service manager")
    parser.add_argument("--config", type=Path, help="Path to the SaveMyContext config.toml file.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    run_parser = subparsers.add_parser("run", help="Run the SaveMyContext backend in the foreground.")
    run_parser.add_argument("--host")
    run_parser.add_argument("--port", type=int)
    run_parser.add_argument("--data-dir", type=Path)
    run_parser.add_argument("--markdown-dir", type=Path)
    run_parser.add_argument("--llm-backend")
    run_parser.add_argument("--browser-llm-model")
    run_parser.add_argument("--browser-llm-state-path", type=Path)
    run_parser.add_argument("--browser-profile-dir", type=Path)
    run_parser.add_argument("--browser-channel")
    run_parser.add_argument("--browser-executable-path")
    run_parser.add_argument("--browser-timeout-seconds", type=float)
    run_headless_group = run_parser.add_mutually_exclusive_group()
    run_headless_group.add_argument("--browser-headless", dest="browser_headless", action="store_true")
    run_headless_group.add_argument("--browser-headed", dest="browser_headless", action="store_false")
    run_parser.set_defaults(browser_headless=None)
    run_parser.set_defaults(func=command_run)

    service_parser = subparsers.add_parser("service", help="Manage the SaveMyContext background service.")
    service_subparsers = service_parser.add_subparsers(dest="service_command", required=True)

    install_parser = service_subparsers.add_parser("install", help="Install the SaveMyContext systemd user service.")
    install_parser.add_argument("--start", action="store_true")
    install_parser.add_argument("--enable", action="store_true")
    install_parser.add_argument("--host")
    install_parser.add_argument("--port", type=int)
    install_parser.add_argument("--data-dir", type=Path)
    install_parser.add_argument("--markdown-dir", type=Path)
    install_parser.add_argument("--llm-backend")
    install_parser.add_argument("--browser-llm-model")
    install_parser.add_argument("--browser-llm-state-path", type=Path)
    install_parser.add_argument("--public-url")
    install_parser.add_argument("--browser-profile-dir", type=Path)
    install_parser.add_argument("--browser-channel")
    install_parser.add_argument("--browser-executable-path")
    install_parser.add_argument("--browser-timeout-seconds", type=float)
    install_headless_group = install_parser.add_mutually_exclusive_group()
    install_headless_group.add_argument("--browser-headless", dest="browser_headless", action="store_true")
    install_headless_group.add_argument("--browser-headed", dest="browser_headless", action="store_false")
    install_parser.set_defaults(browser_headless=None)
    install_parser.add_argument("--force", action="store_true")
    install_parser.set_defaults(func=command_service_install)

    for action in ["start", "stop", "restart"]:
        action_parser = service_subparsers.add_parser(action, help=f"{action.title()} the SaveMyContext service.")
        action_parser.set_defaults(func=command_service_control, action=action)

    status_parser = service_subparsers.add_parser("status", help="Show SaveMyContext service status.")
    status_parser.set_defaults(func=command_service_status)

    logs_parser = service_subparsers.add_parser("logs", help="Show SaveMyContext service logs.")
    logs_parser.add_argument("-f", "--follow", action="store_true")
    logs_parser.add_argument("-n", "--lines", type=int, default=100)
    logs_parser.add_argument("--since")
    logs_parser.set_defaults(func=command_service_logs)

    uninstall_parser = service_subparsers.add_parser("uninstall", help="Uninstall the SaveMyContext service.")
    uninstall_parser.add_argument("--purge-data", action="store_true")
    uninstall_parser.set_defaults(func=command_service_uninstall)

    doctor_parser = subparsers.add_parser("doctor", help="Run basic health checks.")
    doctor_parser.set_defaults(func=command_doctor)

    init_admin_parser = subparsers.add_parser("init-admin", help="Create the first SaveMyContext admin user.")
    init_admin_parser.add_argument("--username", default="admin")
    init_admin_parser.add_argument("--password")
    init_admin_parser.add_argument("--force", action="store_true")
    init_admin_parser.add_argument("--json", action="store_true")
    init_admin_parser.set_defaults(func=command_init_admin)

    token_parser = subparsers.add_parser("token", help="Manage SaveMyContext API tokens.")
    token_subparsers = token_parser.add_subparsers(dest="token_command", required=True)

    token_create_parser = token_subparsers.add_parser("create", help="Create an API token.")
    token_create_parser.add_argument("--username", default="admin")
    token_create_parser.add_argument("--name", required=True)
    token_create_parser.add_argument("--scope", action="append")
    token_create_parser.add_argument("--json", action="store_true")
    token_create_parser.set_defaults(func=command_token_create)

    token_list_parser = token_subparsers.add_parser("list", help="List API tokens.")
    token_list_parser.add_argument("--json", action="store_true")
    token_list_parser.set_defaults(func=command_token_list)

    token_revoke_parser = token_subparsers.add_parser("revoke", help="Revoke an API token.")
    token_revoke_parser.add_argument("token_id")
    token_revoke_parser.add_argument("--json", action="store_true")
    token_revoke_parser.set_defaults(func=command_token_revoke)

    browser_parser = subparsers.add_parser("browser", help="Deprecated browser automation commands.")
    browser_subparsers = browser_parser.add_subparsers(dest="browser_command", required=True)
    browser_install_parser = browser_subparsers.add_parser("install", help="Deprecated. Use the Chrome extension instead.")
    browser_install_parser.set_defaults(func=command_browser_install)
    browser_login_parser = browser_subparsers.add_parser("login", help="Deprecated. Sign into the provider in your normal browser.")
    browser_login_parser.add_argument("--provider", choices=[provider.value for provider in ProviderName], required=True)
    browser_login_parser.add_argument("--json", action="store_true")
    browser_login_parser.set_defaults(func=command_browser_login)

    config_parser = subparsers.add_parser("config", help="Inspect SaveMyContext configuration.")
    config_subparsers = config_parser.add_subparsers(dest="config_command", required=True)
    config_show_parser = config_subparsers.add_parser("show", help="Show effective config.")
    config_show_parser.set_defaults(func=command_config_show)
    config_path_parser = config_subparsers.add_parser("path", help="Show important config and data paths.")
    config_path_parser.set_defaults(func=command_config_path)

    version_parser = subparsers.add_parser("version", help="Show the installed SaveMyContext version.")
    version_parser.set_defaults(func=lambda _args: print(package_version()) or 0)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
