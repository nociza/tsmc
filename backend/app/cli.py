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
    load_env_file,
    load_cli_config,
    merge_cli_config,
    save_cli_config,
    update_env_file,
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
from app.models import APIToken, ProviderName
from app.models.base import Base
from app.services.auth import create_api_token, ensure_admin_user, revoke_api_token


PACKAGE_NAME = "savemycontext"
CLI_CONFIG_PATH_ENV = "SAVEMYCONTEXT_CLI_CONFIG_PATH"


class HelpParser(argparse.ArgumentParser):
    def __init__(self, *args, **kwargs) -> None:
        kwargs.setdefault("formatter_class", argparse.ArgumentDefaultsHelpFormatter)
        super().__init__(*args, **kwargs)


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


def collect_env_updates(args: argparse.Namespace) -> dict[str, str]:
    updates: dict[str, str] = {}
    optional_values = {
        "SAVEMYCONTEXT_OPENAI_API_KEY": getattr(args, "openai_api_key", None),
        "SAVEMYCONTEXT_OPENAI_BASE_URL": getattr(args, "openai_base_url", None),
        "SAVEMYCONTEXT_OPENAI_MODEL": getattr(args, "openai_model", None),
        "SAVEMYCONTEXT_OPENAI_APP_NAME": getattr(args, "openai_app_name", None),
        "SAVEMYCONTEXT_OPENAI_SITE_URL": getattr(args, "openai_site_url", None),
        "SAVEMYCONTEXT_GOOGLE_API_KEY": getattr(args, "google_api_key", None),
        "SAVEMYCONTEXT_CORS_ORIGIN_REGEX": getattr(args, "cors_origin_regex", None),
    }
    for key, raw_value in optional_values.items():
        if raw_value is not None:
            updates[key] = raw_value

    git_versioning_enabled = getattr(args, "git_versioning_enabled", None)
    if git_versioning_enabled is not None:
        updates["SAVEMYCONTEXT_GIT_VERSIONING_ENABLED"] = "true" if git_versioning_enabled else "false"

    return updates


def persist_cli_runtime(
    config: CLIConfig,
    paths: CLIPaths,
    *,
    force_env_defaults: bool = False,
    env_updates: dict[str, str] | None = None,
) -> None:
    ensure_cli_directories(config, paths)
    save_cli_config(config, paths.config_path)
    ensure_env_file(paths.env_path, force=force_env_defaults)
    if env_updates:
        update_env_file(paths.env_path, env_updates)


async def initialize_cli_runtime(config: CLIConfig, paths: CLIPaths) -> None:
    engine, _session_factory = await open_cli_session(config, paths)
    await engine.dispose()


def print_runtime_summary(config: CLIConfig, paths: CLIPaths) -> None:
    print_kv("URL", f"http://{config.host}:{config.port}")
    print_kv("Config", paths.config_path)
    print_kv("Env", paths.env_path)
    print_kv("Data", config.data_dir)
    print_kv("Markdown", config.markdown_dir)
    print_kv("Database", config.database_path)
    print_kv("Browser Profile", config.browser_profile_dir)
    print_kv("Browser LLM Model", config.browser_llm_model)
    print_kv("Browser LLM State", config.browser_llm_state_path)


def print_config_next_steps(*, include_service: bool) -> None:
    print()
    print("Next:")
    print("- Edit or update API settings with `savemycontext config set ...` or by editing the env file.")
    if include_service:
        print("- Check the service with `savemycontext service status`.")
        print("- Follow logs with `savemycontext service logs -f`.")
    else:
        print("- Start the backend in the foreground with `savemycontext run`.")
        print("- Or install the background service with `savemycontext service install --start`.")


def format_health(status_ok: bool, status_code: int | None, error: str | None) -> str:
    if status_ok:
        return "ok"
    return f"failed ({status_code or error or 'unreachable'})"


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
    env_updates = collect_env_updates(args)
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

    persist_cli_runtime(
        effective_config,
        paths,
        force_env_defaults=args.force,
        env_updates=env_updates,
    )
    write_systemd_unit(effective_config, paths, force=args.force)
    daemon_reload()

    if args.enable or args.start:
        service_control("enable", effective_config.service_name)
    if args.start:
        service_control("start", effective_config.service_name)

    print("SaveMyContext service installed.")
    print_kv("Service", f"{effective_config.service_name}.service")
    print_runtime_summary(effective_config, paths)
    linger_warning = maybe_warn_about_linger()
    if linger_warning:
        print()
        print(linger_warning)
    print_config_next_steps(include_service=True)
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
    print_kv("Health", format_health(status.health_ok, status.health_status_code, status.health_error))
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
    if not status.active and port_is_open(config.host, config.port) and not status.health_ok:
        problems.append(f"Port {config.port} is already open but {config.service_name}.service is not active.")

    print_kv("Service", f"{config.service_name}.service")
    print_kv("Health", format_health(status.health_ok, status.health_status_code, status.health_error))
    print_kv("Config", paths.config_path)
    print_kv("Env", paths.env_path)
    print_kv("Markdown", config.markdown_dir)
    print_kv("Database", config.database_path)
    print_kv("Browser Profile", config.browser_profile_dir)

    if problems:
        print()
        print("Problems:")
        for problem in problems:
            print(f"- {problem}")
        print()
        print("Suggested next steps:")
        if not paths.config_path.exists() or not paths.env_path.exists():
            print("- Run `savemycontext config init` to create the config, env file, and local data directories.")
        if shutil.which("systemctl"):
            print("- Run `savemycontext service install --start` to install the background service.")
        else:
            print("- Run `savemycontext run` if you want to start the backend in the foreground on this machine.")
        return 1

    print()
    print("No obvious problems found.")
    return 0


def command_config_init(args: argparse.Namespace) -> int:
    paths, config = load_effective_config(args)
    env_updates = collect_env_updates(args)
    persist_cli_runtime(
        config,
        paths,
        force_env_defaults=args.force,
        env_updates=env_updates,
    )
    asyncio.run(initialize_cli_runtime(config, paths))

    print("SaveMyContext config initialized.")
    print_runtime_summary(config, paths)
    print_config_next_steps(include_service=False)
    return 0


def command_config_set(args: argparse.Namespace) -> int:
    paths, config = load_effective_config(args)
    env_updates = collect_env_updates(args)
    persist_cli_runtime(config, paths, env_updates=env_updates)
    asyncio.run(initialize_cli_runtime(config, paths))

    print("SaveMyContext config updated.")
    print_runtime_summary(config, paths)
    print()
    print("If the backend is already running, restart it to apply the new settings.")
    return 0


def command_config_show(args: argparse.Namespace) -> int:
    paths = resolve_cli_paths(getattr(args, "config", None))
    config = load_cli_config(paths.config_path, paths=paths)
    env_values = load_env_file(paths.env_path)
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
            "openai_base_url": env_values.get("SAVEMYCONTEXT_OPENAI_BASE_URL"),
            "openai_model": env_values.get("SAVEMYCONTEXT_OPENAI_MODEL"),
            "openai_api_key_configured": bool(env_values.get("SAVEMYCONTEXT_OPENAI_API_KEY")),
            "google_api_key_configured": bool(env_values.get("SAVEMYCONTEXT_GOOGLE_API_KEY")),
        },
        "browser": {
            "profile_dir": str(config.browser_profile_dir),
            "headless": config.browser_headless,
            "channel": config.browser_channel,
            "executable_path": config.browser_executable_path,
            "timeout_seconds": config.browser_timeout_seconds,
        },
        "versioning": {
            "git_enabled": env_values.get("SAVEMYCONTEXT_GIT_VERSIONING_ENABLED", "true").lower() != "false",
        },
        "security": {
            "cors_origin_regex": env_values.get("SAVEMYCONTEXT_CORS_ORIGIN_REGEX"),
        },
        "paths": {
            "config_path": str(paths.config_path),
            "env_path": str(paths.env_path),
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


def add_runtime_override_args(parser: argparse.ArgumentParser, *, include_public_url: bool) -> None:
    parser.add_argument("--host", help="Bind host for the backend server.")
    parser.add_argument("--port", type=int, help="Bind port for the backend server.")
    parser.add_argument("--data-dir", type=Path, help="Directory for SQLite, browser state, and other local data.")
    parser.add_argument("--markdown-dir", type=Path, help="Directory where the Markdown vault should be written.")
    parser.add_argument("--llm-backend", help="Processing backend to use: auto, openai, google, heuristic, or browser_proxy.")
    parser.add_argument("--browser-llm-model", help="Model label recorded for browser-assisted processing state.")
    parser.add_argument("--browser-llm-state-path", type=Path, help="Path for browser-processing checkpoint state.")
    if include_public_url:
        parser.add_argument("--public-url", help="Public base URL used by remote extensions to reach this backend.")
    parser.add_argument("--browser-profile-dir", type=Path, help="Directory for browser profile state used by optional browser flows.")
    parser.add_argument("--browser-channel", help="Browser channel to launch for optional browser flows.")
    parser.add_argument("--browser-executable-path", help="Explicit browser executable path for optional browser flows.")
    parser.add_argument("--browser-timeout-seconds", type=float, help="Timeout for browser-assisted operations.")
    headless_group = parser.add_mutually_exclusive_group()
    headless_group.add_argument("--browser-headless", dest="browser_headless", action="store_true", help="Run browser automation headless.")
    headless_group.add_argument("--browser-headed", dest="browser_headless", action="store_false", help="Run browser automation with a visible window.")
    parser.set_defaults(browser_headless=None)


def add_env_override_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--openai-api-key", help="OpenAI-compatible API key used for processing and classification.")
    parser.add_argument("--openai-base-url", help="Base URL for the OpenAI-compatible API provider.")
    parser.add_argument("--openai-model", help="Model name used for processing and summarization.")
    parser.add_argument("--openai-app-name", help="Optional app name sent to OpenAI-compatible providers.")
    parser.add_argument("--openai-site-url", help="Optional site URL sent to OpenAI-compatible providers.")
    parser.add_argument("--google-api-key", help="Google API key used for Gemini-based processing.")
    parser.add_argument("--cors-origin-regex", help="Origin regex that is allowed to call the backend from the extension.")
    git_group = parser.add_mutually_exclusive_group()
    git_group.add_argument(
        "--git-versioning",
        dest="git_versioning_enabled",
        action="store_true",
        help="Enable git versioning for the vault and shared to-do list.",
    )
    git_group.add_argument(
        "--no-git-versioning",
        dest="git_versioning_enabled",
        action="store_false",
        help="Disable git versioning for the vault and shared to-do list.",
    )
    parser.set_defaults(git_versioning_enabled=None)


def build_parser() -> argparse.ArgumentParser:
    parser = HelpParser(prog="savemycontext", description="SaveMyContext backend service manager")
    parser.add_argument("--config", type=Path, help="Path to the SaveMyContext config.toml file.")
    subparsers = parser.add_subparsers(dest="command", required=True, parser_class=HelpParser)

    run_parser = subparsers.add_parser("run", help="Run the SaveMyContext backend in the foreground.")
    add_runtime_override_args(run_parser, include_public_url=False)
    run_parser.set_defaults(func=command_run)

    service_parser = subparsers.add_parser("service", help="Manage the SaveMyContext background service.")
    service_subparsers = service_parser.add_subparsers(dest="service_command", required=True, parser_class=HelpParser)

    install_parser = service_subparsers.add_parser("install", help="Install the SaveMyContext systemd user service.")
    install_parser.add_argument("--start", action="store_true", help="Start the service immediately after installing it.")
    install_parser.add_argument("--enable", action="store_true", help="Enable the service to start with your user session.")
    add_runtime_override_args(install_parser, include_public_url=True)
    add_env_override_args(install_parser)
    install_parser.add_argument("--force", action="store_true", help="Rewrite generated env defaults and replace a managed unit file.")
    install_parser.set_defaults(func=command_service_install)

    for action in ["start", "stop", "restart"]:
        action_parser = service_subparsers.add_parser(action, help=f"{action.title()} the SaveMyContext service.")
        action_parser.set_defaults(func=command_service_control, action=action)

    status_parser = service_subparsers.add_parser("status", help="Show SaveMyContext service status.")
    status_parser.set_defaults(func=command_service_status)

    logs_parser = service_subparsers.add_parser("logs", help="Show SaveMyContext service logs.")
    logs_parser.add_argument("-f", "--follow", action="store_true", help="Stream logs until interrupted.")
    logs_parser.add_argument("-n", "--lines", type=int, default=100, help="Number of recent lines to show before exiting.")
    logs_parser.add_argument("--since", help="Show logs newer than a journalctl-compatible time expression.")
    logs_parser.set_defaults(func=command_service_logs)

    uninstall_parser = service_subparsers.add_parser("uninstall", help="Uninstall the SaveMyContext service.")
    uninstall_parser.add_argument("--purge-data", action="store_true", help="Delete the CLI config directory and local data after uninstalling.")
    uninstall_parser.set_defaults(func=command_service_uninstall)

    doctor_parser = subparsers.add_parser("doctor", help="Run basic health checks.")
    doctor_parser.set_defaults(func=command_doctor)

    init_admin_parser = subparsers.add_parser("init-admin", help="Create the first SaveMyContext admin user.")
    init_admin_parser.add_argument("--username", default="admin", help="Username for the admin account.")
    init_admin_parser.add_argument("--password", help="Password for the admin account. Omit to be prompted securely.")
    init_admin_parser.add_argument("--force", action="store_true", help="Reset the existing admin password if the user already exists.")
    init_admin_parser.add_argument("--json", action="store_true", help="Print the created user as JSON.")
    init_admin_parser.set_defaults(func=command_init_admin)

    token_parser = subparsers.add_parser("token", help="Manage SaveMyContext API tokens.")
    token_subparsers = token_parser.add_subparsers(dest="token_command", required=True, parser_class=HelpParser)

    token_create_parser = token_subparsers.add_parser("create", help="Create an API token.")
    token_create_parser.add_argument("--username", default="admin", help="Admin username that owns the token.")
    token_create_parser.add_argument("--name", required=True, help="Human-readable token name.")
    token_create_parser.add_argument("--scope", action="append", help="Token scope. Repeat for multiple scopes.")
    token_create_parser.add_argument("--json", action="store_true", help="Print the created token payload as JSON.")
    token_create_parser.set_defaults(func=command_token_create)

    token_list_parser = token_subparsers.add_parser("list", help="List API tokens.")
    token_list_parser.add_argument("--json", action="store_true", help="Print the token list as JSON.")
    token_list_parser.set_defaults(func=command_token_list)

    token_revoke_parser = token_subparsers.add_parser("revoke", help="Revoke an API token.")
    token_revoke_parser.add_argument("token_id", help="Token id to revoke.")
    token_revoke_parser.add_argument("--json", action="store_true", help="Print the revoked token as JSON.")
    token_revoke_parser.set_defaults(func=command_token_revoke)

    browser_parser = subparsers.add_parser("browser", help="Deprecated browser automation commands.")
    browser_subparsers = browser_parser.add_subparsers(dest="browser_command", required=True, parser_class=HelpParser)
    browser_install_parser = browser_subparsers.add_parser("install", help="Deprecated. Use the Chrome extension instead.")
    browser_install_parser.set_defaults(func=command_browser_install)
    browser_login_parser = browser_subparsers.add_parser("login", help="Deprecated. Sign into the provider in your normal browser.")
    browser_login_parser.add_argument("--provider", choices=[provider.value for provider in ProviderName], required=True, help="Provider name.")
    browser_login_parser.add_argument("--json", action="store_true", help="Print the disabled-browser message as JSON.")
    browser_login_parser.set_defaults(func=command_browser_login)

    config_parser = subparsers.add_parser("config", help="Inspect SaveMyContext configuration.")
    config_subparsers = config_parser.add_subparsers(dest="config_command", required=True, parser_class=HelpParser)
    config_init_parser = config_subparsers.add_parser("init", help="Create the config, env file, data directories, and SQLite database.")
    add_runtime_override_args(config_init_parser, include_public_url=True)
    add_env_override_args(config_init_parser)
    config_init_parser.add_argument("--force", action="store_true", help="Rewrite the generated env defaults if the env file already exists.")
    config_init_parser.set_defaults(func=command_config_init)
    config_set_parser = config_subparsers.add_parser("set", help="Update config values and selected env-backed settings.")
    add_runtime_override_args(config_set_parser, include_public_url=True)
    add_env_override_args(config_set_parser)
    config_set_parser.set_defaults(func=command_config_set)
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
