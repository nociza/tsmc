from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import ClassVar


class BrowserProxySessionStore:
    _locks: ClassVar[dict[str, asyncio.Lock]] = {}

    def __init__(self, path: Path) -> None:
        self.path = path

    def get(self, model: str) -> str | None:
        payload = self._load()
        sessions = payload.get("sessions", {})
        if not isinstance(sessions, dict):
            return None
        record = sessions.get(model)
        if not isinstance(record, dict):
            return None
        provider_session_url = str(record.get("provider_session_url", "")).strip()
        return provider_session_url or None

    def set(self, model: str, provider_session_url: str) -> None:
        payload = self._load()
        sessions = payload.setdefault("sessions", {})
        if not isinstance(sessions, dict):
            payload["sessions"] = {}
            sessions = payload["sessions"]
        sessions[model] = {
            "provider_session_url": provider_session_url,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        self._save(payload)

    def clear(self, model: str | None = None) -> None:
        if model is None:
            if self.path.exists():
                self.path.unlink()
            return
        payload = self._load()
        sessions = payload.get("sessions", {})
        if not isinstance(sessions, dict):
            return
        if model in sessions:
            del sessions[model]
            self._save(payload)

    def lock(self, model: str) -> asyncio.Lock:
        key = f"{self.path.resolve()}::{model}"
        lock = self._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[key] = lock
        return lock

    def _load(self) -> dict[str, object]:
        if not self.path.exists():
            return {"version": 1, "sessions": {}}
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {"version": 1, "sessions": {}}
        if not isinstance(payload, dict):
            return {"version": 1, "sessions": {}}
        payload.setdefault("version", 1)
        payload.setdefault("sessions", {})
        return payload

    def _save(self, payload: dict[str, object]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = self.path.with_suffix(f"{self.path.suffix}.tmp")
        temp_path.write_text(f"{json.dumps(payload, indent=2, sort_keys=True)}\n", encoding="utf-8")
        temp_path.replace(self.path)
