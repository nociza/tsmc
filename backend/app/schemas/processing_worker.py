from __future__ import annotations

from pydantic import BaseModel, Field, model_validator

from app.models.enums import ProviderName, SessionCategory
from app.schemas.processing import IdeaResult, JournalResult, TodoResult, TripletResult


class SessionPipelineResult(BaseModel):
    category: SessionCategory
    classification_reason: str = Field(min_length=1)
    journal: JournalResult | None = None
    todo: TodoResult | None = None
    factual_triplets: list[TripletResult] = Field(default_factory=list)
    idea: IdeaResult | None = None

    @model_validator(mode="after")
    def validate_category_payload(self) -> "SessionPipelineResult":
        if self.category == SessionCategory.JOURNAL and self.journal is None:
            raise ValueError("journal is required when category='journal'.")
        if self.category == SessionCategory.TODO and self.todo is None:
            raise ValueError("todo is required when category='todo'.")
        if self.category == SessionCategory.IDEAS and self.idea is None:
            raise ValueError("idea is required when category='ideas'.")
        if self.category != SessionCategory.JOURNAL and self.journal is not None:
            raise ValueError("journal must be null unless category='journal'.")
        if self.category != SessionCategory.TODO and self.todo is not None:
            raise ValueError("todo must be null unless category='todo'.")
        if self.category != SessionCategory.IDEAS and self.idea is not None:
            raise ValueError("idea must be null unless category='ideas'.")
        if self.category != SessionCategory.FACTUAL and self.factual_triplets:
            raise ValueError("factual_triplets must be empty unless category='factual'.")
        return self


class ProcessingTaskItem(BaseModel):
    task_key: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    source_provider: ProviderName | None = None
    source_session_id: str | None = None
    title: str | None = None


class ProcessingStatusResponse(BaseModel):
    enabled: bool
    mode: str
    worker_model: str | None = None
    pending_count: int = 0


class ProcessingTaskResponse(BaseModel):
    available: bool
    tasks: list[ProcessingTaskItem] = Field(default_factory=list)
    task_count: int = 0
    prompt: str | None = None
    worker_model: str | None = None

    @model_validator(mode="after")
    def validate_available_payload(self) -> "ProcessingTaskResponse":
        if self.available and (not self.tasks or not self.prompt):
            raise ValueError("tasks and prompt are required when available=true.")
        if not self.available and self.tasks:
            raise ValueError("tasks must be empty when available=false.")
        self.task_count = len(self.tasks)
        return self


class ProcessingResultItem(SessionPipelineResult):
    session_id: str | None = None
    task_key: str | None = None


class ProcessingResultEnvelope(BaseModel):
    results: list[ProcessingResultItem] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_results(self) -> "ProcessingResultEnvelope":
        if not self.results:
            raise ValueError("results must contain at least one item.")
        return self


class ProcessingCompleteRequest(BaseModel):
    session_id: str | None = None
    session_ids: list[str] = Field(default_factory=list)
    response_text: str = Field(min_length=1)

    @model_validator(mode="after")
    def validate_session_ids(self) -> "ProcessingCompleteRequest":
        resolved = self.resolved_session_ids
        if not resolved:
            raise ValueError("At least one session_id is required.")
        return self

    @property
    def resolved_session_ids(self) -> list[str]:
        if self.session_ids:
            return self.session_ids
        if self.session_id:
            return [self.session_id]
        return []


class ProcessingCompleteResult(BaseModel):
    session_id: str
    category: SessionCategory
    markdown_path: str | None = None
    processed: bool


class ProcessingCompleteResponse(BaseModel):
    processed_count: int
    results: list[ProcessingCompleteResult] = Field(default_factory=list)
