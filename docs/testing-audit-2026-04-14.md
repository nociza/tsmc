# Testing Audit 2026-04-14

This file tracks issues found during the live processing and vault-quality audit.

## Findings

- [fixed] Backend config ignores `OPENAI_API_KEY` from `backend/.env`.
  Evidence: `uv run python - <<'PY' ... get_settings().openai_api_key ... PY` reported `False` even though `backend/.env` contains `OPENAI_API_KEY=...`.
  Impact: live classification and processing silently fall back away from the configured OpenRouter key.
  Resolution: added dotenv loading plus generic `OPENAI_*` and `OPENROUTER_*` aliases, then verified the runtime resolves the OpenRouter key from `backend/.env`.

- [fixed] OpenRouter users are not given sane defaults when they only provide an OpenRouter key.
  Evidence: the backend defaulted to `https://api.openai.com/v1` and `gpt-5-mini`, which is not a valid default pairing for an OpenRouter key-only setup.
  Impact: live processing fails or points at the wrong provider unless the user manually discovers extra settings.
  Resolution: OpenRouter-style keys now auto-resolve to `https://openrouter.ai/api/v1` and `openai/gpt-4.1-mini` unless the user overrides them.

- [fixed] The OpenAI-compatible JSON path is brittle.
  Evidence: the client sends plain chat completions and then relies on best-effort JSON extraction with no structured-output retry path.
  Impact: classification, notes, and share-post generation can fail intermittently on valid providers and models.
  Resolution: the client now requests JSON mode first, retries without `response_format` when providers reject it, and handles segmented message content safely.

- [fixed] The automated test suite did not cover the live `.env` configuration path.
  Evidence: backend unit tests passed while the actual runtime settings still failed to load the user's configured API key.
  Impact: green CI does not currently guarantee a working local deployment.
  Resolution: added regression coverage for generic `OPENAI_*` env names and OpenRouter default resolution.

- [fixed] Personal planning conversations can be misclassified as `todo` and modify the shared to-do list.
  Evidence: the live OpenRouter audit classified "Plan tomorrow after a scattered day" as `todo` and added three items into the shared to-do markdown file.
  Impact: normal journal/planning sessions can corrupt the shared task list.
  Resolution: `todo` is now allowed only for explicit shared-list edit requests, with a classification guard that remaps false-positive `todo` results back through the heuristic classifier.

- [fixed] Vault wiki links are rooted from the parent markdown directory instead of the Obsidian vault root.
  Evidence: generated links looked like `[[TSMC/Factual/...]]` even though `TSMC/` is already the vault root directory.
  Impact: links are incorrect inside Obsidian and make the knowledge graph/navigation less usable.
  Resolution: wiki links are now generated relative to the vault root, so links resolve correctly inside Obsidian.

- [fixed] Idea notes are still rendered as raw JSON blocks.
  Evidence: the live ideas session exported a large fenced JSON blob instead of readable sections for the idea, pros/cons, and next steps.
  Impact: notes are harder to read, share, and maintain.
  Resolution: idea notes now render as readable sections with `Core Idea`, `Pros`, `Cons`, and `Next Steps`.

- [fixed] Share-post quality is still too marketing-shaped for a builder-facing output.
  Evidence: the live ideas sample produced phrases like `privately and effortlessly` and `Unlock the value hidden in your conversations`.
  Impact: the output is less credible and less shareable than it should be.
  Resolution: tightened the ideas prompt to avoid hype language and require a concrete, builder-style share post.

- [fixed] Factual session notes can omit their own extracted triplets.
  Evidence: the live factual graph notes and relationship index were populated, but the session markdown note ended immediately after the transcript without a `Fact Triplets` section.
  Impact: the factual note and the graph can diverge, which makes the session note look incomplete and hides the extracted structure from the reader.
  Resolution: the triplet replacement path now repopulates the in-memory session relationship before export, and the factual note regression is covered by tests.

- [fixed] The popup can keep showing a stale AI processing failure even after the queue is empty.
  Evidence: `GET_STATUS` refreshed the backend processing status but preserved `processingLastError`, so the popup could still show `Failed: ... task_1, task_2` with `Pending AI Jobs = 0`.
  Impact: users see a false failure state and cannot tell whether processing is actually blocked.
  Resolution: status refresh now clears the stored processing error when the backend reports no pending jobs.

- [fixed] A batched browser-processing reply that omits one task could fail the entire run.
  Evidence: the processing normalizer required exact coverage of every `task_key`, so a two-task batch that returned only one valid result surfaced `The reply must include exactly these task_keys or session_ids: task_1, task_2.`
  Impact: one missing task result could block all progress even when part of the batch was valid.
  Resolution: the extension now salvages valid partial batch results, completes the matching subset, and then continues processing the remaining queued tasks in a subsequent request.

## Verification

- Backend tests: `uv run pytest` -> `61 passed`
- Extension unit tests: `pnpm test` -> `30 passed`
- Extension unit tests: `pnpm test` -> `31 passed`
- Extension typecheck: `pnpm typecheck` -> passed
- Extension e2e: `pnpm test:e2e` -> `11 passed`
- Live OpenRouter audit: verified journal, factual, ideas, and todo samples end to end against a fresh temp database and vault
  Results:
  `OPENAI_API_KEY` from `backend/.env` was loaded successfully
  `journal` no longer polluted the shared to-do list
  `ideas` produced a readable note and a credible share post
  factual markdown notes now include `Fact Triplets` and `Related Entities`
  git created a new commit on each vault update
