"""Read the shared AIHUB Ollama deployment configuration.

Kept local to each runtime to avoid cross-service internal imports.
The file contract is documented in docs/ollama-configuration.md.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import urlsplit


def load_ollama_endpoint() -> str:
    path = Path(os.environ.get(
        "AIHUB_OLLAMA_CONFIG",
        str(Path(__file__).resolve().parents[4] / "config" / "ollama.json"),
    ))
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        value = data["endpoint"]
        if not isinstance(value, str):
            raise ValueError("endpoint must be a string")
        value = value.strip().rstrip("/")
        url = urlsplit(value)
        if (url.scheme not in {"http", "https"} or not url.hostname
                or url.username is not None or url.password is not None
                or url.query or url.fragment or url.path or any(c.isspace() for c in value)):
            raise ValueError("endpoint must be an HTTP(S) server base URL")
        _ = url.port
        return value
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise ValueError(f"Invalid Ollama configuration: {path}") from exc

