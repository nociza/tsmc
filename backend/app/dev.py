from __future__ import annotations

import os
from pathlib import Path

import uvicorn


BACKEND_DIR = Path(__file__).resolve().parents[1]


def main() -> None:
    uvicorn.run(
        "app.main:app",
        host=os.getenv("TSMC_HOST", "127.0.0.1"),
        port=int(os.getenv("TSMC_PORT", "18888")),
        reload=True,
        reload_dirs=[str(BACKEND_DIR / "app")],
    )


if __name__ == "__main__":
    main()
