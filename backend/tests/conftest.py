from __future__ import annotations

import os
from collections.abc import Iterator

import pytest

from app.core.config import get_settings


ENV_PREFIXES = ("SAVEMYCONTEXT_", "OPENAI_", "OPENROUTER_")


@pytest.fixture(autouse=True)
def isolate_runtime_environment() -> Iterator[None]:
    original = {key: value for key, value in os.environ.items() if key.startswith(ENV_PREFIXES)}
    get_settings.cache_clear()

    try:
        yield
    finally:
        for key in list(os.environ):
            if key.startswith(ENV_PREFIXES) and key not in original:
                os.environ.pop(key, None)

        for key, value in original.items():
            os.environ[key] = value

        get_settings.cache_clear()
