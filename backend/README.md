# SaveMyContext Server

Self-hosted FastAPI backend and Linux/macOS service CLI for SaveMyContext.

## Install As a Tool

Recommended user flow on Linux and macOS:

```bash
uv tool install savemycontext
savemycontext service install --start
```

On Linux, that installs a `systemd --user` service. On macOS, it installs a per-user `launchd` agent. The CLI also supports `savemycontext run` if you want the backend in the foreground without a background service.

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

For `savemycontext service install`, put those values in the generated env file:

- Linux: `~/.config/savemycontext/savemycontext.env`
- macOS: `~/Library/Application Support/savemycontext/savemycontext.env`

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
uv run python -m app.dev
```
