# TSMC Server

Self-hosted FastAPI backend and Linux service CLI for TSMC.

## Install As a Tool

Recommended user flow on Linux:

```bash
uv tool install tsmc-server
tsmc service install --start
```

That installs the backend as an isolated `uv` tool, writes config under `~/.config/tsmc/`, stores runtime data under `~/.local/share/tsmc/`, and registers a `systemd --user` service.

Useful commands:

```bash
tsmc service status
tsmc service logs -f
tsmc config path
tsmc doctor
```

## Run In the Foreground

```bash
tsmc run
```

## Development

Run the local development server from source with:

```bash
uv sync
uv run dev
```
