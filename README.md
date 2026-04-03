# TSMC

TSMC captures your ChatGPT, Gemini, and Grok conversations, syncs them to a backend, classifies them into `journal`, `factual`, or `ideas`, and writes an Obsidian-friendly Markdown vault plus a lightweight knowledge graph.

## What You Get

- Chrome extension for automatic chat capture and history backfill
- self-hosted backend with SQLite storage
- Markdown vault with session notes, entity notes, and index notes
- simple agent-friendly API for ingest, search, graph, and system status

## Quick Start

### 1. Start the backend

Recommended Linux install:

```bash
uv tool install tsmc-server
tsmc service install --start
```

If you want to run it from this repo instead:

```bash
cd backend
uv sync
uv run dev
```

### 2. Load the extension

```bash
cd extension
pnpm install
pnpm run dev
```

Then:

1. Open `chrome://extensions`
2. Enable Developer Mode
3. Load unpacked: `extension/dist`

### 3. Point the extension at your backend

Open the extension settings and enter:

- local backend: `http://127.0.0.1:8000`
- remote backend: `https://your-domain`

Remote backends require an app token. Create one with:

```bash
tsmc init-admin --username admin
tsmc token create --name chrome-extension --scope ingest --scope read
```

Paste that token into the extension settings. The extension validates the backend before saving it.

### 4. Use it

Visit ChatGPT, Gemini, or Grok while signed in.

If `Auto Sync History` is enabled, TSMC will:

- fetch historical conversations from the provider website
- sync them to the backend
- classify each session
- write Markdown notes and graph files

## Where Data Goes

Service install defaults:

- database: `~/.local/share/tsmc/tsmc.db`
- Markdown vault: `~/.local/share/tsmc/markdown/TSMC`

Repo-local dev defaults:

- database: `backend/data/tsmc.db`
- Markdown vault: `backend/data/markdown/TSMC`

Vault layout:

```text
TSMC/
  Journal/
  Factual/
  Ideas/
  Sessions/
  Graph/
    Entities/
    Indexes/
  Dashboards/
```

## Useful Commands

```bash
tsmc service status
tsmc service logs -f
tsmc config path
tsmc token list
tsmc token revoke <token-id>
```

## Development

Backend:

```bash
cd backend
uv sync
uv run pytest -q
```

Extension:

```bash
cd extension
pnpm test
pnpm typecheck
pnpm build
pnpm test:e2e
```

## Notes

- Local backends work without a token.
- Remote backends must use `https://`.
- The extension bundle auto-rebuilds in dev mode, but Chrome still needs the unpacked extension reloaded after changes.

## Docs

- [Architecture](/Volumes/Brookline/Projects/Personal/tsmc/docs/architecture.md)
- [Agentic System Design](/Volumes/Brookline/Projects/Personal/tsmc/docs/agentic-system-design.md)
- [CLI Service Design](/Volumes/Brookline/Projects/Personal/tsmc/docs/cli-service-design.md)
- [Product Platform Design](/Volumes/Brookline/Projects/Personal/tsmc/docs/product-platform-design.md)
