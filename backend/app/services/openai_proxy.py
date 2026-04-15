from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TYPE_CHECKING
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import ChatSession, ProviderName
from app.models.enums import MessageRole
from app.schemas.ingest import IngestDiffRequest, IngestMessage
from app.schemas.openai_proxy import (
    ChatCompletionChoice,
    ChatCompletionChoiceMessage,
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatCompletionUsage,
    ProxyResponseMetadata,
)
from app.services.browser_proxy.providers import resolve_provider_adapter
from app.services.ingest import IngestService

if TYPE_CHECKING:
    from app.services.browser_proxy.service import BrowserProxyService


GENERIC_PAGE_TITLES = {
    "chatgpt",
    "gemini",
    "grok",
    "new chat",
}

FAST_PROXY_PREAMBLE = (
    "Respond directly and quickly. Do not use extended reasoning, chain-of-thought, or thinking mode "
    "unless the user explicitly asks for it."
)


@dataclass(frozen=True)
class TranscriptTurn:
    role: str
    content: str


class OpenAIProxyService:
    def __init__(self, db: AsyncSession, browser_proxy: BrowserProxyService) -> None:
        self.db = db
        self.browser_proxy = browser_proxy

    async def create_chat_completion(self, request: ChatCompletionRequest) -> ChatCompletionResponse:
        if request.stream:
            raise ValueError("Streaming is not supported yet for the browser proxy API.")

        adapter = resolve_provider_adapter(request.model)
        browser_prompt = self._build_browser_prompt(
            request.messages,
            continuing=bool(request.savemycontext_provider_session_url),
        )
        completion = await self.browser_proxy.complete(
            model=request.model,
            prompt_text=browser_prompt,
            provider_session_url=request.savemycontext_provider_session_url,
        )

        stored_session: ChatSession | None = None
        if request.store:
            stored_session = await self._store_completion(adapter.provider, completion, request)

        prompt_tokens = self._estimate_tokens(browser_prompt)
        completion_tokens = self._estimate_tokens(completion.response_text)
        return ChatCompletionResponse(
            id=f"chatcmpl_{uuid4().hex}",
            created=int(datetime.now(timezone.utc).timestamp()),
            model=adapter.canonical_model,
            choices=[
                ChatCompletionChoice(
                    index=0,
                    message=ChatCompletionChoiceMessage(content=completion.response_text),
                )
            ],
            usage=ChatCompletionUsage(
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=prompt_tokens + completion_tokens,
            ),
            savemycontext=ProxyResponseMetadata(
                provider=adapter.provider.value,
                provider_session_url=completion.provider_session_url,
                source_url=completion.source_url,
                title=completion.title,
                store=request.store,
                stored_session_id=stored_session.id if stored_session else None,
                stored_markdown_path=stored_session.markdown_path if stored_session else None,
            ),
        )

    def _build_browser_prompt(self, messages, *, continuing: bool) -> str:
        flattened = [TranscriptTurn(role=message.role, content=self._message_text(message)) for message in messages]
        if not flattened:
            raise ValueError("At least one message is required.")
        if flattened[-1].role != "user":
            raise ValueError("The final message must have role='user'.")

        if continuing:
            return f"{FAST_PROXY_PREAMBLE}\n\n{flattened[-1].content}"

        if len(flattened) == 1:
            return f"{FAST_PROXY_PREAMBLE}\n\n{flattened[0].content}"

        system_blocks = [turn.content for turn in flattened if turn.role == "system"]
        dialogue = [turn for turn in flattened if turn.role != "system"]
        lines = [
            FAST_PROXY_PREAMBLE,
            "",
            "Use the following prior conversation as context.",
        ]
        if system_blocks:
            lines.extend(["", "System instructions:"])
            lines.extend(system_blocks)
        lines.extend(["", "Conversation so far:"])
        for turn in dialogue:
            lines.append(f"{turn.role.upper()}: {turn.content}")
        lines.extend(["", "Reply to the final USER message naturally and continue the conversation."])
        return "\n".join(lines).strip()

    async def _store_completion(
        self,
        provider: ProviderName,
        completion,
        request: ChatCompletionRequest,
    ) -> ChatSession:
        adapter = resolve_provider_adapter(request.model)
        external_session_id = adapter.proxy_session_id_for_url(completion.provider_session_url)
        existing_session = await self._existing_session(provider, external_session_id)
        existing_turns = [
            TranscriptTurn(role=message.role.value, content=message.content)
            for message in existing_session.messages
        ] if existing_session else []
        request_turns = [TranscriptTurn(role=message.role, content=self._message_text(message)) for message in request.messages]
        combined_turns = self._merge_turns(existing_turns, request_turns)
        assistant_turn = TranscriptTurn(role="assistant", content=completion.response_text.strip())
        if not combined_turns or combined_turns[-1] != assistant_turn:
            combined_turns.append(assistant_turn)

        ingest_messages = self._build_ingest_messages(combined_turns)
        payload = IngestDiffRequest(
            provider=provider,
            external_session_id=external_session_id,
            sync_mode="full_snapshot",
            title=self._derive_title(completion.title, request_turns),
            source_url=completion.provider_session_url,
            captured_at=datetime.now(timezone.utc),
            custom_tags=["browser-proxy", "openai-client"],
            raw_capture=completion.raw_capture,
            messages=ingest_messages,
        )
        session, _ = await IngestService(self.db).ingest(payload)
        return session

    async def _existing_session(self, provider: ProviderName, external_session_id: str) -> ChatSession | None:
        result = await self.db.execute(
            select(ChatSession)
            .options(selectinload(ChatSession.messages))
            .where(
                ChatSession.provider == provider,
                ChatSession.external_session_id == external_session_id,
            )
        )
        return result.scalar_one_or_none()

    def _merge_turns(self, existing: list[TranscriptTurn], incoming: list[TranscriptTurn]) -> list[TranscriptTurn]:
        if not existing:
            return list(incoming)
        overlap = self._largest_suffix_prefix_overlap(existing, incoming)
        return [*existing, *incoming[overlap:]]

    def _largest_suffix_prefix_overlap(self, existing: list[TranscriptTurn], incoming: list[TranscriptTurn]) -> int:
        limit = min(len(existing), len(incoming))
        for size in range(limit, 0, -1):
            if existing[-size:] == incoming[:size]:
                return size
        return 0

    def _build_ingest_messages(self, turns: list[TranscriptTurn]) -> list[IngestMessage]:
        messages: list[IngestMessage] = []
        for index, turn in enumerate(turns, start=1):
            message_id = f"proxy-msg-{index:06d}"
            parent_id = f"proxy-msg-{index - 1:06d}" if index > 1 else None
            role = {
                "system": MessageRole.SYSTEM,
                "user": MessageRole.USER,
                "assistant": MessageRole.ASSISTANT,
                "tool": MessageRole.TOOL,
            }.get(turn.role, MessageRole.UNKNOWN)
            messages.append(
                IngestMessage(
                    external_message_id=message_id,
                    parent_external_message_id=parent_id,
                    role=role,
                    content=turn.content,
                )
            )
        return messages

    def _derive_title(self, page_title: str | None, request_turns: list[TranscriptTurn]) -> str:
        if page_title:
            normalized = page_title.strip()
            if normalized and normalized.lower() not in GENERIC_PAGE_TITLES:
                return normalized
        first_user = next((turn.content for turn in request_turns if turn.role == "user" and turn.content.strip()), "Browser Proxy Session")
        return first_user[:160]

    def _message_text(self, message) -> str:
        if isinstance(message.content, str):
            return message.content.strip()
        return "\n".join(part.text.strip() for part in message.content if part.text.strip())

    def _estimate_tokens(self, value: str) -> int:
        return max(1, math.ceil(len(value) / 4))
