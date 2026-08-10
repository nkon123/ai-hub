"""Shared fakes for search_runtime unit tests.

D-046 requires these tests to run without Ollama, Chroma, or any live
service — everything hybrid_search() touches externally (the BM25 index
file, the Chroma vector store, and the Ollama embedding call) is faked here.
The only real I/O is a bm25.json this fixture writes to a pytest tmp_path
and hybrid_search reads back in the same process.

D-054: bm25.json (not bm25.pkl) is the format hybrid_search reads by
default now — see `search_runtime.bm25_store`. `write_bm25_index` writes a
real bm25.json (so `hybrid_search`'s file-existence/read-path plumbing is
genuinely exercised) but ALSO monkeypatches `hybrid_search`'s
`rebuild_bm25` step to return a fake object whose `get_scores()` always
returns the caller-supplied `bm25_scores` regardless of the query — most
tests in this package assert on exact fused rankings/relevance thresholds
that depend on precisely controlling what BM25 "found", which a real
BM25Okapi computed from these tiny fixture texts would not reproduce
predictably. See `tests/unit/indexing_runtime/test_bm25_store.py` /
`test_convert_bm25_format.py` for tests that exercise the REAL BM25Okapi
rebuild end to end."""

from __future__ import annotations

import json
import pickle
from pathlib import Path
from typing import Any


class FakeBM25:
    """Minimal stand-in for rank_bm25.BM25Okapi — only get_scores() is used
    by hybrid_search."""

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
    monkeypatch: Any,
    hybrid_module: Any,
    legacy_pickle: bool = False,
) -> None:
    """Write a fake bm25.json (or, if `legacy_pickle=True`, a legacy
    bm25.pkl — for the small number of tests that specifically exercise the
    D-054 legacy-fallback path) in the layout hybrid_search expects
    (services/indexing-runtime's pipeline.py is the real writer), and
    monkeypatch the BM25 rebuild step so `bm25_scores` is exactly what
    hybrid_search's BM25 ranking sees, regardless of the tokenized corpus
    actually written to disk."""
    index_dir = index_base / knowledge_id
    index_dir.mkdir(parents=True, exist_ok=True)
    if legacy_pickle:
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
    else:
        document = {
            "schema_version": "1.0",
            "tokenizer": "whitespace_split",
            "tokenized_corpus": [t.split() for t in chunk_texts],
            "chunk_ids": chunk_ids,
            "chunk_texts": chunk_texts,
            "chunk_metadata": chunk_metadata,
        }
        (index_dir / "bm25.json").write_text(
            json.dumps(document, ensure_ascii=False), encoding="utf-8"
        )

    monkeypatch.setattr(
        hybrid_module, "rebuild_bm25", lambda tokenized_corpus: FakeBM25(bm25_scores)  # noqa: ARG005
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
