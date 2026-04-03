# TSMC Product Platform Design

## Summary

This document proposes how TSMC evolves from a local developer tool into a secure self-hosted product with:

- a background backend service
- secure remote sync from the Chrome extension
- a web dashboard for observability and note management
- Obsidian-friendly Markdown and knowledge graph exports
- simple user/password auth for the dashboard
- app tokens for the extension
- a CLI that manages the whole system

The primary product shape is still self-hosted on the user's own Linux machine. That is the right default because:

- the product writes Markdown files to disk
- the knowledge graph should exist as real files, not only rows in a database
- Obsidian works best when it can access the entire vault directly
- the user explicitly wants OpenClaw and Obsidian to work with the generated files

Railway remains a secondary deployment mode, not the primary one.

## Current State Audit

### Already implemented

- Sync ingest exists.
- Session classification already happens during ingest into the three categories:
  - `journal`
  - `factual`
  - `ideas`
- Factual sessions already extract subject-predicate-object triplets.
- Session Markdown export already happens after ingest.
- The extension already allows the user to configure a backend URL.

### Missing or incomplete

- No dashboard or search UI.
- No user/password auth.
- No extension-to-backend compatibility handshake.
- No remote-safe extension authentication model.
- No backend token management.
- No Obsidian-specific vault structure or front matter.
- No graph node Markdown files or graph index Markdown files.
- No real search API beyond simple list endpoints.
- No public-hosting story with TLS and safe defaults.
- No frontend observability surface.

## User Goals

From the user's perspective, the desired experience is:

1. Install the server with one command.
2. Point the browser extension at a backend URL.
3. Verify immediately that the backend is compatible.
4. Authenticate the extension safely without handing it the main dashboard password forever.
5. Let sync happen automatically.
6. Open a web dashboard and see:
   - whether the system is healthy
   - whether sync is working
   - what is in journal, factual, and ideas
   - a simple search across notes
   - a basic knowledge graph view
7. Open the same data in Obsidian as a real vault.

## Recommended Product Architecture

### Core services

- `FastAPI` backend remains the system of record.
- `SQLite` remains the default local database for the primary self-hosted mode.
- Markdown files remain first-class artifacts.
- A statically built frontend dashboard is served by the same backend process.

### Frontend recommendation

Recommendation:

- `React 19.2`
- `Vite 8`
- static SPA bundle served by FastAPI

Why this stack:

- It is current and fast.
- It ships very easily inside the existing Python product.
- It avoids introducing a second always-on Node service.
- It keeps the CLI/service model simple.
- It matches the existing TypeScript/Vite tooling already used in the extension.

Why not use Next.js as the primary dashboard stack:

- Next.js 15 is current and production-ready, but it adds a Node runtime and deployment complexity that works against the "same CLI manages everything" goal.
- For this product, the backend is already Python-first and the dashboard does not need Node SSR to succeed.
- A static dashboard served by FastAPI is simpler, cheaper, and easier for self-hosting users.

## Security Model

### Dashboard auth

Use:

- local user accounts in the backend
- password hashing with `argon2`
- secure HTTP-only session cookies for the web dashboard

Do not use:

- Basic Auth as the primary product auth layer
- storing plaintext passwords anywhere
- making the extension reuse the dashboard password on every request

### Extension auth

Use:

- per-user extension app tokens
- tokens created from the dashboard or CLI
- hashed token storage in the database
- scope-limited access for ingest and health/compatibility endpoints

The extension should not keep the main dashboard password. The user/password system is for humans. The extension should use an app token.

### Transport security

Rules:

- allow plain HTTP only for localhost and private development
- require HTTPS for non-local backend URLs in extension validation
- refuse or strongly warn on insecure public URLs

For public exposure, the recommended deployment is:

- FastAPI bound on localhost
- reverse proxy in front
- automatic TLS

Recommendation:

- use `Caddy` as the preferred public gateway in the Linux self-hosted path

Why:

- automatic HTTPS is straightforward
- configuration is simpler than hand-rolled Nginx for the target user
- it fits the "simple CLI-managed service" direction

## Extension-to-Backend Compatibility Validation

Add a dedicated compatibility endpoint:

- `GET /api/v1/meta/capabilities`

Response should include:

- backend product name
- backend version
- minimum supported extension version
- auth mode
- whether remote ingest is enabled
- whether search/dashboard is enabled
- whether Obsidian vault mode is enabled
- server time

Example shape:

```json
{
  "product": "tsmc-server",
  "version": "0.2.0",
  "extension": {
    "min_version": "0.2.0",
    "auth_mode": "app_token"
  },
  "features": {
    "dashboard": true,
    "search": true,
    "obsidian_vault": true,
    "knowledge_graph_files": true
  }
}
```

### Extension UX flow

1. User enters backend URL.
2. Extension calls `/api/v1/meta/capabilities`.
3. Extension verifies:
   - valid JSON
   - product matches TSMC
   - version compatibility
   - HTTPS if remote
4. If auth is required:
   - prompt for app token
   - verify token with `/api/v1/auth/token/verify`
5. Save URL and token only after validation succeeds.

This gives the user a clean "is this backend compatible?" flow instead of letting invalid URLs fail later during ingest.

## Backend Auth and API Design

### New backend domains

Add:

- `users`
- `sessions` for dashboard login sessions
- `api_tokens` for extension/app access
- `settings` for product configuration

### New endpoint groups

- `POST /api/v1/auth/login`
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/me`
- `POST /api/v1/auth/tokens`
- `GET /api/v1/meta/capabilities`
- `GET /api/v1/dashboard/summary`
- `GET /api/v1/search`
- `GET /api/v1/graph/nodes`
- `GET /api/v1/graph/edges`
- `GET /api/v1/system/status`

### Auth split

- dashboard routes use session-cookie auth
- extension ingest routes use bearer app tokens
- local-only bootstrap routes exist only for initial setup

### First-user bootstrap

Recommended UX:

```bash
tsmc init-admin
```

This should:

- create the first admin user
- hash the password
- refuse to run again once users exist unless forced

## Data and Obsidian Vault Design

### Product requirement

The Markdown output should not just be transcript dumps. It should become a real vault structure that works naturally in Obsidian.

### Recommended vault layout

```text
Vault/
  TSMC/
    Journal/
    Factual/
    Ideas/
    Sessions/
    Graph/
      Entities/
      Indexes/
    Dashboards/
      Journal Index.md
      Factual Index.md
      Ideas Index.md
      Graph Index.md
```

### Session note format

Each synced session gets:

- YAML front matter
- stable internal ID
- category
- source provider
- source URL
- tags
- timestamps
- transcript
- category-specific output
- links to related graph nodes

Example front matter:

```yaml
---
id: tsmc-session-123
provider: gemini
external_session_id: u1__abc123
category: factual
tags:
  - tsmc
  - factual
captured_at: 2026-04-02T20:00:00Z
updated_at: 2026-04-02T20:00:10Z
---
```

### Obsidian-friendly linking

Use:

- wikilinks for graph entities, category dashboards, and related sessions
- real folders, not hidden pseudo-structure

This matters because Obsidian updates links and graph features across the whole vault.

## Knowledge Graph Design

### Current state

The backend already stores factual triplets in the database. That is useful, but it is not enough for the desired vault-native graph experience.

### Add graph file generation

During sync processing, after triplet extraction:

1. upsert triplets in the database
2. generate per-entity Markdown notes
3. generate graph index Markdown notes
4. link session notes to entity notes
5. link entity notes back to supporting sessions

### Entity note format

Example:

```md
# SQLite

## Facts

- SQLite | is used by | TSMC
- SQLite | stores | chat sessions

## Source Sessions

- [[TSMC Session gemini u1__abc123]]
- [[TSMC Session chatgpt xyz987]]
```

### Graph index notes

Generate:

- entity index
- relationship index
- factual session index

These help both Obsidian navigation and dashboard queries.

### Graph API

Store graph data in DB for fast querying and visualization, but also materialize it to Markdown so the vault stays first-class.

## Search Design

### Requirement

The dashboard needs a very simple but useful search across notes and transcripts.

### Recommended implementation

Use SQLite FTS5.

Index:

- title
- transcript text
- journal entry
- idea summary text
- triplet text
- generated Markdown body text

Add:

- `search_documents` virtual table
- sync/update on ingest processing

Expose:

- `GET /api/v1/search?q=...`

Return:

- session hits
- entity hits
- category
- score
- snippet

### Why FTS5 first

- zero extra service
- good enough for the single-machine product shape
- easy to package

Postgres full-text can wait until the cloud/multi-user story matters more.

## Dashboard Design

### Purpose

The dashboard should be the control center for:

- service health
- sync status
- drift alerts
- search
- category views
- graph browsing
- auth token management
- vault configuration

### Recommended routes

- `/login`
- `/`
- `/search`
- `/journal`
- `/factual`
- `/ideas`
- `/graph`
- `/settings`
- `/tokens`

### Recommended information architecture

#### Home dashboard

- server status
- last sync time
- sync errors
- provider drift alerts
- counts by category
- top recent sessions

#### Search

- single search box
- type filter:
  - sessions
  - entities
  - all

#### Category pages

- `journal`
- `factual`
- `ideas`

Each page should show:

- recent items
- count
- quick filters
- open in dashboard
- open underlying Markdown note path

#### Graph page

- simple node/edge view
- entity sidebar
- supporting sessions
- not a heavy 3D toy

Recommendation:

- start with a 2D force graph or adjacency panel
- optimize for usefulness, not visual novelty

### Dashboard stack choice

Recommendation:

- React 19.2
- Vite 8
- TypeScript
- TanStack Router
- TanStack Query

Why:

- modern and current
- fast build/dev loop
- easy static bundling
- no forced Node runtime

## Serving the Dashboard

### Packaging model

Build the frontend once and ship the static assets inside the Python package.

FastAPI serves:

- dashboard static assets
- dashboard API

This keeps:

- one service
- one CLI
- one deployment model

### CLI control

The CLI should manage the whole product, not just the API process.

The user should not have to think in terms of separate frontend and backend daemons.

## CLI Expansion Plan

### New commands

- `tsmc init-admin`
- `tsmc user create`
- `tsmc user reset-password`
- `tsmc token create --name chrome-extension`
- `tsmc token revoke <id>`
- `tsmc vault init`
- `tsmc vault link --path /path/to/ObsidianVault`
- `tsmc dashboard status`

### `tsmc vault init`

Creates a managed vault structure if the user wants TSMC to own the vault.

### `tsmc vault link`

Links TSMC output into an existing Obsidian vault path if the user already has one.

This is the more important path for the target user.

## Local vs Public Deployment Modes

### Local mode

Default:

- bind backend on `127.0.0.1`
- dashboard local only
- extension talks directly to local backend

### Public mode

Recommended:

- backend still binds on localhost
- Caddy reverse proxy handles TLS and public ingress
- extension uses `https://notes.example.com`

CLI direction:

```bash
tsmc service install --start
tsmc init-admin
tsmc token create --name chrome-extension
tsmc gateway enable --domain notes.example.com
```

`tsmc gateway enable` is a phase-2 command, not necessarily a first implementation target.

## Product Security Requirements

- passwords hashed with Argon2
- secure HTTP-only cookies
- CSRF protection for dashboard state-changing requests
- bearer tokens hashed at rest
- HTTPS required for remote extension sync
- rate limiting on auth endpoints
- audit log for token creation/revocation and login events
- minimum password rules
- one-command password reset through CLI for the self-hosted admin

## Recommended Rollout Plan

### Phase 1: Secure Foundation

- add users
- add dashboard session auth
- add extension app tokens
- add compatibility endpoint
- validate backend URL in extension settings
- require HTTPS for remote backend URLs

### Phase 2: Obsidian Vault and Search

- move from transcript-only Markdown to vault-aware notes
- add front matter and wikilinks
- add graph entity Markdown generation
- add SQLite FTS5 search
- add dashboard search and category views

### Phase 3: Dashboard Product Surface

- add observability home page
- add token management UI
- add graph view
- add settings UI

### Phase 4: Public Hosting UX

- integrate reverse proxy/TLS setup into CLI
- add safer internet-exposure checks
- harden auth and rate limits

## Final Recommendation

Build this as a Python-first self-hosted product with one packaged service and one packaged static dashboard.

Do not optimize first for Railway.

Do optimize first for:

- local Linux hosting
- secure remote extension sync
- Obsidian vault compatibility
- real Markdown knowledge graph files
- a simple but useful dashboard

That path matches both the current architecture and the user's actual workflow.

## References

- React 19.2 official release: https://react.dev/blog/2025/10/01/react-19-2
- Vite 8 official release: https://vite.dev/blog/announcing-vite8
- Next.js 15 official release: https://nextjs.org/blog/next-15
- Obsidian Help on local vaults and syncing: https://obsidian.md/help/sync-notes
- Obsidian Help home: https://obsidian.md/help/
- FastAPI security docs: https://fastapi.tiangolo.com/tutorial/security/
