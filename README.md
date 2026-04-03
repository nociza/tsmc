# TSMC

TSMC captures your ChatGPT, Gemini, and Grok conversations, syncs them to a backend, classifies them into `journal`, `factual`, or `ideas`, and writes an Obsidian-friendly Markdown vault plus a lightweight knowledge graph.

## What You Get

- Chrome extension for automatic chat capture and history backfill
- self-hosted backend with SQLite storage
- Markdown vault with session notes, entity notes, and index notes
- simple agent-friendly API for ingest, search, graph, system status, and browser-proxied chat completions

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

## OpenAI-Compatible API

TSMC can also proxy chat requests through your logged-in browser sessions.

1. Install the managed Chromium runtime:

```bash
cd backend
uv sync
uv run tsmc browser install
```

2. Log into each provider once with the managed browser profile:

```bash
uv run tsmc browser login --provider chatgpt
uv run tsmc browser login --provider gemini
uv run tsmc browser login --provider grok
```

3. Create a token with `proxy` scope if you are calling the backend remotely:

```bash
tsmc token create --name agent-client --scope proxy --scope read
```

4. Point any OpenAI-compatible client at `http://127.0.0.1:8000/v1` and choose one of:

- `browser-chatgpt`
- `browser-gemini`
- `browser-grok`

Example:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8000/v1",
    api_key="tsmc_pat_..."
)

response = client.chat.completions.create(
    model="browser-gemini",
    messages=[{"role": "user", "content": "Summarize my deployment plan."}],
    extra_body={"store": True}
)

print(response.choices[0].message.content)
print(response.tsmc)
```

Notes:

- `store: true` sends the proxy session through the normal TSMC ingest/classify/markdown pipeline.
- `store: false` returns the provider response without saving it.
- To continue the same provider thread, send `tsmc_provider_session_url` back in `extra_body`.

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
tsmc browser install
tsmc browser login --provider gemini
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
- The browser proxy uses a managed persistent Chromium profile per provider.
- The extension bundle auto-rebuilds in dev mode, but Chrome still needs the unpacked extension reloaded after changes.

## Docs

- [Architecture](/Volumes/Brookline/Projects/Personal/tsmc/docs/architecture.md)
- [Agentic System Design](/Volumes/Brookline/Projects/Personal/tsmc/docs/agentic-system-design.md)
- [CLI Service Design](/Volumes/Brookline/Projects/Personal/tsmc/docs/cli-service-design.md)
- [Product Platform Design](/Volumes/Brookline/Projects/Personal/tsmc/docs/product-platform-design.md)
