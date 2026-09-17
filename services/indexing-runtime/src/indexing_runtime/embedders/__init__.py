"""Ollama embedding adapter.

Two Ollama endpoints exist and they are not interchangeable:

* `POST /api/embed` takes an `input` ARRAY and returns an `embeddings` array —
  one round trip for many texts. This is the path used.
* `POST /api/embeddings` (the older singular one) takes a single `prompt` and
  returns a single `embedding`. Kept only as the fallback for an Ollama build
  too old to serve `/api/embed`.

Why this matters enough to write down: until 2026-09-17 this module only ever
used the singular endpoint. `embed_batch` accepted a `batch_size`, which made
it LOOK batched, but it sliced the list and then handed each slice to a
function that still issued one HTTP request per text — so the request count was
identical to not batching at all and the parameter changed nothing. A 21MB
Markdown reference guide (41,954 child chunks) therefore needed 13-20 minutes
of sequential round trips, far past portal-api's 300s budget, and its indexing
job was recorded as FAILED by timeout with no way to ever succeed. Batched, the
same document's embedding leg takes ~165s. See
`settings.EMBED_BATCH_SIZE` for the throughput measurements behind the default.
"""

from __future__ import annotations

import logging
from collections.abc import Callable

import httpx

from indexing_runtime.ollama_config import load_ollama_endpoint

from indexing_runtime.settings import (
    EMBED_BATCH_SIZE,
    EMBED_MODEL as DEFAULT_EMBED_MODEL,
    EMBED_REQUEST_TIMEOUT_SECONDS,
)

OLLAMA_ENDPOINT = load_ollama_endpoint()

_logger = logging.getLogger("indexing_runtime")


class EmbeddingCountMismatchError(RuntimeError):
    """Ollama returned a different number of embeddings than texts sent.

    This is fatal on purpose. Embeddings are matched to chunk ids purely by
    LIST POSITION at the `collection.add(ids=..., embeddings=...)` call in
    `pipeline.run_pipeline`, so a short (or long) batch does not lose one
    chunk — it shifts every embedding after it onto the wrong chunk for the
    rest of the run. The resulting index answers queries with confident,
    well-formed, completely wrong citations, and nothing downstream can detect
    it. Failing the job is the only honest outcome.
    """


async def _embed_one_batch(
    client: httpx.AsyncClient, texts: list[str], model: str
) -> list[list[float]]:
    """One `/api/embed` round trip for many texts, order preserved."""
    resp = await client.post(
        f"{OLLAMA_ENDPOINT}/api/embed",
        json={"model": model, "input": texts},
    )
    resp.raise_for_status()
    embeddings = resp.json().get("embeddings")
    if not isinstance(embeddings, list):
        raise EmbeddingCountMismatchError(
            f"Ollama /api/embed returned no 'embeddings' array for {len(texts)} texts"
        )
    if len(embeddings) != len(texts):
        raise EmbeddingCountMismatchError(
            f"Ollama /api/embed returned {len(embeddings)} embeddings "
            f"for {len(texts)} texts — refusing to misalign chunks"
        )
    return embeddings


async def embed_texts(texts: list[str], model: str = DEFAULT_EMBED_MODEL) -> list[list[float]]:
    """Legacy path: one `/api/embeddings` request per text, sequentially.

    Only reached when the configured Ollama has no `/api/embed` route (see
    `embed_batch`). Correct but slow — an order of magnitude more round trips
    than the batched path.
    """
    embeddings: list[list[float]] = []
    async with httpx.AsyncClient(timeout=EMBED_REQUEST_TIMEOUT_SECONDS) as client:
        for text in texts:
            resp = await client.post(
                f"{OLLAMA_ENDPOINT}/api/embeddings",
                json={"model": model, "prompt": text},
            )
            resp.raise_for_status()
            embeddings.append(resp.json()["embedding"])
    return embeddings


async def embed_batch(
    texts: list[str],
    model: str = DEFAULT_EMBED_MODEL,
    batch_size: int = EMBED_BATCH_SIZE,
    on_progress: Callable[[int, int], None] | None = None,
) -> list[list[float]]:
    """Embed every text, in input order, `batch_size` texts per HTTP request.

    Falls back to the per-text `/api/embeddings` loop if this Ollama build does
    not serve `/api/embed` (404) — older deployments in a closed network should
    keep working rather than start failing on an endpoint they never had. The
    fallback logs a warning naming the consequence, because a silent drop back
    to sequential embedding is precisely the "it just hangs" failure this
    module exists to remove.

    `on_progress(done, total)` is called after each batch. Embedding is ~95% of
    a large document's indexing time, so this callback is the only place that
    can honestly answer "how far along is it" — everything else in the pipeline
    finishes in under a second. It must never raise: a progress reporter
    breaking an indexing job would be a strictly worse outcome than having no
    progress at all.
    """
    if not texts:
        return []

    batch_size = max(1, batch_size)
    all_embeddings: list[list[float]] = []

    def _tick() -> None:
        if on_progress is None:
            return
        try:
            on_progress(len(all_embeddings), len(texts))
        except Exception:  # noqa: BLE001 — 진행률 보고가 색인을 깨뜨리면 안 된다
            _logger.warning("indexing.embed.progress_callback_failed", exc_info=True)

    async with httpx.AsyncClient(timeout=EMBED_REQUEST_TIMEOUT_SECONDS) as client:
        for i in range(0, len(texts), batch_size):
            batch = texts[i : i + batch_size]
            try:
                all_embeddings.extend(await _embed_one_batch(client, batch, model))
                _tick()
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code != 404:
                    raise
                _logger.warning(
                    "indexing.embed.batch_endpoint_missing endpoint=%s texts=%d "
                    "falling_back_to=/api/embeddings note=sequential_embedding_is_much_slower",
                    OLLAMA_ENDPOINT,
                    len(texts),
                )
                return await embed_texts(texts, model)

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
