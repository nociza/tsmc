from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


OpenAIMessageRole = Literal["system", "user", "assistant", "tool"]


class ChatCompletionContentPart(BaseModel):
    type: Literal["text"]
    text: str = Field(min_length=1)


class ChatCompletionMessage(BaseModel):
    role: OpenAIMessageRole
    content: str | list[ChatCompletionContentPart]
    name: str | None = None

    @model_validator(mode="after")
    def validate_content(self) -> "ChatCompletionMessage":
        if isinstance(self.content, str):
            if not self.content.strip():
                raise ValueError("Message content must not be empty.")
            return self

        flattened = "".join(part.text for part in self.content).strip()
        if not flattened:
            raise ValueError("Message content must not be empty.")
        return self


class ChatCompletionRequest(BaseModel):
    model: str = Field(min_length=1)
    messages: list[ChatCompletionMessage] = Field(min_length=1)
    stream: bool = False
    store: bool = False
    temperature: float | None = None
    max_tokens: int | None = Field(default=None, ge=1)
    metadata: dict[str, Any] | None = None
    user: str | None = None
    tsmc_provider_session_url: str | None = None


class ChatCompletionChoiceMessage(BaseModel):
    role: Literal["assistant"] = "assistant"
    content: str


class ChatCompletionChoice(BaseModel):
    index: int
    message: ChatCompletionChoiceMessage
    finish_reason: Literal["stop"] = "stop"


class ChatCompletionUsage(BaseModel):
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


class ProxyResponseMetadata(BaseModel):
    provider: Literal["chatgpt", "gemini", "grok"]
    provider_session_url: str
    source_url: str
    title: str | None = None
    store: bool
    stored_session_id: str | None = None
    stored_markdown_path: str | None = None


class ChatCompletionResponse(BaseModel):
    id: str
    object: Literal["chat.completion"] = "chat.completion"
    created: int
    model: str
    choices: list[ChatCompletionChoice]
    usage: ChatCompletionUsage
    tsmc: ProxyResponseMetadata


class ModelDescription(BaseModel):
    id: str
    object: Literal["model"] = "model"
    created: int
    owned_by: str = "tsmc"


class ModelListResponse(BaseModel):
    object: Literal["list"] = "list"
    data: list[ModelDescription]


class BrowserLoginResult(BaseModel):
    provider: Literal["chatgpt", "gemini", "grok"]
    launched_at: datetime
    profile_dir: str
    start_url: str
