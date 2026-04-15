# TSMC

TSMC captures your ChatGPT, Gemini, and Grok conversations, syncs them to a backend, classifies them into `journal`, `factual`, `ideas`, or `todo`, and writes an Obsidian-friendly Markdown vault plus a lightweight knowledge graph.

## What You Get

- Chrome extension for automatic chat capture and history backfill
- self-hosted backend with SQLite storage
- Markdown vault with session notes, a shared `To-Do List.md`, entity notes, and index notes
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

- local backend: `http://127.0.0.1:18888`
- remote backend: `https://your-domain`

Remote backends require an app token. Create one with:

```bash
tsmc init-admin --username admin
tsmc token create --name chrome-extension --scope ingest --scope read
```

Paste that token into the extension settings. The extension validates the backend before saving it.

Optional indexing gate:

- default mode: index everything
- trigger-word mode: only index sessions whose opening user request matches one of your trigger words
- default trigger word: `lorem`
- blacklist words always override trigger words and skip indexing

The trigger/blacklist check focuses on the opening one or two user sentences so it works well with natural speech dictation.

### 4. Use it

Visit ChatGPT, Gemini, or Grok while signed in.

If `Auto Sync History` is enabled, TSMC will:

- fetch historical conversations from the provider website
- sync them to the backend
- queue each session for classification
- update the shared to-do list when a conversation is clearly editing tasks
- write Markdown notes and graph files

If you change trigger-word or blacklist settings, the next provider visit will run a fresh history pass using the new rules without re-indexing sessions that were already synced successfully.

Recommended processing setup:

```bash
TSMC_OPENAI_API_KEY=your_openrouter_key
TSMC_OPENAI_BASE_URL=https://openrouter.ai/api/v1
TSMC_OPENAI_MODEL=openai/gpt-4.1-mini
```

Put those in your backend env file, for example `~/.config/tsmc/tsmc.env` when using `tsmc service install`, or export them before starting the server. Browser automation is experimental and disabled by default.

Git versioning is enabled by default for the vault. TSMC initializes a local git repo inside the Obsidian vault and commits session-note, graph, dashboard, and shared to-do list changes automatically.

## Where Data Goes

Service install defaults:

- database: `~/.local/share/tsmc/tsmc.db`
- Markdown vault: `~/.local/share/tsmc/markdown/TSMC`
- browser profiles: `~/.local/share/tsmc/browser-profile/`

Repo-local dev defaults:

- database: `backend/data/tsmc.db`
- Markdown vault: `backend/data/markdown/TSMC`
- browser profiles: `backend/data/browser-profile/`

Vault layout:

```text
TSMC/
  Journal/
  Factual/
  Ideas/
  Todo/
  Sessions/
  Graph/
    Entities/
    Indexes/
  Dashboards/
    To-Do List.md
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
- OpenRouter or another OpenAI-compatible key should be configured on the backend for processing.
- Browser-based AI processing is experimental and disabled by default.
- Git versioning for the vault and shared to-do list is enabled by default.
- The extension bundle auto-rebuilds in dev mode, but Chrome still needs the unpacked extension reloaded after changes.

## Docs

- [Architecture](/Volumes/Brookline/Projects/Personal/tsmc/docs/architecture.md)
- [Agentic System Design](/Volumes/Brookline/Projects/Personal/tsmc/docs/agentic-system-design.md)
- [CLI Service Design](/Volumes/Brookline/Projects/Personal/tsmc/docs/cli-service-design.md)
- [Product Platform Design](/Volumes/Brookline/Projects/Personal/tsmc/docs/product-platform-design.md)
