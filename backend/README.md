# SaveMyContext Server

Self-hosted FastAPI backend and Linux service CLI for SaveMyContext.

## Install As a Tool

Recommended user flow on Linux:

```bash
uv tool install savemycontext
savemycontext service install --start
```

That installs the backend as an isolated `uv` tool, writes config under `~/.config/savemycontext/`, stores runtime data under `~/.local/share/savemycontext/`, and registers a `systemd --user` service.

Useful commands:

```bash
savemycontext service status
savemycontext service logs -f
savemycontext config path
savemycontext doctor
```

## Processing

Recommended OpenRouter env settings:

```bash
SAVEMYCONTEXT_OPENAI_API_KEY=your_openrouter_key
SAVEMYCONTEXT_OPENAI_BASE_URL=https://openrouter.ai/api/v1
SAVEMYCONTEXT_OPENAI_MODEL=openai/gpt-4.1-mini
```

Browser automation is experimental and disabled by default.

For `savemycontext service install`, put those values in `~/.config/savemycontext/savemycontext.env`.

## Vault And To-Do Versioning

SaveMyContext writes the Obsidian vault under `markdown/SaveMyContext`, keeps a shared `Dashboards/To-Do List.md`, and initializes a local git repository in that vault by default. Session notes, dashboards, graph files, and to-do updates are committed automatically.

## Run In the Foreground

```bash
savemycontext run
```

## Development

Run the local development server from source with:

```bash
uv sync
uv run dev
```
