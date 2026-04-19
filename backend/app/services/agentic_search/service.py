from __future__ import annotations

import os
from uuid import uuid4

from google.adk.agents import Agent
from google.adk.apps import App
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from app.core.config import Settings, get_settings
from app.prompts import NOTE_SEARCH_AGENT_INSTRUCTION, render_note_search_request
from app.services.agentic_search.models import AgenticSearchCandidate, AgenticSearchResponse
from app.services.agentic_search.tools import VaultSearchADKTools, VaultSearchToolkit
from app.services.text import extract_json_object


class ADKVaultSearchService:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self.toolkit = VaultSearchToolkit(self.settings)
        self.tools = VaultSearchADKTools(self.toolkit)
        self._ensure_google_api_key()
        self.session_service = InMemorySessionService()
        self.agent = Agent(
            name="vault_search_agent",
            model=self.settings.google_model,
            description="Searches SaveMyContext's local note vault using tool calls.",
            instruction=NOTE_SEARCH_AGENT_INSTRUCTION,
            tools=[
                self.tools.grep_vault_content,
                self.tools.find_vault_paths,
                self.tools.read_vault_note,
            ],
            output_schema=AgenticSearchResponse,
            generate_content_config=types.GenerateContentConfig(
                temperature=0,
                response_mime_type="application/json",
            ),
        )
        self.app = App(name="savemycontext_vault_search", root_agent=self.agent)
        self.runner = Runner(
            app=self.app,
            session_service=self.session_service,
            auto_create_session=True,
        )

    @property
    def available(self) -> bool:
        return bool(self.settings.google_api_key)

    async def search(self, query: str, *, limit: int = 10) -> list[AgenticSearchCandidate]:
        cleaned_query = query.strip()
        if not cleaned_query or not self.available:
            return []

        session_id = f"vault-search-{uuid4().hex}"
        response_text = ""
        async for event in self.runner.run_async(
            user_id="vault-search",
            session_id=session_id,
            new_message=types.UserContent(
                parts=[types.Part.from_text(render_note_search_request(cleaned_query, limit=limit))]
            ),
        ):
            if event.error_message:
                raise RuntimeError(event.error_message)
            candidate_text = self._content_text(event.content)
            if event.author == self.agent.name and candidate_text:
                response_text = candidate_text

        if not response_text:
            return []

        parsed = AgenticSearchResponse.model_validate(extract_json_object(response_text))
        results: list[AgenticSearchCandidate] = []
        seen_paths: set[str] = set()
        for item in parsed.results:
            validated_path = self.toolkit.validate_note_path(item.path)
            if validated_path is None:
                continue
            normalized_path = str(validated_path)
            if normalized_path in seen_paths:
                continue
            seen_paths.add(normalized_path)
            results.append(
                AgenticSearchCandidate(
                    path=normalized_path,
                    reason=item.reason.strip() or "Matched the query in the local vault.",
                    snippet=item.snippet.strip(),
                )
            )
            if len(results) >= limit:
                break
        return results

    def _ensure_google_api_key(self) -> None:
        if self.settings.google_api_key:
            os.environ.setdefault("GOOGLE_API_KEY", self.settings.google_api_key)

    def _content_text(self, content: types.Content | None) -> str:
        if content is None or not content.parts:
            return ""
        parts: list[str] = []
        for part in content.parts:
            text = getattr(part, "text", None)
            if isinstance(text, str) and text.strip():
                parts.append(text.strip())
        return "\n".join(parts).strip()
