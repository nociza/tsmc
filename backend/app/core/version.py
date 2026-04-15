from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version


PACKAGE_NAME = "savemycontext"


def get_app_version() -> str:
    try:
        return version(PACKAGE_NAME)
    except PackageNotFoundError:
        return "0.0.0"
