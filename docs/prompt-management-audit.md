---
title: Prompt Management Audit
---

# Prompt Management Audit

Audit date: 2026-04-19

## Scope

This audit covers the current prompt-management surface, the new vault-search direction, and the surrounding code organization that affects prompt iteration.

## Current state

The prompt surface is not fully scattered, but it is not centralized either.

- `backend/app/services/orchestrator.py` owns most of the classification and extraction prompts, plus the built-in pile rules.
- `backend/app/services/source_capture.py` contains the source-capture cleanup and classification prompt inline.
- `backend/app/services/processing_worker.py` contains the browser-worker batch prompt inline.
- `backend/app/services/llm/browser_proxy_client.py` wraps every task in its own transport-specific prompt shell and repair prompt.
- `backend/app/services/openai_proxy.py` owns a separate browser proxy preamble.
- `extension/src/piles/main.tsx` exposes only a narrow prompt editing surface through `custom_prompt_addendum` and discard-category text fields.

The good part is that the transport boundary is already fairly clean: backend callers mostly rely on `LLMClient.generate_json(...)`, which means model swapping is easier than prompt swapping. The weak part is prompt ownership: prompt text still lives beside orchestration logic, which makes iteration, review, and user customization harder than it should be.

## What changed in this pass

The vault search path now has a dedicated prompt layer and a dedicated agent package instead of another inline string inside `search.py`.

- `backend/app/prompts/agentic_search.py` holds the ADK search instruction and request renderer.
- `backend/app/services/agentic_search/` holds the ADK agent service, typed models, and read-only tool wrappers.
- `backend/app/services/search.py` uses the ADK agent first when Google is configured, then falls back to deterministic grep/ripgrep path and content search.

This is a better pattern to repeat elsewhere.

## Answers

### Is the prompt littered everywhere?

Not everywhere, but it is fragmented across several backend services. The main clustering is good enough to work in today, but not good enough for fast iteration or safe prompt experimentation.

### Is it easy to modify and iterate on?

Only for an engineer who already knows the service graph. There is no prompt registry, no versioning layer, no prompt preview, and no evaluation harness wired to prompt changes. Small edits are easy. Systematic iteration is not.

### In the future what might let users change prompts themselves via the interface?

The clean path is:

1. Add a `PromptTemplate` model with fields like `key`, `scope`, `version`, `system_template`, `user_template`, `variables_schema`, and `enabled`.
2. Keep code-owned defaults in `backend/app/prompts/`.
3. Let the database store overrides by scope: global, pile, source-capture, worker, search.
4. Add an admin-facing settings UI with preview, revert-to-default, and variable validation.
5. Add side-by-side dry-run and eval fixtures before an override goes live.

The existing `custom_prompt_addendum` field is a small starting point, but it is not enough for full prompt management.

### Is it abstracted out enough so that it's easy to implement?

Partly.

- Model transport abstraction: yes.
- Prompt composition abstraction: no.
- Prompt storage and versioning abstraction: no.
- UI abstraction for user editing: only partially, and only for pile addenda.

### Is it clean? Is the interface clean or is it just jumbled everywhere?

The backend is mostly understandable, but prompt and orchestration responsibilities are mixed. The extension is feature-sliced well enough, though some screens are getting too large to stay easy to reason about.

- `backend/app/services/orchestrator.py` is already large enough that classification policy, prompt text, and post-validation are competing in one file.
- `extension/src/piles/main.tsx` is large but still coherent.
- `extension/src/category/main.tsx` is very large and likely wants splitting by workspace/view model/component boundary.

### Are the file structure well organized?

Mostly yes.

- `backend/app/api`, `models`, `schemas`, and `services` are laid out sensibly.
- The extension is mostly organized by feature.
- The missing layer is a first-class prompt package for all prompt-bearing flows, not just the new search agent.

### Is the separation of responsibilities very clear so everyone knows what they are seeing?

Mostly, until prompts enter the picture. Service ownership is fairly clear. Prompt ownership is not. The new ADK search package improves that by separating:

- prompt text
- tool adapters
- agent runner
- search result integration

That same split should be applied to the processing flows next.

## Recommendations

### Near term

1. Move orchestration prompts out of `backend/app/services/orchestrator.py` into `backend/app/prompts/processing.py`.
2. Move source-capture prompts out of `backend/app/services/source_capture.py` into `backend/app/prompts/source_capture.py`.
3. Move worker and browser-proxy wrapper prompts into `backend/app/prompts/worker.py` and `backend/app/prompts/browser_proxy.py`.
4. Introduce a small prompt registry keyed by stable ids such as `processing.classify`, `processing.segment`, `capture.enrich`, and `search.vault`.

### Medium term

1. Add persisted prompt overrides with explicit scope and versioning.
2. Add prompt-preview endpoints and fixture-driven evals.
3. Expand the piles UI into a prompt editor that edits structured prompt sections instead of one freeform addendum.
4. Split very large extension screens into route-level containers plus smaller presentational components.

### Guardrails

1. Keep the search agent read-only. Search does not need filesystem write tools.
2. Keep tool wrappers narrow and typed. Avoid handing the agent unrestricted shell execution.
3. Make every prompt override observable in logs and easy to roll back.

