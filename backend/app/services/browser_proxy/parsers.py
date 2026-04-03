from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qs, urlparse

from app.models.enums import ProviderName
from app.services.browser_proxy.helpers import (
    coerce_occurred_at,
    collect_strings,
    dedupe_messages,
    extract_structured_candidates,
    find_string_by_keys,
    flatten_text,
    normalize_role,
    pick_likely_text,
    resolve_captured_url,
    session_id_from_page_url,
    stable_id,
)
from app.services.browser_proxy.types import CapturedNetworkEvent, NormalizedMessage, NormalizedSessionSnapshot


def as_record(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def sort_messages(messages: list[NormalizedMessage]) -> list[NormalizedMessage]:
    indexed_messages = list(enumerate(messages))
    indexed_messages.sort(
        key=lambda item: (
            1 if item[1].occurred_at is None else 0,
            item[1].occurred_at or "",
            item[0],
        )
    )
    return [message for _, message in indexed_messages]


class ProviderParser:
    provider: ProviderName

    def matches(self, event: CapturedNetworkEvent) -> bool:
        raise NotImplementedError

    def parse(self, event: CapturedNetworkEvent) -> NormalizedSessionSnapshot | None:
        raise NotImplementedError


def build_chatgpt_message(record: dict[str, Any], fallback_parent: str | None = None) -> NormalizedMessage | None:
    content = flatten_text(record.get("content") or record.get("parts") or record.get("text") or record.get("message"))
    if not content:
        return None

    author = as_record(record.get("author")) or {}
    role = normalize_role(author.get("role") or record.get("role"))
    identifier = record.get("id") if isinstance(record.get("id"), str) else stable_id("chatgpt-msg", f"{role}:{content}")
    parent_id = (
        record.get("parent") if isinstance(record.get("parent"), str) else None
    ) or (
        record.get("parent_id") if isinstance(record.get("parent_id"), str) else None
    ) or fallback_parent
    return NormalizedMessage(
        id=identifier,
        parent_id=parent_id,
        role=role,  # type: ignore[arg-type]
        content=content,
        occurred_at=coerce_occurred_at(record.get("create_time") or record.get("createTime") or record.get("update_time")),
        raw=record,
    )


def extract_chatgpt_mapping(mapping: dict[str, Any]) -> list[NormalizedMessage]:
    messages: list[NormalizedMessage] = []
    for node in mapping.values():
        record = as_record(node)
        if record is None:
            continue
        message = as_record(record.get("message"))
        built = build_chatgpt_message(message, record.get("parent") if isinstance(record.get("parent"), str) else None) if message else None
        if built is not None:
            messages.append(built)
    return messages


class ChatGPTParser(ProviderParser):
    provider = ProviderName.CHATGPT

    def matches(self, event: CapturedNetworkEvent) -> bool:
        resolved = resolve_captured_url(event.url, event.page_url)
        if not resolved:
            return False
        parsed = urlparse(resolved)
        return any(host in (parsed.hostname or "") for host in ("chatgpt.com", "chat.openai.com")) and (
            "backend-api" in parsed.path or "conversation" in parsed.path
        )

    def parse(self, event: CapturedNetworkEvent) -> NormalizedSessionSnapshot | None:
        structured = [event.response.json, *extract_structured_candidates(event.response.text)]
        messages: list[NormalizedMessage] = []
        title: str | None = None
        external_session_id = (
            find_string_by_keys(structured, ["conversation_id", "conversationId"])
            or _extract_url_tail(event.url)
            or session_id_from_page_url(event.page_url)
            or stable_id("chatgpt-session", event.page_url)
        )

        for candidate in structured:
            record = as_record(candidate)
            if record is None:
                continue
            title = title or find_string_by_keys(record, ["title"])
            external_session_id = external_session_id or find_string_by_keys(record, ["conversation_id", "conversationId"])

            mapping = as_record(record.get("mapping"))
            if mapping is not None:
                messages.extend(extract_chatgpt_mapping(mapping))

            candidate_messages = record.get("messages")
            if isinstance(candidate_messages, list):
                for item in candidate_messages:
                    built = build_chatgpt_message(item) if isinstance(item, dict) else None
                    if built is not None:
                        messages.append(built)

            message_record = as_record(record.get("message"))
            if message_record is not None:
                built = build_chatgpt_message(
                    message_record,
                    find_string_by_keys(record, ["parent_message_id", "parent"]),
                )
                if built is not None:
                    messages.append(built)

        normalized = sort_messages(dedupe_messages(messages))
        if not normalized:
            return None

        return NormalizedSessionSnapshot(
            provider=self.provider,
            external_session_id=external_session_id,
            title=title,
            source_url=event.page_url,
            captured_at=event.captured_at,
            messages=normalized,
        )


def normalize_gemini_conversation_id(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    if not trimmed:
        return None
    return trimmed[2:] if trimmed.startswith("c_") else trimmed


def gemini_account_key_from_page_url(page_url: str) -> str:
    try:
        parsed = urlparse(page_url)
    except Exception:
        return "u0"
    segments = [segment for segment in parsed.path.split("/") if segment]
    if len(segments) >= 2 and segments[0] == "u" and segments[1].isdigit():
        return f"u{segments[1]}"
    return "u0"


def build_gemini_scoped_session_id(account_key: str, conversation_id: Any) -> str | None:
    normalized = normalize_gemini_conversation_id(conversation_id)
    if not normalized:
        return None
    return f"{account_key}__{normalized}"


def normalize_gemini_external_session_id(value: str) -> str | None:
    trimmed = value.strip()
    if not trimmed:
        return None
    if "__" in trimmed and trimmed.split("__", 1)[0].startswith("u"):
        account_key, conversation_id = trimmed.split("__", 1)
        return build_gemini_scoped_session_id(account_key, conversation_id)
    return build_gemini_scoped_session_id("u0", trimmed)


def build_gemini_explicit_message(item: Any, index: int, external_session_id: str) -> NormalizedMessage | None:
    record = as_record(item)
    if record is None:
        return None
    parts = record.get("parts")
    content_candidate = (
        record.get("content")
        if isinstance(record.get("content"), str)
        else record.get("text")
        if isinstance(record.get("text"), str)
        else "\n".join(part for part in parts if isinstance(part, str))
        if isinstance(parts, list)
        else ""
    )
    content = content_candidate.strip() if isinstance(content_candidate, str) else ""
    if not content:
        return None
    role = record.get("role") if record.get("role") in {"user", "assistant", "system", "tool"} else "unknown"
    identifier = record.get("id") if isinstance(record.get("id"), str) and record.get("id").strip() else stable_id(
        "gemini-msg",
        f"{external_session_id}:{role}:{index}:{content}",
    )
    parent_id = record.get("parentId") if isinstance(record.get("parentId"), str) and record.get("parentId").strip() else None
    return NormalizedMessage(
        id=identifier,
        parent_id=parent_id,
        role=role,  # type: ignore[arg-type]
        content=content,
        occurred_at=coerce_occurred_at(
            record.get("occurredAt") or record.get("occurred_at") or record.get("createdAt") or record.get("create_time")
        ),
        raw=record,
    )


def parse_gemini_request_candidates(event: CapturedNetworkEvent) -> list[Any]:
    candidates: list[Any] = []
    if event.request_body is not None:
        if event.request_body.json is not None:
            candidates.append(event.request_body.json)
        if event.request_body.text:
            candidates.extend(extract_structured_candidates(event.request_body.text))
            try:
                params = parse_qs(event.request_body.text, keep_blank_values=True)
                encoded = params.get("f.req", [None])[0]
                if encoded:
                    parsed = safe_json_parse_string(encoded)
                    if parsed is not None:
                        candidates.append(parsed)
            except Exception:
                pass
    return [candidate for candidate in candidates if candidate is not None]


def safe_json_parse_string(value: str) -> Any | None:
    try:
        return json.loads(value)
    except Exception:
        return None


class GeminiParser(ProviderParser):
    provider = ProviderName.GEMINI

    def matches(self, event: CapturedNetworkEvent) -> bool:
        resolved = resolve_captured_url(event.url, event.page_url)
        if not resolved:
            return False
        parsed = urlparse(resolved)
        target = parsed.path + (f"?{parsed.query}" if parsed.query else "")
        return "gemini.google.com" in (parsed.hostname or "") and any(
            token.lower() in target.lower()
            for token in ("batchexecute", "BardFrontendService", "StreamGenerate", "conversation")
        )

    def parse(self, event: CapturedNetworkEvent) -> NormalizedSessionSnapshot | None:
        request_candidates = parse_gemini_request_candidates(event)
        response_candidates = [candidate for candidate in [event.response.json, *extract_structured_candidates(event.response.text)] if candidate is not None]
        title = (
            find_string_by_keys(response_candidates, ["title", "conversationTitle"])
            or find_string_by_keys(request_candidates, ["title", "conversationTitle"])
        )
        explicit_external_session_id = normalize_gemini_external_session_id(
            find_string_by_keys(response_candidates, ["externalSessionId", "external_session_id"])
            or find_string_by_keys(request_candidates, ["externalSessionId", "external_session_id"])
            or ""
        )
        account_key = gemini_account_key_from_page_url(event.page_url)
        conversation_id = (
            normalize_gemini_conversation_id(find_string_by_keys(response_candidates, ["conversationId", "conversation_id", "chat_id"]))
            or normalize_gemini_conversation_id(find_string_by_keys(request_candidates, ["conversationId", "conversation_id", "chat_id"]))
            or normalize_gemini_conversation_id(session_id_from_page_url(event.page_url))
        )
        external_session_id = (
            explicit_external_session_id
            or (build_gemini_scoped_session_id(account_key, conversation_id) if conversation_id else None)
            or stable_id("gemini-session", event.page_url)
        )

        explicit_messages = sort_messages(
            dedupe_messages(
                [
                    built
                    for candidate in response_candidates
                    for built in _gemini_candidate_messages(candidate, external_session_id)
                    if built is not None
                ]
            )
        )
        if explicit_messages:
            return NormalizedSessionSnapshot(
                provider=self.provider,
                external_session_id=external_session_id,
                title=title,
                source_url=event.page_url,
                captured_at=event.captured_at,
                messages=explicit_messages,
            )

        prompt = pick_likely_text([item for value in request_candidates for item in collect_strings(value)], prefer_last=False)
        reply = pick_likely_text([item for value in response_candidates for item in collect_strings(value)], prefer_last=True)
        messages: list[NormalizedMessage] = []
        if prompt:
            messages.append(
                NormalizedMessage(
                    id=stable_id("gemini-user", f"{event.request_id}:{prompt}"),
                    role="user",
                    content=prompt,
                    occurred_at=event.captured_at,
                    raw=request_candidates[0] if request_candidates else None,
                )
            )
        if reply:
            messages.append(
                NormalizedMessage(
                    id=stable_id("gemini-assistant", f"{event.request_id}:{reply}"),
                    role="assistant",
                    content=reply,
                    occurred_at=event.captured_at,
                    raw=response_candidates[0] if response_candidates else None,
                )
            )
        if not messages:
            return None
        return NormalizedSessionSnapshot(
            provider=self.provider,
            external_session_id=external_session_id,
            title=title,
            source_url=event.page_url,
            captured_at=event.captured_at,
            messages=sort_messages(messages),
        )


def _gemini_candidate_messages(candidate: Any, external_session_id: str) -> list[NormalizedMessage]:
    record = as_record(candidate)
    if record is None:
        return []
    messages = record.get("messages")
    if not isinstance(messages, list):
        return []
    built_messages: list[NormalizedMessage] = []
    for index, message in enumerate(messages):
        built = build_gemini_explicit_message(message, index, external_session_id)
        if built is not None:
            built_messages.append(built)
    return built_messages


def build_grok_explicit_message(item: Any, index: int, external_session_id: str) -> NormalizedMessage | None:
    record = as_record(item)
    if record is None:
        return None
    role = normalize_role(record.get("role") or record.get("sender") or record.get("author"))
    content = flatten_text(record.get("content") or record.get("message") or record.get("query") or record.get("text") or record.get("body"))
    if not content:
        return None
    identifier = record.get("id") if isinstance(record.get("id"), str) and record.get("id").strip() else stable_id(
        "grok-msg",
        f"{external_session_id}:{role}:{index}:{content}",
    )
    parent_id = (
        record.get("parentId") if isinstance(record.get("parentId"), str) and record.get("parentId").strip() else None
    ) or (
        record.get("parentResponseId") if isinstance(record.get("parentResponseId"), str) and record.get("parentResponseId").strip() else None
    ) or (
        record.get("parent_id") if isinstance(record.get("parent_id"), str) and record.get("parent_id").strip() else None
    ) or (
        record.get("threadParentId") if isinstance(record.get("threadParentId"), str) and record.get("threadParentId").strip() else None
    )
    return NormalizedMessage(
        id=identifier,
        parent_id=parent_id,
        role=role,  # type: ignore[arg-type]
        content=content,
        occurred_at=coerce_occurred_at(record.get("occurredAt") or record.get("occurred_at") or record.get("createdAt") or record.get("createTime")),
        raw=record,
    )


def build_grok_generic_message(value: Any) -> NormalizedMessage | None:
    record = as_record(value)
    if record is None:
        return None
    role = normalize_role(record.get("role") or record.get("sender") or record.get("author"))
    content = flatten_text(record.get("content") or record.get("text") or record.get("body") or record.get("message"))
    if not content:
        return None
    occurred_at = None
    if isinstance(record.get("createdAt"), str):
        occurred_at = record["createdAt"]
    elif isinstance(record.get("created_at"), str):
        occurred_at = record["created_at"]
    return NormalizedMessage(
        id=record.get("id") if isinstance(record.get("id"), str) else stable_id("grok-msg", f"{role}:{content}"),
        parent_id=record.get("parentId") if isinstance(record.get("parentId"), str) else record.get("parent_id") if isinstance(record.get("parent_id"), str) else None,
        role=role,  # type: ignore[arg-type]
        content=content,
        occurred_at=occurred_at,
        raw=record,
    )


class GrokParser(ProviderParser):
    provider = ProviderName.GROK

    def matches(self, event: CapturedNetworkEvent) -> bool:
        resolved = resolve_captured_url(event.url, event.page_url)
        if not resolved:
            return False
        parsed = urlparse(resolved)
        target = parsed.path + (f"?{parsed.query}" if parsed.query else "")
        return any(host in (parsed.hostname or "") for host in ("grok.com", "x.com")) and any(
            token in target.lower() for token in ("app-chat", "conversation", "grok", "chat")
        )

    def parse(self, event: CapturedNetworkEvent) -> NormalizedSessionSnapshot | None:
        request_candidates = [candidate for candidate in [event.request_body.json if event.request_body else None] if candidate is not None]
        if event.request_body and event.request_body.text:
            request_candidates.extend(extract_structured_candidates(event.request_body.text))
        response_candidates = [candidate for candidate in [event.response.json, *extract_structured_candidates(event.response.text)] if candidate is not None]
        structured = [*request_candidates, *response_candidates]

        title = find_string_by_keys(structured, ["title", "conversationTitle"])
        external_session_id = (
            find_string_by_keys(structured, ["conversationId", "conversation_id"])
            or _extract_url_tail(event.url)
            or session_id_from_page_url(event.page_url)
            or stable_id("grok-session", event.page_url)
        )

        explicit_messages = sort_messages(
            dedupe_messages(
                [
                    built
                    for candidate in response_candidates
                    for built in _grok_candidate_messages(candidate, external_session_id)
                    if built is not None
                ]
            )
        )
        if explicit_messages:
            return NormalizedSessionSnapshot(
                provider=self.provider,
                external_session_id=external_session_id,
                title=title,
                source_url=event.page_url,
                captured_at=event.captured_at,
                messages=explicit_messages,
            )

        messages: list[NormalizedMessage] = []
        for candidate in structured:
            record = as_record(candidate)
            if record is None:
                continue
            title = title or find_string_by_keys(record, ["title", "conversationTitle"])
            for key in ("messages", "items", "conversationItems", "entries"):
                value = record.get(key)
                if isinstance(value, list):
                    for item in value:
                        built = build_grok_generic_message(item)
                        if built is not None:
                            messages.append(built)
            direct = build_grok_generic_message(record.get("message") or record)
            if direct is not None:
                messages.append(direct)

        if not messages:
            prompt = pick_likely_text([item for value in request_candidates for item in collect_strings(value)], prefer_last=False)
            reply = pick_likely_text([item for value in response_candidates for item in collect_strings(value)], prefer_last=True)
            if prompt:
                messages.append(
                    NormalizedMessage(
                        id=stable_id("grok-user", f"{event.request_id}:{prompt}"),
                        role="user",
                        content=prompt,
                        occurred_at=event.captured_at,
                        raw=request_candidates[0] if request_candidates else None,
                    )
                )
            if reply:
                messages.append(
                    NormalizedMessage(
                        id=stable_id("grok-assistant", f"{event.request_id}:{reply}"),
                        role="assistant",
                        content=reply,
                        occurred_at=event.captured_at,
                        raw=response_candidates[0] if response_candidates else None,
                    )
                )

        normalized = sort_messages(dedupe_messages(messages))
        if not normalized:
            return None
        return NormalizedSessionSnapshot(
            provider=self.provider,
            external_session_id=external_session_id,
            title=title,
            source_url=event.page_url,
            captured_at=event.captured_at,
            messages=normalized,
        )


def _grok_candidate_messages(candidate: Any, external_session_id: str) -> list[NormalizedMessage]:
    record = as_record(candidate)
    if record is None:
        return []
    messages = record.get("messages")
    if not isinstance(messages, list):
        return []
    built_messages: list[NormalizedMessage] = []
    for index, message in enumerate(messages):
        built = build_grok_explicit_message(message, index, external_session_id)
        if built is not None:
            built_messages.append(built)
    return built_messages


def _extract_url_tail(url: str) -> str | None:
    try:
        parsed = urlparse(url)
    except Exception:
        return None
    segments = [segment for segment in parsed.path.split("/") if segment]
    return segments[-1] if segments else None


PARSER_REGISTRY: dict[ProviderName, ProviderParser] = {
    ProviderName.CHATGPT: ChatGPTParser(),
    ProviderName.GEMINI: GeminiParser(),
    ProviderName.GROK: GrokParser(),
}
