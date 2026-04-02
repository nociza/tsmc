from __future__ import annotations

import json
import re
from collections.abc import Iterable


WHITESPACE_RE = re.compile(r"\s+")
JSON_OBJECT_RE = re.compile(r"\{.*\}", re.DOTALL)
SENTENCE_BOUNDARY_RE = re.compile(r"(?<=[.!?])\s+")


def normalize_whitespace(value: str) -> str:
    return WHITESPACE_RE.sub(" ", value).strip()


def compact_lines(lines: Iterable[str]) -> list[str]:
    return [normalize_whitespace(line) for line in lines if normalize_whitespace(line)]


def take_sentences(value: str, limit: int) -> str:
    cleaned = normalize_whitespace(value)
    if not cleaned or limit <= 0:
        return ""

    sentences = [segment.strip() for segment in SENTENCE_BOUNDARY_RE.split(cleaned) if segment.strip()]
    if not sentences:
        return cleaned
    return " ".join(sentences[:limit])


def extract_json_object(text: str) -> dict:
    cleaned = text.strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        match = JSON_OBJECT_RE.search(cleaned)
        if not match:
            raise
        return json.loads(match.group(0))


def truncate_text(value: str, limit: int) -> str:
    cleaned = normalize_whitespace(value)
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: max(0, limit - 1)].rstrip() + "…"
