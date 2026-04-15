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

## Processing

Recommended OpenRouter env settings:

```bash
TSMC_OPENAI_API_KEY=your_openrouter_key
TSMC_OPENAI_BASE_URL=https://openrouter.ai/api/v1
TSMC_OPENAI_MODEL=openai/gpt-4.1-mini
```

Browser automation is experimental and disabled by default.

For `tsmc service install`, put those values in `~/.config/tsmc/tsmc.env`.

## Vault And To-Do Versioning

TSMC writes the Obsidian vault under `markdown/TSMC`, keeps a shared `Dashboards/To-Do List.md`, and initializes a local git repository in that vault by default. Session notes, dashboards, graph files, and to-do updates are committed automatically.

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
