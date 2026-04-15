# SaveMyContext Architecture

## Goals

- Capture supported AI chat traffic without coupling backend logic to any single provider.
- Persist normalized sessions locally in both relational and Markdown forms.
- Run post-processing automatically after every sync so the local archive becomes searchable and actionable.
- Keep the system local-first and lightweight enough to run on a laptop.

## Delivery Plan

1. Build a typed FastAPI ingest contract and durable storage model.
2. Implement Markdown mirroring so every session has a vendor-independent transcript.
3. Add a processing orchestrator with three pipelines and pluggable LLM backends.
4. Build an MV3 extension that injects a network observer into supported AI tabs.
5. Normalize provider payloads into a common snapshot model, compute message diffs, and sync them to the backend.
6. Add tests for backend processing and extension parsing/diff logic, then verify builds.

## Backend Design

### Persistence

- SQLite via async SQLAlchemy.
- `chat_sessions`: provider, external session id, title, category, tags, Markdown path, and pipeline outputs.
- `chat_messages`: normalized role/content records plus raw provider payload fragments.
- `fact_triplets`: extracted SPO records for knowledge graph views.
- `sync_events`: audit trail of captured deltas.

### Ingest Flow

1. Extension posts a normalized session delta to `POST /api/v1/ingest/diff`.
2. Backend upserts the session and any unseen messages.
3. Backend rewrites the session transcript under `backend/data/markdown/`.
4. Backend classifies the session and runs the matching processing pipeline.
5. Processed session data becomes available through read APIs for sessions and category views.

### Processing

- Default mode is `auto`: use OpenAI if configured, otherwise Google, otherwise a heuristic fallback.
- Classifier returns one of `journal`, `factual`, or `ideas`.
- Journal pipeline produces a diary-style entry with explicit action items.
- Factual pipeline extracts SPO triplets and stores them separately.
- Ideas pipeline produces a structured summary and a shareable short post.

## Extension Design

### Capture Strategy

Manifest V3 service workers cannot directly inspect arbitrary response bodies. To keep the extension compatible with MV3 while still capturing raw payloads, the extension uses a two-part design:

- A content script injects a page-context network observer that monkey-patches `fetch` and `XMLHttpRequest`.
- The injected observer forwards matching request/response metadata back to the extension.
- The service worker owns provider detection, normalization, diffing, and backend sync.

This preserves the provider abstraction from the specification while using an implementation path Chrome actually supports.

### Provider Harness

Each provider scraper implements:

- URL matching for relevant network traffic.
- Parsing of provider-specific payloads into normalized messages.
- Session metadata extraction when present.

Current providers:

- ChatGPT
- Gemini
- Grok

Because all three platforms use internal APIs that can change without notice, parsers are intentionally defensive and easy to update.

## Tradeoffs

- The backend processes synchronously after ingest for simplicity and determinism in a local setup.
- Heuristic fallbacks are deliberately conservative; LLM-backed outputs are richer when credentials are configured.
- Provider-specific parsing covers common payload shapes but should be treated as adaptable infrastructure rather than a permanent contract.

