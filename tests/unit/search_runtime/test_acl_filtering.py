"""hybrid_search's metadata_predicate plumbing (04-knowledge-platform.md
§3.8) — filtering happens on the full candidate list before top_k*2
truncation on both the BM25 and vector sides, not after (see hybrid.py
docstring). Built directly on access_control.chunk_is_visible so this
exercises the real end-to-end shape main.py wires up, not a toy predicate.

No live Ollama/Chroma — same fakes as test_relevance_filter.py."""

from __future__ import annotations

import pytest
from search_runtime import access_control, hybrid

from .conftest import patch_chroma, patch_embed_query, write_bm25_index

KNOWLEDGE_ID = "22222222-2222-2222-2222-222222222222"

CHUNK_IDS = ["c1", "c2", "c3", "c4"]
CHUNK_TEXTS = ["c1 text", "c2 text", "c3 text", "c4 text"]
# c1: CONFIDENTIAL (should be withheld from an INTERNAL-clearance caller)
# c2/c3/c4: INTERNAL (visible)
def _meta(section: str, classification: str) -> dict:
    return {
        "source_path": "doc.md",
        "title": "Doc",
        "section": section,
        "page": 1,
        "classification": classification,
    }


CHUNK_METADATA = [
    _meta("s1", "CONFIDENTIAL"),
    _meta("s2", "INTERNAL"),
    _meta("s3", "INTERNAL"),
    _meta("s4", "INTERNAL"),
]
# c1 ranks first on both BM25 and vector — if filtering happened only after
# top_k truncation with top_k=1, it would still leak through. top_k=1 here
# specifically exercises that the forced filter runs BEFORE truncation.
BM25_SCORES = [10, 5, 1, 0]
VECTOR_IDS = ["c1", "c2", "c3", "c4"]
VECTOR_DISTANCES = [0.1, 0.2, 0.3, 0.4]  # c1 has the best (lowest) distance


def _predicate_for_clearance(clearance: str):
    allowed = access_control.forced_allowed_classifications(
        access_control.Classification(clearance), allow_unknown_classification=False
    )

    def predicate(metadata: dict) -> bool:
        return access_control.chunk_is_visible(
            metadata, allowed_classifications=allowed, business_filters={}
        )

    return predicate


@pytest.mark.asyncio
async def test_confidential_chunk_withheld_from_internal_clearance_even_when_top_ranked(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
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

    citations = await hybrid.hybrid_search(
        query="아무 질문",
        knowledge_id=KNOWLEDGE_ID,
        top_k=1,  # deliberately tight — c1 is rank-0 on both retrievers
        index_base=str(tmp_path),
        min_relevance_score=0,
        metadata_predicate=_predicate_for_clearance("INTERNAL"),
    )

    returned_ids = [c["chunk_id"] for c in citations]
    assert "c1" not in returned_ids
    assert returned_ids == ["c2"]  # next-best allowed chunk, not empty/short-circuited


@pytest.mark.asyncio
async def test_confidential_clearance_sees_the_confidential_chunk(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
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

    citations = await hybrid.hybrid_search(
        query="아무 질문",
        knowledge_id=KNOWLEDGE_ID,
        top_k=1,
        index_base=str(tmp_path),
        min_relevance_score=0,
        metadata_predicate=_predicate_for_clearance("CONFIDENTIAL"),
    )

    assert [c["chunk_id"] for c in citations] == ["c1"]


@pytest.mark.asyncio
async def test_no_predicate_reproduces_unfiltered_behavior(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """metadata_predicate=None (the default) must be byte-for-byte the
    pre-ACL behavior — every pre-existing caller of hybrid_search is
    unaffected."""
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

    citations = await hybrid.hybrid_search(
        query="아무 질문",
        knowledge_id=KNOWLEDGE_ID,
        top_k=1,
        index_base=str(tmp_path),
        min_relevance_score=0,
    )

    assert [c["chunk_id"] for c in citations] == ["c1"]
