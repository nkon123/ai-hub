"""Shared fakes for search_runtime unit tests.

D-046 requires these tests to run without Ollama, Chroma, or any live
service — everything hybrid_search() touches externally (the BM25 index
file, the Chroma vector store, and the Ollama embedding call) is faked here.
The only real I/O is a bm25.pkl this fixture writes to a pytest tmp_path and
hybrid_search reads back in the same process.
"""

from __future__ import annotations

import pickle
from pathlib import Path
from typing import Any


class FakeBM25:
    """Minimal stand-in for rank_bm25.BM25Okapi — only get_scores() is used
    by hybrid_search. Defined at module level (not inside a test function)
    because it must be picklable."""

    def __init__(self, scores: list[float]) -> None:
        self.scores = scores

    def get_scores(self, tokens: list[str]) -> list[float]:  # noqa: ARG002
        return self.scores


def write_bm25_index(
    index_base: Path,
    knowledge_id: str,
    *,
    bm25_scores: list[float],
    chunk_ids: list[str],
    chunk_texts: list[str],
    chunk_metadata: list[dict[str, Any]],
) -> None:
    """Write a fake bm25.pkl in the layout hybrid_search expects
    (services/indexing-runtime's pipeline.py is the real writer)."""
    index_dir = index_base / knowledge_id
    index_dir.mkdir(parents=True, exist_ok=True)
    with open(index_dir / "bm25.pkl", "wb") as f:
        pickle.dump(
            {
                "bm25": FakeBM25(bm25_scores),
                "chunk_ids": chunk_ids,
                "chunk_texts": chunk_texts,
                "chunk_metadata": chunk_metadata,
            },
            f,
        )


class FakeChromaCollection:
    """Stand-in for a chromadb Collection — only .count() and .query() are
    used by hybrid_search."""

    def __init__(self, ids: list[str], distances: list[float], count: int = 100) -> None:
        self._ids = ids
        self._distances = distances
        self._count = count

    def count(self) -> int:
        return self._count

    def query(
        self,
        query_embeddings: list[list[float]],  # noqa: ARG002
        n_results: int,  # noqa: ARG002
        include: list[str],  # noqa: ARG002
    ) -> dict[str, Any]:
        return {"ids": [self._ids], "distances": [self._distances]}


class FakeChromaClient:
    """Stand-in for chromadb.PersistentClient — only .get_collection() is
    used by hybrid_search."""

    def __init__(self, collection: FakeChromaCollection) -> None:
        self._collection = collection

    def get_collection(self, name: str) -> FakeChromaCollection:  # noqa: ARG002
        return self._collection


def patch_chroma(
    monkeypatch: Any, hybrid_module: Any, ids: list[str], distances: list[float]
) -> None:
    """Make hybrid_search's `get_chroma_client(...)` call (the D-067
    shared-client cache helper — `hybrid.py` no longer imports `chromadb`
    itself, it goes through `search_runtime.chroma_client_cache`) return a
    fake client whose vector search yields the given (ids, distances),
    instead of opening a real on-disk Chroma store."""
    fake_client = FakeChromaClient(FakeChromaCollection(ids, distances))
    monkeypatch.setattr(hybrid_module, "get_chroma_client", lambda path: fake_client)  # noqa: ARG005


def patch_embed_query(monkeypatch: Any, hybrid_module: Any) -> list[dict[str, Any]]:
    """Replace hybrid_search's call to embed_query with a fake that never
    touches Ollama/httpx, and records every call's arguments so a test can
    assert on the text actually sent for embedding."""
    calls: list[dict[str, Any]] = []

    async def fake_embed_query(query: str, model: str, instruct_prefix: str = "") -> list[float]:
        calls.append({"query": query, "model": model, "instruct_prefix": instruct_prefix})
        return [0.0, 0.0, 0.0]

    monkeypatch.setattr(hybrid_module, "embed_query", fake_embed_query)
    return calls
