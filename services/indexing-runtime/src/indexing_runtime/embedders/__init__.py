"""Ollama embedding adapter."""

from __future__ import annotations

import httpx

from indexing_runtime.settings import EMBED_MODEL as DEFAULT_EMBED_MODEL

OLLAMA_ENDPOINT = "http://127.0.0.1:11434"


async def embed_texts(texts: list[str], model: str = DEFAULT_EMBED_MODEL) -> list[list[float]]:
    """Embed a list of texts using Ollama embedding API."""
    embeddings: list[list[float]] = []
    async with httpx.AsyncClient(timeout=60) as client:
        for text in texts:
            resp = await client.post(
                f"{OLLAMA_ENDPOINT}/api/embeddings",
                json={"model": model, "prompt": text},
            )
            resp.raise_for_status()
            embeddings.append(resp.json()["embedding"])
    return embeddings


async def embed_batch(
    texts: list[str], model: str = DEFAULT_EMBED_MODEL, batch_size: int = 16
) -> list[list[float]]:
    """Embed texts in batches."""
    all_embeddings: list[list[float]] = []
    for i in range(0, len(texts), batch_size):
        batch = texts[i : i + batch_size]
        embeddings = await embed_texts(batch, model)
        all_embeddings.extend(embeddings)
    return all_embeddings


async def list_ollama_models() -> list[dict]:
    """Raw `GET {OLLAMA_ENDPOINT}/api/tags` result's `models` array.

    Raises `httpx.HTTPError` on any connection/HTTP failure — callers (see
    `main.list_embedding_models`) must not swallow this into an empty list,
    since an empty list here would be indistinguishable from "Ollama is up
    but has zero models installed" (a real, different state)."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(f"{OLLAMA_ENDPOINT}/api/tags")
        resp.raise_for_status()
        data = resp.json()
    return list(data.get("models") or [])


# Ollama's `/api/tags` does not expose an explicit "this model is for
# embeddings" field (docs/implementation-spec/open-decisions.md D-075's
# admin-facing follow-up) — this is a best-effort naming-convention
# heuristic over the model name and its `details.family`/`details.families`
# metadata. It correctly flags every embedding model this codebase has
# actually used (`qwen3-embedding:0.6b`, via "embed") plus the other common
# Ollama embedding model families. A model that doesn't match is NOT
# necessarily unusable for embedding — it just isn't confidently
# identifiable as one from name/family metadata alone, which is exactly why
# `routers.admin` (portal-api) treats this flag as the gate for what an
# operator may configure (never guess a chat model into the embedding
# slot).
_EMBEDDING_NAME_HINTS = ("embed", "bge", "gte", "e5-", "minilm", "gtr-")


def is_embedding_capable(model_entry: dict) -> bool:
    name = str(model_entry.get("name") or model_entry.get("model") or "").lower()
    details = model_entry.get("details") or {}
    family = str(details.get("family") or "").lower()
    families = [str(f).lower() for f in (details.get("families") or [])]
    haystack = " ".join([name, family, *families])
    return any(hint in haystack for hint in _EMBEDDING_NAME_HINTS)
