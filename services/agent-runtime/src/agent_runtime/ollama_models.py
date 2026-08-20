"""Ollama model discovery for `GET /local/v1/models` (D-092, open-decisions.md).

Mirrors `services/indexing-runtime/src/indexing_runtime/embedders/__init__.py`'s
`list_ollama_models`/`is_embedding_capable` almost exactly — that module is
the existing template for exposing "what's installed in Ollama" to
portal-api's admin screen (P15), and D-092 explicitly says to reuse that
shape rather than invent a new one. Duplicated here rather than imported:
this service's own CLAUDE.md ("이 모듈의 경계") forbids importing
services/indexing-runtime's internals, the same boundary
`agent_runtime.adapters.hub_search`'s docstring documents for portal-api.
"""

from __future__ import annotations

import httpx


async def list_ollama_models(
    endpoint: str, *, timeout: float = 10.0, transport: httpx.BaseTransport | None = None
) -> list[dict]:
    """Raw `GET {endpoint}/api/tags` result's `models` array.

    Raises `httpx.HTTPError` on any connection/HTTP failure — callers (see
    `routers/models.py`) must not swallow this into an empty list: an empty
    list here would be indistinguishable from "Ollama is up but has zero
    models installed" (a real, different state a caller must be able to
    tell apart from "couldn't ask Ollama at all").

    `transport` is a test-only hook (httpx.MockTransport), same pattern as
    `agent_runtime.adapters.ollama.OllamaLLMAdapter`'s `transport`
    parameter."""
    async with httpx.AsyncClient(timeout=timeout, transport=transport) as client:
        resp = await client.get(f"{endpoint}/api/tags")
        resp.raise_for_status()
        data = resp.json()
    return list(data.get("models") or [])


# Ollama's `/api/tags` does not expose an explicit "this model is for chat"
# field, same gap `is_embedding_capable` documents on the embedding side —
# best-effort naming-convention heuristic over the model name and its
# `details.family`/`details.families` metadata, INVERTED from
# indexing-runtime's `_EMBEDDING_NAME_HINTS` list (duplicated, not
# imported — module boundary, see module docstring). A model is flagged
# `chat_capable=False` only when its name/family matches a well-known
# embedding-only naming convention; every other model defaults to
# `chat_capable=True`. This can be wrong in both directions (a niche
# embedding model without one of these hints would be mislabeled
# chat-capable) — it is a DISPLAY HINT to steer an operator away from an
# obviously-wrong pick (e.g. `qwen3-embedding:0.6b`), never a filter: an
# uncertain model is still returned in `models` (never hidden), see
# `routers/models.py`.
_EMBEDDING_ONLY_NAME_HINTS = ("embed", "bge", "gte", "e5-", "minilm", "gtr-")


def is_chat_capable(model_entry: dict) -> bool:
    name = str(model_entry.get("name") or model_entry.get("model") or "").lower()
    details = model_entry.get("details") or {}
    family = str(details.get("family") or "").lower()
    families = [str(f).lower() for f in (details.get("families") or [])]
    haystack = " ".join([name, family, *families])
    return not any(hint in haystack for hint in _EMBEDDING_ONLY_NAME_HINTS)
