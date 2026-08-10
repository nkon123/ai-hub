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
