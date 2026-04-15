from __future__ import annotations

from typing import Any

import httpx

from app.core.config import get_settings
from app.services.llm.base import LLMClient, SchemaT
from app.services.text import extract_json_object


class OpenAIClient(LLMClient):
    name = "openai_compatible"

    def __init__(self) -> None:
        settings = get_settings()
        self.api_key = settings.openai_api_key
        self.base_url = settings.resolved_openai_base_url.rstrip("/")
        self.model = settings.resolved_openai_model
        self.site_url = settings.openai_site_url or settings.public_url
        self.app_name = settings.openai_app_name
        self.timeout = settings.request_timeout_seconds

    async def generate_json(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        schema: type[SchemaT],
    ) -> SchemaT:
        if not self.api_key:
            raise RuntimeError("OpenAI API key is not configured.")

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        if self.app_name:
            headers["X-Title"] = self.app_name
        if self.site_url:
            headers["HTTP-Referer"] = self.site_url

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            data = await self._request_json_completion(
                client,
                headers=headers,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
            )

        content = self._extract_content(data)
        parsed = extract_json_object(content)
        return schema.model_validate(parsed)

    async def _request_json_completion(
        self,
        client: httpx.AsyncClient,
        *,
        headers: dict[str, str],
        system_prompt: str,
        user_prompt: str,
    ) -> dict[str, Any]:
        try:
            return await self._post_completion(
                client,
                headers=headers,
                payload=self._build_payload(
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    prefer_json_mode=True,
                ),
            )
        except httpx.HTTPStatusError as exc:
            if not self._should_retry_without_json_mode(exc):
                raise
            return await self._post_completion(
                client,
                headers=headers,
                payload=self._build_payload(
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    prefer_json_mode=False,
                ),
            )

    async def _post_completion(
        self,
        client: httpx.AsyncClient,
        *,
        headers: dict[str, str],
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        response = await client.post(
            f"{self.base_url}/chat/completions",
            headers=headers,
            json=payload,
        )
        response.raise_for_status()
        return response.json()

    def _build_payload(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        prefer_json_mode: bool,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.model,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        }
        if prefer_json_mode:
            payload["response_format"] = {"type": "json_object"}
        return payload

    def _should_retry_without_json_mode(self, exc: httpx.HTTPStatusError) -> bool:
        if exc.response.status_code not in {400, 404, 422}:
            return False
        message = exc.response.text.lower()
        return "response_format" in message or "json_object" in message or "json schema" in message

    def _extract_content(self, data: dict[str, Any]) -> str:
        message = data["choices"][0]["message"]["content"]
        if isinstance(message, str):
            return message
        if isinstance(message, list):
            parts: list[str] = []
            for item in message:
                if isinstance(item, str):
                    parts.append(item)
                    continue
                if isinstance(item, dict):
                    text = item.get("text")
                    if isinstance(text, str):
                        parts.append(text)
            joined = "".join(parts).strip()
            if joined:
                return joined
        raise ValueError("The OpenAI-compatible response did not include a text message content payload.")
