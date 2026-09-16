"""`run_pipeline` must not hand Chroma more records than it accepts at once.

Real chromadb (1.5.9) refuses a single `add()` above its max batch size with
`InternalError: ValueError: Batch size of N is greater than max batch size of
5461`. That kills the job AFTER every embedding has been computed — the most
expensive possible moment to fail, and for this repo's first large document
(a 21MB reference guide, 41,954 child chunks) it was unavoidable.

The bug hid for so long because every Knowledge asset here produced a few
dozen chunks, so one `add()` was always enough. These tests force the batching
path with a small, explicit limit instead of generating 5461+ chunks.

No Ollama/Chroma network I/O — both are faked (see conftest.py).
"""

from __future__ import annotations

import pytest
from indexing_runtime import pipeline

from .conftest import patch_chroma, patch_embed_batch

KNOWLEDGE_ID = "44444444-4444-4444-4444-444444444444"


def _write_many_sections(tmp_path, section_count: int):
    """A document that reliably chunks into at least `section_count` children
    — `parent_child` splits on headings first, so one heading per section."""
    src = tmp_path / "source"
    src.mkdir()
    body = "\n".join(
        f"## 항목 {i}\n\n이것은 {i}번째 절의 본문입니다. 검색 대상 문장입니다.\n"
        for i in range(section_count)
    )
    (src / "doc.md").write_text(f"# 문서\n\n{body}", encoding="utf-8")
    return src


async def _run(tmp_path, monkeypatch, *, max_batch_size, section_count):
    src = _write_many_sections(tmp_path, section_count)
    client = patch_chroma(monkeypatch, pipeline, max_batch_size=max_batch_size)
    patch_embed_batch(monkeypatch, pipeline)

    result = await pipeline.run_pipeline(
        storage_path=str(src),
        knowledge_id=KNOWLEDGE_ID,
        index_base=str(tmp_path / "indexes"),
    )
    assert result["status"] == "COMPLETED", result
    return client.collection, result


@pytest.mark.asyncio
async def test_large_index_is_split_across_several_add_calls(tmp_path, monkeypatch) -> None:
    collection, result = await _run(
        tmp_path, monkeypatch, max_batch_size=10, section_count=45
    )

    assert len(collection.add_calls) > 1, "everything went in one call — batching did not happen"
    assert all(len(c["ids"]) <= 10 for c in collection.add_calls), (
        f"a batch exceeded the limit: {[len(c['ids']) for c in collection.add_calls]}"
    )
    assert len(collection.added["ids"]) == result["chunk_count"]


@pytest.mark.asyncio
async def test_every_chunk_still_reaches_the_index_exactly_once(tmp_path, monkeypatch) -> None:
    """Splitting must not drop or duplicate a chunk. A batching bug that loses
    the tail produces an index that works, returns plausible answers, and is
    quietly missing the end of every long document."""
    collection, result = await _run(
        tmp_path, monkeypatch, max_batch_size=7, section_count=40
    )

    ids = collection.added["ids"]
    assert len(ids) == result["chunk_count"]
    assert len(set(ids)) == len(ids), "a chunk was added twice"


@pytest.mark.asyncio
async def test_ids_documents_embeddings_and_metadata_stay_aligned(tmp_path, monkeypatch) -> None:
    """Each batch slices four parallel lists. Slicing one with different
    bounds than the others pairs chunks with other chunks' vectors and text —
    an index that is confidently, undetectably wrong."""
    collection, _ = await _run(tmp_path, monkeypatch, max_batch_size=6, section_count=30)

    for call in collection.add_calls:
        n = len(call["ids"])
        assert len(call["documents"]) == n
        assert len(call["embeddings"]) == n
        assert len(call["metadatas"]) == n


@pytest.mark.asyncio
async def test_small_index_still_uses_a_single_call(tmp_path, monkeypatch) -> None:
    """The common case must not become chattier than before."""
    collection, _ = await _run(tmp_path, monkeypatch, max_batch_size=5461, section_count=5)

    assert len(collection.add_calls) == 1


@pytest.mark.asyncio
async def test_a_client_without_the_limit_probe_still_indexes(tmp_path, monkeypatch) -> None:
    """`get_max_batch_size` is not a contract this repo controls. A client that
    lacks it (or raises) must fall back to a conservative bound, not fail."""
    collection, result = await _run(
        tmp_path, monkeypatch, max_batch_size=None, section_count=12
    )

    assert len(collection.added["ids"]) == result["chunk_count"]


def test_fallback_batch_size_stays_under_chromas_own_limit() -> None:
    """Chroma's documented default is 5461. A fallback above it would turn the
    "we couldn't ask" path back into the crash this module exists to prevent."""
    assert 0 < pipeline._CHROMA_FALLBACK_MAX_BATCH <= 5461


def test_limit_probe_rejects_a_nonsense_value() -> None:
    """A client reporting 0 would make `range(0, n, 0)` raise, failing indexing
    with a ValueError that names nothing useful."""

    class ZeroLimitClient:
        def get_max_batch_size(self) -> int:
            return 0

    assert pipeline._chroma_max_batch_size(ZeroLimitClient()) > 0
