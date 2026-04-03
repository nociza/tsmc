# TSMC

TSMC (Total Sync: My Context) is a local-first second-brain pipeline for web AI chats. It ships two components:

- A Chrome extension that watches supported AI web apps, captures normalized conversation deltas, and syncs them to a local backend.
- A FastAPI backend that stores sessions in SQLite, mirrors transcripts to Markdown, and runs classification plus post-processing pipelines for journal, factual, and idea workflows.

## Project Layout

- `backend/`: FastAPI app, persistence, Markdown export, LLM abstraction, processing pipelines, and tests.
- `extension/`: MV3 Chrome extension built with TypeScript and Vite.
- `docs/architecture.md`: implementation plan and system design.
- `docs/agentic-system-design.md`: implemented machine-readable API, token, and vault design for agents.
- `docs/cli-service-design.md`: proposed self-hosted CLI and Linux service UX.
- `docs/product-platform-design.md`: proposed auth, dashboard, Obsidian, graph, and hosted product design.
- `spec.md`: original project specification.

## Backend Quickstart

```bash
cd backend
uv sync
uv run dev
```

The backend stores runtime data under `backend/data/`.

For secure remote extension or agent access, bootstrap an admin and create an app token:

```bash
cd backend
uv sync
tsmc init-admin --username admin
tsmc token create --name chrome-extension --scope ingest --scope read
```

Copy [`backend/.env.example`](/Volumes/Brookline/Projects/Personal/tsmc/backend/.env.example) to `backend/.env` if you want to enable OpenAI or Google-backed processing.

## Extension Quickstart

```bash
cd extension
pnpm install
pnpm run dev
```

`pnpm run dev` keeps rebuilding `extension/dist/` as files change. Load `extension/dist/` as an unpacked extension in Chrome. After code changes, Chrome still needs the unpacked extension reloaded from the Extensions page to pick up the rebuilt files.

The extension options page includes an `Auto Sync History` toggle. When it is enabled, visiting `chatgpt.com` automatically backfills the signed-in user's historical conversations by calling the same website endpoints the app uses in-browser, then forwards those captures into the local backend.

For browser-level extension E2E coverage, install Playwright's bundled Chromium once:

```bash
cd backend
uv sync
uv run dev
```

In another terminal:

```bash
cd extension
pnpm exec playwright install chromium
TSMC_E2E_BACKEND_URL=http://127.0.0.1:8000 pnpm test:e2e
```

Load `extension/dist/` as an unpacked Chrome extension. Open the extension options page and point it at your FastAPI backend, usually `http://127.0.0.1:8000`.
If you are using a remote backend, use `https://...` plus an app token from `tsmc token create`.

## Local Dev Loop

Backend:

```bash
cd backend
uv sync
uv run dev
```

Extension:

```bash
cd extension
pnpm install
pnpm run dev
```

Then load [extension/dist](/Volumes/Brookline/Projects/Personal/tsmc/extension/dist) as an unpacked extension, set the backend URL to `http://127.0.0.1:8000`, and reload the unpacked extension after source changes.

## Verification

Backend:

```bash
cd backend
uv run pytest -q
```

Extension:

```bash
cd extension
pnpm test
pnpm typecheck
pnpm build
TSMC_E2E_BACKEND_URL=http://127.0.0.1:8000 pnpm test:e2e
```

## Processing Model

- `journal`: personal context and task-oriented conversation summaries.
- `factual`: subject-predicate-object triplets for a lightweight knowledge graph.
- `ideas`: brainstorm summaries with pros, cons, next steps, and a share-ready short post.

When no LLM API key is configured, the backend falls back to deterministic heuristics so the ingest pipeline still works end to end.
