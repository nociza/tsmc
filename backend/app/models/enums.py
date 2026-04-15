from __future__ import annotations

from enum import StrEnum


class ProviderName(StrEnum):
    CHATGPT = "chatgpt"
    GEMINI = "gemini"
    GROK = "grok"


class SessionCategory(StrEnum):
    JOURNAL = "journal"
    FACTUAL = "factual"
    IDEAS = "ideas"
    TODO = "todo"


class MessageRole(StrEnum):
    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"
    TOOL = "tool"
    UNKNOWN = "unknown"
