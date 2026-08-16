"""§2.6/§3.12 `document_id` on citations (D-045).

indexing-runtime has always written `document_id` into each chunk's stored
metadata; search-runtime just never handed it back, so every consumer had to
re-derive document identity from `document_path`/`document_title` — display
fields that change when a title is edited. This file pins the two halves of
surfacing it:

  - it is echoed from stored metadata, never reconstructed locally;
  - an index that has no such metadata reports `""` (unknown) rather than a
    plausible-looking id invented from the path, which would be
    indistinguishable from a real one to every caller downstream.

No live Ollama/Chroma — both are monkeypatched via conftest, like the rest of
this directory.
"""

from __future__ import annotations

import pytest
from search_runtime import hybrid

from .conftest import patch_chroma, patch_embed_query, write_bm25_index

KNOWLEDGE_ID = "22222222-2222-2222-2222-222222222222"
CHUNK_IDS = ["c1", "c2"]
CHUNK_TEXTS = ["c1 text", "c2 text"]
BM25_SCORES = [10, 5]
VECTOR_IDS = ["c1", "c2"]
VECTOR_DISTANCES = [0.1, 0.2]


async def _search(tmp_path, monkeypatch, chunk_metadata: list[dict]) -> list[dict]:
    write_bm25_index(
        tmp_path,
        KNOWLEDGE_ID,
        bm25_scores=BM25_SCORES,
        chunk_ids=CHUNK_IDS,
        chunk_texts=CHUNK_TEXTS,
        chunk_metadata=chunk_metadata,
        monkeypatch=monkeypatch,
        hybrid_module=hybrid,
    )
    patch_chroma(monkeypatch, hybrid, VECTOR_IDS, VECTOR_DISTANCES)
    patch_embed_query(monkeypatch, hybrid)
    return await hybrid.hybrid_search(
        query="아무 질문",
        knowledge_id=KNOWLEDGE_ID,
        top_k=2,
        alpha=0.5,
        index_base=str(tmp_path),
        min_relevance_score=0,
    )


@pytest.mark.asyncio
async def test_document_id_is_echoed_from_indexed_metadata(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    metadata = [
        {
            "document_id": f"{KNOWLEDGE_ID}:documents/hr-policy.md",
            "source_path": "documents/hr-policy.md",
            "title": "인사 규정",
            "section": "s1",
            "page": 1,
        },
        {
            "document_id": f"{KNOWLEDGE_ID}:documents/travel.md",
            "source_path": "documents/travel.md",
            "title": "출장 규정",
            "section": "s1",
            "page": 1,
        },
    ]

    citations = await _search(tmp_path, monkeypatch, metadata)

    by_chunk = {c["chunk_id"]: c for c in citations}
    assert by_chunk["c1"]["document_id"] == f"{KNOWLEDGE_ID}:documents/hr-policy.md"
    assert by_chunk["c2"]["document_id"] == f"{KNOWLEDGE_ID}:documents/travel.md"


@pytest.mark.asyncio
async def test_document_id_is_empty_for_an_index_built_before_the_field(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The field must be present and empty — not absent, and above all not
    guessed from source_path. A locally invented id would look exactly like
    an indexer-issued one to every consumer."""
    metadata = [
        {"source_path": "documents/hr-policy.md", "title": "인사 규정", "section": "s1", "page": 1},
        {"source_path": "documents/travel.md", "title": "출장 규정", "section": "s1", "page": 1},
    ]

    citations = await _search(tmp_path, monkeypatch, metadata)

    for citation in citations:
        assert citation["document_id"] == ""
        # The presentation fields still work — the fallback path stays open.
        assert citation["document_path"]


@pytest.mark.asyncio
async def test_document_id_does_not_disturb_the_existing_citation_shape(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Additive only: every field consumers already read must be untouched."""
    metadata = [
        {
            "document_id": f"{KNOWLEDGE_ID}:documents/hr-policy.md",
            "source_path": "documents/hr-policy.md",
            "title": "인사 규정",
            "section": "s1",
            "page": 3,
        },
        {
            "document_id": f"{KNOWLEDGE_ID}:documents/travel.md",
            "source_path": "documents/travel.md",
            "title": "출장 규정",
            "section": "s2",
            "page": 1,
        },
    ]

    citations = await _search(tmp_path, monkeypatch, metadata)

    first = citations[0]
    assert first["document_path"] == "documents/hr-policy.md"
    assert first["document_title"] == "인사 규정"
    assert first["section"] == "s1"
    assert first["page"] == 3
    assert "excerpt" in first and "score" in first and "similarity" in first
