"""D-046: relevance filtering in hybrid_search().

Fixture layout (see conftest.py):
  chunk_ids = ["c1", "c2", "c3", "c4"]
  BM25 ranking (scores [10, 0, 5, 0]):  c1 (rank0), c3 (rank1), c2 (rank2), c4 (rank3)
  Vector ranking (ids/distances):        c1 (dist 0.3 -> sim 0.7)
                                          c2 (dist 0.7 -> sim 0.3)
                                          c4 (dist 0.5 -> sim 0.5)
                                          c3 has NO vector match (BM25-only chunk)

With alpha=0.5 and RRF k=60, the fused ranking (highest score first) works
out to: c1 > c2 > c4 > c3 (verified by test_no_filter_matches_pre_d046_behavior).

No live Ollama/Chroma is used anywhere in this file — embed_query and
chromadb.PersistentClient are both monkeypatched (see conftest.py).
"""

from __future__ import annotations

import pytest
from search_runtime import hybrid

from .conftest import patch_chroma, patch_embed_query, write_bm25_index

KNOWLEDGE_ID = "11111111-1111-1111-1111-111111111111"

CHUNK_IDS = ["c1", "c2", "c3", "c4"]
CHUNK_TEXTS = ["c1 text", "c2 text", "c3 text", "c4 text"]
CHUNK_METADATA = [
    {"source_path": "doc.md", "title": "Doc", "section": "s1", "page": 1},
    {"source_path": "doc.md", "title": "Doc", "section": "s2", "page": 1},
    {"source_path": "doc.md", "title": "Doc", "section": "s3", "page": 1},
    {"source_path": "doc.md", "title": "Doc", "section": "s4", "page": 1},
]
# Descending BM25 scores by chunk index: c1=10 (rank0), c3=5 (rank1), c2=c4=0 (tied, rank2/3)
BM25_SCORES = [10, 0, 5, 0]
# Vector hits: c1, c2, c4 — c3 is never returned by the vector store (BM25-only chunk)
VECTOR_IDS = ["c1", "c2", "c4"]
VECTOR_DISTANCES = [0.3, 0.7, 0.5]  # -> similarities 0.7, 0.3, 0.5


def _setup(tmp_path, monkeypatch) -> list[dict]:
    write_bm25_index(
        tmp_path,
        KNOWLEDGE_ID,
        bm25_scores=BM25_SCORES,
        chunk_ids=CHUNK_IDS,
        chunk_texts=CHUNK_TEXTS,
        chunk_metadata=CHUNK_METADATA,
        monkeypatch=monkeypatch,
        hybrid_module=hybrid,
    )
    patch_chroma(monkeypatch, hybrid, VECTOR_IDS, VECTOR_DISTANCES)
    patch_embed_query(monkeypatch, hybrid)
    return []


@pytest.mark.asyncio
async def test_no_filter_matches_pre_d046_behavior(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """min_relevance_score=0 must reproduce the pre-D-046 behavior exactly:
    top_k returned regardless of relevance, including the BM25-only chunk."""
    _setup(tmp_path, monkeypatch)

    citations = await hybrid.hybrid_search(
        query="아무 질문",
        knowledge_id=KNOWLEDGE_ID,
        top_k=4,
        alpha=0.5,
        index_base=str(tmp_path),
        min_relevance_score=0,
    )

    assert [c["chunk_id"] for c in citations] == ["c1", "c2", "c4", "c3"]
    # c3 was never seen by the vector store, so it has no similarity value
    similarities = {c["chunk_id"]: c["similarity"] for c in citations}
    assert similarities["c1"] == 0.7
    assert similarities["c2"] == 0.3
    assert similarities["c4"] == 0.5
    assert similarities["c3"] is None


@pytest.mark.asyncio
async def test_mixed_threshold_keeps_only_above_threshold(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """threshold=0.5: c1 (0.7) and c4 (0.5, boundary >=) survive; c2 (0.3)
    is dropped for low similarity; c3 (BM25-only, no similarity) is dropped
    under the D-046 BM25-only-chunk rule."""
    _setup(tmp_path, monkeypatch)

    citations = await hybrid.hybrid_search(
        query="아무 질문",
        knowledge_id=KNOWLEDGE_ID,
        top_k=4,
        alpha=0.5,
        index_base=str(tmp_path),
        min_relevance_score=0.5,
    )

    assert [c["chunk_id"] for c in citations] == ["c1", "c4"]
    assert all(c["similarity"] >= 0.5 for c in citations)


@pytest.mark.asyncio
async def test_all_below_threshold_yields_zero_citations(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """This is the D-046 point: an out-of-scope question whose best chunk
    similarity is still below the floor must come back with zero citations
    so agent-runtime's D-036 guard (0 citations -> INSUFFICIENT_EVIDENCE)
    fires deterministically."""
    _setup(tmp_path, monkeypatch)

    citations = await hybrid.hybrid_search(
        query="완전히 무관한 질문",
        knowledge_id=KNOWLEDGE_ID,
        top_k=4,
        alpha=0.5,
        index_base=str(tmp_path),
        min_relevance_score=0.9,  # above every similarity in the fixture (max 0.7)
    )

    assert citations == []


@pytest.mark.asyncio
async def test_bm25_only_chunk_dropped_even_if_top_ranked(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Isolate the BM25-only-chunk rule: make the BM25-only chunk (c3) the
    single highest-scored candidate (no vector competitors at all) and
    confirm it is still dropped once filtering is enabled, because there is
    no cosine-similarity evidence for it — never silently kept."""
    write_bm25_index(
        tmp_path,
        KNOWLEDGE_ID,
        bm25_scores=[0, 0, 99, 0],  # only c3 scores
        chunk_ids=CHUNK_IDS,
        chunk_texts=CHUNK_TEXTS,
        chunk_metadata=CHUNK_METADATA,
        monkeypatch=monkeypatch,
        hybrid_module=hybrid,
    )
    patch_chroma(monkeypatch, hybrid, ids=[], distances=[])  # vector store returns nothing
    patch_embed_query(monkeypatch, hybrid)

    # Sanity check: with filtering disabled, c3 (BM25-only) is returned.
    unfiltered = await hybrid.hybrid_search(
        query="질문",
        knowledge_id=KNOWLEDGE_ID,
        top_k=4,
        index_base=str(tmp_path),
        min_relevance_score=0,
    )
    assert "c3" in [c["chunk_id"] for c in unfiltered]

    filtered = await hybrid.hybrid_search(
        query="질문",
        knowledge_id=KNOWLEDGE_ID,
        top_k=4,
        index_base=str(tmp_path),
        min_relevance_score=0.01,  # lowest possible non-zero floor
    )
    assert filtered == []


@pytest.mark.asyncio
async def test_query_instruct_prefix_is_plumbed_to_embed_query(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """hybrid_search must pass its query_instruct_prefix argument through to
    embed_query (embed_query's own prefix-concatenation logic is covered
    separately in test_embed_query.py)."""
    write_bm25_index(
        tmp_path,
        KNOWLEDGE_ID,
        bm25_scores=BM25_SCORES,
        chunk_ids=CHUNK_IDS,
        chunk_texts=CHUNK_TEXTS,
        chunk_metadata=CHUNK_METADATA,
        monkeypatch=monkeypatch,
        hybrid_module=hybrid,
    )
    patch_chroma(monkeypatch, hybrid, VECTOR_IDS, VECTOR_DISTANCES)
    calls = patch_embed_query(monkeypatch, hybrid)

    prefix = "Instruct: custom test prefix\nQuery: "
    await hybrid.hybrid_search(
        query="장비 지원은 무엇이 있나요?",
        knowledge_id=KNOWLEDGE_ID,
        top_k=4,
        index_base=str(tmp_path),
        query_instruct_prefix=prefix,
    )

    assert len(calls) == 1
    assert calls[0]["query"] == "장비 지원은 무엇이 있나요?"
    assert calls[0]["instruct_prefix"] == prefix


@pytest.mark.asyncio
async def test_no_bm25_index_returns_empty_regardless_of_threshold(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Pre-existing behavior (missing index -> []) must be unaffected by
    the new parameters."""
    citations = await hybrid.hybrid_search(
        query="아무 질문",
        knowledge_id="does-not-exist",
        index_base=str(tmp_path),
        min_relevance_score=0.5,
    )
    assert citations == []
