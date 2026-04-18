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
    DISCARDED = "discarded"


class PileKind(StrEnum):
    BUILT_IN_JOURNAL = "built_in_journal"
    BUILT_IN_FACTUAL = "built_in_factual"
    BUILT_IN_IDEAS = "built_in_ideas"
    BUILT_IN_TODO = "built_in_todo"
    BUILT_IN_DISCARDED = "built_in_discarded"
    USER_DEFINED = "user_defined"


BUILT_IN_PILE_KINDS = frozenset(
    {
        PileKind.BUILT_IN_JOURNAL,
        PileKind.BUILT_IN_FACTUAL,
        PileKind.BUILT_IN_IDEAS,
        PileKind.BUILT_IN_TODO,
        PileKind.BUILT_IN_DISCARDED,
    }
)


class MessageRole(StrEnum):
    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"
    TOOL = "tool"
    UNKNOWN = "unknown"
