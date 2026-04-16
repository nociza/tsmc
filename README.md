# SaveMyContext

SaveMyContext captures your ChatGPT, Gemini, and Grok conversations, syncs them to a backend, classifies them into `journal`, `factual`, `ideas`, or `todo`, and writes an Obsidian-friendly Markdown vault plus a lightweight knowledge graph.

## What You Get

- Chrome extension for automatic chat capture and history backfill
- self-hosted backend with SQLite storage
- Markdown vault with session notes, a shared `To-Do List.md`, entity notes, and index notes
- simple agent-friendly API for ingest, search, graph, and system status

## Quick Start

### 1. Start the backend

Recommended local install:

```bash
uv tool install savemycontext
savemycontext service install --start
```

On macOS, the same command installs a per-user `launchd` agent instead of a `systemd` service.

If you want to bootstrap local config first, or run without a background service, use:

```bash
savemycontext config init --openai-api-key YOUR_KEY
savemycontext run
```

If you want to run it from this repo instead:

```bash
cd backend
uv sync
uv run python -m app.dev
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
savemycontext init-admin --username admin
savemycontext token create --name chrome-extension --scope ingest --scope read
```

Paste that token into the extension settings. The extension validates the backend before saving it and checks that the token has `ingest` plus `read`.

Optional indexing gate:

- default mode: index everything
- trigger-word mode: only index sessions whose opening user request matches one of your trigger words
- default trigger word: `lorem`
- blacklist words always override trigger words and skip indexing

The trigger/blacklist check focuses on the opening one or two user sentences so it works well with natural speech dictation.

### 4. Use it

Visit ChatGPT, Gemini, or Grok while signed in.

If `Auto Sync History` is enabled, SaveMyContext will:

- fetch historical conversations from the provider website
- sync them to the backend
- queue each session for classification
- update the shared to-do list when a conversation is clearly editing tasks
- write Markdown notes and graph files

If you change trigger-word or blacklist settings, the next provider visit will run a fresh history pass using the new rules without re-indexing sessions that were already synced successfully.

Recommended processing setup:

```bash
SAVEMYCONTEXT_OPENAI_API_KEY=your_openrouter_key
SAVEMYCONTEXT_OPENAI_BASE_URL=https://openrouter.ai/api/v1
SAVEMYCONTEXT_OPENAI_MODEL=openai/gpt-4.1-mini
```

Put those in your backend env file, for example `~/.config/savemycontext/savemycontext.env` on Linux or `~/Library/Application Support/savemycontext/savemycontext.env` on macOS when using `savemycontext service install`, or set them with:

```bash
savemycontext config set \
  --openai-api-key your_openrouter_key \
  --openai-base-url https://openrouter.ai/api/v1 \
  --openai-model openai/gpt-4.1-mini
```

Browser automation is experimental and disabled by default.

Git versioning is enabled by default for the vault. SaveMyContext initializes a local git repo inside the Obsidian vault and commits session-note, graph, dashboard, and shared to-do list changes automatically.

## Where Data Goes

Service install defaults on Linux:

- database: `~/.local/share/savemycontext/savemycontext.db`
- Markdown vault: `~/.local/share/savemycontext/markdown/SaveMyContext`
- browser profiles: `~/.local/share/savemycontext/browser-profile/`

Service install defaults on macOS:

- config: `~/Library/Application Support/savemycontext/config.toml`
- env: `~/Library/Application Support/savemycontext/savemycontext.env`
- LaunchAgent: `~/Library/LaunchAgents/savemycontext.plist`
- database: `~/Library/Application Support/savemycontext/data/savemycontext.db`
- Markdown vault: `~/Library/Application Support/savemycontext/data/markdown/SaveMyContext`
- browser profiles: `~/Library/Application Support/savemycontext/data/browser-profile/`

Repo-local dev defaults:

- database: `backend/data/savemycontext.db`
- Markdown vault: `backend/data/markdown/SaveMyContext`
- browser profiles: `backend/data/browser-profile/`

Vault layout:

```text
SaveMyContext/
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
savemycontext config init
savemycontext config set --markdown-dir ~/Obsidian/SaveMyContext
savemycontext service status
savemycontext service logs -f
savemycontext config path
savemycontext token list
savemycontext token revoke <token-id>
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

- Fresh loopback-only backends work without a token until the first app token is created.
- Once any app token exists, all protected API access, including `http://127.0.0.1` and `http://localhost`, requires that token.
- Remote backends must use `https://`.
- OpenRouter or another OpenAI-compatible key should be configured on the backend for processing.
- Browser-based AI processing is experimental and disabled by default.
- Git versioning for the vault and shared to-do list is enabled by default.
- Linux background services use `systemd --user`; macOS background services use `launchd`.
- The extension bundle auto-rebuilds in dev mode, but Chrome still needs the unpacked extension reloaded after changes.

## Docs

- [Architecture](docs/architecture.md)
- [Agentic System Design](docs/agentic-system-design.md)
- [CLI Service Design](docs/cli-service-design.md)
- [Product Platform Design](docs/product-platform-design.md)
