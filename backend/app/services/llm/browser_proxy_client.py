from __future__ import annotations

import json
from typing import TYPE_CHECKING

from app.core.config import Settings, get_settings
from app.services.llm.base import LLMClient, SchemaT
from app.services.llm.browser_proxy_session_store import BrowserProxySessionStore
from app.services.text import extract_json_object

if TYPE_CHECKING:
    from app.services.browser_proxy.service import BrowserProxyService


class BrowserProxyClient(LLMClient):
    name = "browser_proxy"

    def __init__(
        self,
        browser_proxy: BrowserProxyService,
        *,
        settings: Settings | None = None,
        session_store: BrowserProxySessionStore | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.browser_proxy = browser_proxy
        self.model = self.settings.browser_llm_model
        self.session_store = session_store or BrowserProxySessionStore(self.settings.resolved_browser_llm_state_path)

    async def generate_json(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        schema: type[SchemaT],
    ) -> SchemaT:
        prompt = self._build_task_prompt(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            schema=schema,
        )
        async with self.session_store.lock(self.model):
            session_url = self.session_store.get(self.model)
            completion = await self.browser_proxy.complete(
                model=self.model,
                prompt_text=prompt,
                provider_session_url=session_url,
            )
            self.session_store.set(self.model, completion.provider_session_url)
            try:
                parsed = extract_json_object(completion.response_text)
            except Exception:
                repair_completion = await self.browser_proxy.complete(
                    model=self.model,
                    prompt_text=self._build_repair_prompt(
                        prior_response=completion.response_text,
                        schema=schema,
                    ),
                    provider_session_url=completion.provider_session_url,
                )
                self.session_store.set(self.model, repair_completion.provider_session_url)
                parsed = extract_json_object(repair_completion.response_text)
        return schema.model_validate(parsed)

    def _build_task_prompt(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        schema: type[SchemaT],
    ) -> str:
        schema_json = json.dumps(schema.model_json_schema(), ensure_ascii=True, separators=(",", ":"), sort_keys=True)
        return (
            "You are SaveMyContext's internal processing worker.\n"
            "This browser chat is reserved for fast private classification and summarization jobs.\n"
            "Use fast mode. Do not use extended reasoning, hidden chain-of-thought, or thinking mode.\n"
            "Treat every message as a new independent task.\n"
            "Do not rely on transcript content from earlier turns beyond these standing rules.\n"
            "Return exactly one JSON object that matches the JSON Schema below.\n"
            "Do not include markdown fences or extra prose.\n\n"
            "JSON Schema:\n"
            f"{schema_json}\n\n"
            "Task instructions:\n"
            f"{system_prompt.strip()}\n\n"
            "Task input:\n"
            f"{user_prompt.strip()}"
        ).strip()

    def _build_repair_prompt(self, *, prior_response: str, schema: type[SchemaT]) -> str:
        schema_json = json.dumps(schema.model_json_schema(), ensure_ascii=True, separators=(",", ":"), sort_keys=True)
        return (
            "Your previous reply was not valid JSON for the required schema.\n"
            "Return the same answer again as exactly one valid JSON object.\n"
            "Do not add markdown fences, commentary, or any text outside the JSON object.\n\n"
            "JSON Schema:\n"
            f"{schema_json}\n\n"
            "Previous reply:\n"
            f"{prior_response.strip()}"
        ).strip()
