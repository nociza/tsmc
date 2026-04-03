from __future__ import annotations

import json
from datetime import datetime, timezone
from hashlib import sha1
from typing import Any
from urllib.parse import urljoin, urlparse


def normalize_whitespace(value: str) -> str:
    return " ".join(value.split()).strip()


def resolve_captured_url(url: str, page_url: str) -> str | None:
    try:
        return urljoin(page_url, url)
    except Exception:
        return None


def safe_json_parse(text: str) -> Any | None:
    try:
        return json.loads(text)
    except Exception:
        return None


def extract_structured_candidates(value: Any) -> list[Any]:
    if not isinstance(value, str) or not value:
        return []

    candidates: list[Any] = []
    direct = safe_json_parse(value)
    if direct is not None:
        candidates.append(direct)

    for line in value.splitlines():
        trimmed = line.strip()
        if not trimmed:
            continue
        if trimmed.startswith("data:"):
            payload = trimmed[5:].strip()
            if payload and payload != "[DONE]":
                parsed = safe_json_parse(payload)
                if parsed is not None:
                    candidates.append(parsed)
            continue
        if trimmed.startswith("{") or trimmed.startswith("[") or trimmed.startswith("\"[{"):
            parsed = safe_json_parse(trimmed)
            if parsed is not None:
                candidates.append(parsed)
    return candidates


def collect_strings(value: Any, bucket: set[str] | None = None) -> list[str]:
    values = bucket or set()
    if isinstance(value, str):
        trimmed = value.strip()
        if trimmed:
            values.add(trimmed)
            parsed = safe_json_parse(trimmed)
            if parsed is not None:
                collect_strings(parsed, values)
        return list(values)

    if isinstance(value, list):
        for item in value:
            collect_strings(item, values)
        return list(values)

    if isinstance(value, dict):
        for nested in value.values():
            collect_strings(nested, values)
    return list(values)


def flatten_text(value: Any) -> str:
    if isinstance(value, str):
        return normalize_whitespace(value)
    if isinstance(value, list):
        return "\n".join(part for part in (flatten_text(item) for item in value) if part)
    if not isinstance(value, dict):
        return ""

    fragments: list[str] = []
    for key in ("text", "content", "body", "message", "value", "markdown", "parts", "chunks"):
        if key in value:
            fragment = flatten_text(value[key])
            if fragment:
                fragments.append(fragment)
    if fragments:
        return "\n".join(fragments)

    return "\n".join(
        normalize_whitespace(item)
        for item in collect_strings(value)[:3]
        if normalize_whitespace(item)
    )


def normalize_role(value: Any) -> str:
    role = value.lower() if isinstance(value, str) else ""
    if "user" in role or role == "human":
        return "user"
    if "assistant" in role or "model" in role or "bot" in role:
        return "assistant"
    if "system" in role:
        return "system"
    if "tool" in role:
        return "tool"
    return "unknown"


def coerce_occurred_at(value: Any) -> str | None:
    if isinstance(value, (int, float)):
        milliseconds = value if value > 10_000_000_000 else value * 1000
        try:
            return datetime.fromtimestamp(milliseconds / 1000, tz=timezone.utc).isoformat()
        except Exception:
            return None
    if isinstance(value, str) and value.strip():
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat()
        except Exception:
            try:
                parsed = datetime.strptime(value, "%Y-%m-%d %H:%M:%S")
                return parsed.replace(tzinfo=timezone.utc).isoformat()
            except Exception:
                return None
    return None


def find_string_by_keys(value: Any, keys: list[str]) -> str | None:
    if isinstance(value, list):
        for item in value:
            found = find_string_by_keys(item, keys)
            if found:
                return found
        return None
    if not isinstance(value, dict):
        return None

    for key in keys:
        candidate = value.get(key)
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()

    for nested in value.values():
        found = find_string_by_keys(nested, keys)
        if found:
            return found
    return None


def session_id_from_page_url(page_url: str) -> str | None:
    try:
        parsed = urlparse(page_url)
    except Exception:
        return None

    segments = [segment for segment in parsed.path.split("/") if segment]
    for index, segment in enumerate(segments):
        if segment in {"c", "chat", "conversation", "conversations", "app", "immersive"} and index + 1 < len(segments):
            return segments[index + 1]
    for segment in reversed(segments):
        if len(segment) >= 8:
            return segment
    return None


def pick_likely_text(strings: list[str], *, prefer_last: bool = True) -> str | None:
    candidates = [
        normalize_whitespace(value)
        for value in strings
        if isinstance(value, str)
    ]
    candidates = [
        value
        for value in candidates
        if value and any(char.isalpha() for char in value) and " " in value and len(value) >= 12
        and not value.startswith("http")
        and not (value.startswith("{") and value.endswith("}"))
        and not (value.startswith("[") and value.endswith("]"))
    ]
    if not candidates:
        return None

    scored: list[tuple[int, str]] = []
    total = len(candidates)
    for index, candidate in enumerate(candidates):
        whitespace_score = candidate.count(" ")
        position_score = index if prefer_last else total - index
        scored.append((len(candidate) + whitespace_score * 2 + position_score, candidate))
    scored.sort(key=lambda item: item[0], reverse=True)
    return scored[0][1]


def stable_id(prefix: str, source: str) -> str:
    return f"{prefix}-{sha1(source.encode('utf-8')).hexdigest()[:12]}"


def dedupe_messages(messages: list[Any]) -> list[Any]:
    seen: dict[str, Any] = {}
    for message in messages:
        content = getattr(message, "content", "") if not isinstance(message, dict) else message.get("content", "")
        if not isinstance(content, str) or not content.strip():
            continue
        identifier = getattr(message, "id", None) if not isinstance(message, dict) else message.get("id")
        if identifier is None:
            continue
        seen[str(identifier)] = message
    return list(seen.values())
