# TSMC Agentic System Design

## Goal

TSMC should be easy for another tool or agent to operate without scraping logs, guessing paths, or reverse-engineering backend behavior.

The implemented design uses:

- a machine-readable capability endpoint
- deterministic CLI commands with optional JSON output
- bearer app tokens for remote automation
- stable REST endpoints for ingest, search, graph, and system status
- vault-native Markdown output that agents can read directly from disk

## Current Contract

### Bootstrap

1. Install the service CLI:

```bash
uv tool install tsmc-server
```

2. Start the backend locally:

```bash
tsmc run
```

3. Create the first admin:

```bash
tsmc init-admin --username admin
```

4. Create an app token for the extension or another agent:

```bash
tsmc token create --name chrome-extension --scope ingest --scope read --json
```

The `--json` form is intentional. It gives another agent a stable parse target.

### Capability discovery

Agents should call:

```text
GET /api/v1/meta/capabilities
```

This returns:

- product identity
- backend version
- minimum extension version
- auth mode
- enabled features
- storage roots

It is the first call the Chrome extension uses before saving a backend URL.

### Auth model

- Local loopback requests can operate without a token.
- Remote requests require an app token.
- App tokens are bearer tokens with explicit scopes.

Current scopes:

- `ingest`
- `read`
- `admin`

Token verification lives at:

```text
GET /api/v1/auth/token/verify
```

## Agent-friendly APIs

### Ingest

```text
POST /api/v1/ingest/diff
```

- accepts incremental or full-snapshot sync
- idempotent on message IDs
- updates session metadata and Markdown output

### Search

```text
GET /api/v1/search?q=sqlite
```

- returns structured session and entity hits
- includes category, provider, and note path

### Graph

```text
GET /api/v1/graph/nodes
GET /api/v1/graph/edges
```

- exposes the factual graph as stable JSON
- keeps the graph readable by agents without parsing Markdown

### System and summary

```text
GET /api/v1/system/status
GET /api/v1/dashboard/summary
```

- exposes totals, paths, auth mode, and activity
- useful for health checks and orchestration

## Vault Layout

TSMC writes a managed vault tree under the configured Markdown root:

```text
<markdown_root>/
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

This is designed so that:

- Obsidian can open it as-is
- OpenClaw can read the generated files directly
- another agent can traverse the filesystem deterministically

## Why this works well for agents

- Capability discovery is explicit.
- Auth is separate from human passwords.
- Commands are stable and scriptable.
- Search and graph data are exposed both as JSON and as files.
- Notes use front matter and wikilinks instead of ad hoc prose-only exports.

## Remaining work

The current implementation establishes the production foundation, but a few larger product surfaces are still future work:

- a dedicated web dashboard UI
- session-cookie auth for that dashboard
- richer full-text search indexing
- CLI-managed public reverse proxy and TLS setup
