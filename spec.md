## Project Specification: SaveMyContext (SaveMyContext)

**Objective:** Build a unified "second brain" that automatically intercepts, stores, categorizes, and processes user chat sessions from major web-based AI platforms (ChatGPT, Gemini, Grok) into actionable notes, knowledge graphs, and shareable content.

### 1. Frontend: Chrome Extension (The Scraper)

The frontend acts as a silent observer, capturing the delta (diff) of conversations using network interception and a clean provider-based architecture.

* **Framework & Tooling:** TypeScript compiled via Vite for instantaneous Hot Module Replacement (HMR) during development.
* **Manifest Version:** Manifest V3 (MV3) for modern Chrome Web Store compliance.
* **Background Architecture:** Uses an MV3 Service Worker to listen to web requests and intercept the raw JSON payloads returning from the AI providers' internal APIs.
* **Provider Harness:** A clean, modular interface (`IProviderScraper`) allowing easy addition of new AIs. Currently supports:
    * **ChatGPT:** Intercepts `conversations` API endpoints.
    * **Gemini:** Intercepts Google's internal RPC/batched payload responses.
    * **Grok:** Intercepts xAI's chat API requests.
* **Sync Logic:** Captures only the newest messages (the diff) during an active session and POSTs them to the local FastAPI backend.

### 2. Backend: Core Infrastructure

The backend receives the raw chat diffs, stores them securely, and orchestrates the AI processing pipelines.

* **Framework:** FastAPI running on Uvicorn with `uvloop` for maximum asynchronous performance.
* **Dependency Management:** Managed via `uv` (by Astral) for lightning-fast, reproducible Python environments.
* **Primary Storage (Relational):** SQLite managed via an ORM (like SQLAlchemy or SQLModel). This keeps the local setup lightweight while making it trivial to update the connection string to PostgreSQL or MySQL later.
* **Secondary Storage (File System):** A dedicated directory of Markdown (`.md`) files. Every time a session is updated, the backend overwrites or appends to a cleanly formatted Markdown file for that specific session, ensuring the user always has local, vendor-independent access to their raw transcripts.

### 3. Backend: AI Processing & Abstraction

The backend doesn't just store data; it actively reads and organizes it using LLM APIs.

* **Provider Abstraction:** A unified Python wrapper that standardizes calls to the OpenAI API (ChatGPT) and Google GenAI API (Gemini) for backend processing tasks.
* **The Classifier:** When a new QA pair or session is ingested, a lightweight LLM call categorizes the interaction into one of three predefined buckets.
* **Custom Categories:** Users can define custom tags, but the system defaults to the three primary pipelines below.

### 4. The Pile Model

Each category is a **pile** — a first-class record (table `piles`) with a slug, a name, a `folder_label`, and a list of `attributes` that drive how the LLM pipeline processes the session.

* **Built-in piles** (seeded on first run, cannot be deleted):
    * `journal` — chronological + summary + queryable Q&A
    * `factual` — summary + knowledge graph extraction
    * `ideas` — summary + knowledge graph + share-post + alternate phrasings
    * `todo` — chronological + importance + deadline + completion (still updates the shared `Dashboards/To-Do List.md`)
    * `discarded` — chronological only; receives sessions captured-but-shelved (see § 6)
* **User-defined piles** — created via `POST /api/v1/piles` with a chosen attribute set. The generic attribute pipeline (`orchestrator.pile_outputs`) extracts whatever the attribute set requests and writes the result to `ChatSession.pile_outputs` JSON, which the markdown writer renders under `## Pile Outputs`.

Available attributes: `summary`, `chronological`, `queryable_qa`, `knowledge_graph`, `share_post`, `alternate_phrasings`, `importance`, `deadline`, `completion`.

### 5. The Processing Pipelines

Each classified session triggers a specific summarization and extraction pipeline.

* **Pipeline A: Journal (Personal & Day-to-Day)**
    * **Trigger:** Conversations about the user's life, daily tasks, or personal reflections.
    * **Action:** Summarizes the session into a concise diary-style entry.
    * **Output:** Saves to a "Journal" view, stripping out AI fluff and keeping the focus on the user's personal context and action items.
* **Pipeline B: Factual (Knowledge Graph)**
    * **Trigger:** Conversations seeking objective truths, coding help, historical facts, or scientific explanations.
    * **Action:** Runs an extraction prompt to pull out standard Subject-Predicate-Object triplets.
    * **Output:** Formats the data specifically for ingestion into a Knowledge Graph (e.g., mapping entities like "FastAPI" -> "uses" -> "uvloop").
* **Pipeline C: Ideas (Brainstorming & Ideation)**
    * **Trigger:** Original thoughts, creative writing, architectural brainstorming, or "what if" scenarios.
    * **Action:** Distills the creative session into a structured summary (Core Idea, Pros/Cons, Next Steps).
    * **Bonus Action (The Share Feature):** Automatically generates a concise, engaging "Tweet-like" post summarizing the core thesis of the brainstorm, ready for the user to copy and share on social media.

### 6. Discard System

Discards are a first-class concern: items are still captured (so you can recover them), but never reach the dashboard, never produce summaries, and never trigger notifications.

Three independent paths route a session to the `Discarded` pile:

1. **Discard words** (extension-side, default ON, default word `loom`). When the opening user request matches a discard word, the extension still ingests the session but tags the payload with `route_to_discard=true`. The backend short-circuits classification and stores the session under `Discarded/{YYYY}/...md`.
2. **LLM auto-discard categories**. The discarded pile's `pipeline_config.auto_discard_categories` is a list of natural-language category strings (e.g. `["small talk", "test sessions"]`). The classifier prompt is augmented with these so the LLM can choose to route the session to discarded.
3. **Manual discard**. `POST /api/v1/piles/discarded/sessions/{id}/discard` moves any session into the discarded pile.

Recovery: `POST /api/v1/piles/discarded/sessions/{id}/recover` clears the discard flag and re-runs the full classification pipeline. The corresponding markdown is moved out of `Discarded/` into the new pile's folder.
