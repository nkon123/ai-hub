"""Recursive chunking strategy (04-knowledge-platform.md §2.5 Recursive).

All values below were verified against the implementation (not just hand
derived) — see the module docstring in chunkers/recursive.py for the
algorithm. No Ollama/Chroma/network involved.
"""

from __future__ import annotations

from indexing_runtime.chunkers.recursive import (
    recursive_chunk_document,
    recursive_split,
    recursive_split_spans,
)


def test_separator_precedence_prefers_paragraph_boundary_over_sentence_or_char():
    """Two paragraphs that individually fit chunk_size but not combined must
    split at the blank-line boundary, not descend into sentence/char level."""
    para1 = "가" * 50
    para2 = "나" * 50
    text = f"{para1}\n\n{para2}"

    chunks = recursive_split(text, chunk_size=60, chunk_overlap=0, minimum_size=1)

    assert chunks == [para1, para2]


def test_separator_precedence_falls_back_to_sentence_when_no_paragraphs():
    """A single paragraph (no blank lines) made of distinguishable sentences
    must split at sentence boundaries, not mid-word/mid-character, once
    chunk_size is too small for the whole paragraph."""
    s1 = "가" * 30 + ". "
    s2 = "나" * 30 + ". "
    s3 = "다" * 30 + "."
    text = s1 + s2 + s3

    chunks = recursive_split(text, chunk_size=40, chunk_overlap=0, minimum_size=1)

    assert chunks == ["가" * 30 + ".", "나" * 30 + ".", "다" * 30 + "."]


def test_falls_back_to_character_level_when_no_separators_exist_at_all():
    """No paragraphs, no lines, no sentence punctuation, no spaces — must
    still terminate and respect chunk_size via character-level splitting."""
    text = "A" * 100

    spans = recursive_split_spans(text, chunk_size=30, chunk_overlap=0, minimum_size=1)

    assert [e - s for s, e in spans] == [30, 30, 30, 10]
    # No content lost or duplicated (no overlap requested).
    assert "".join(text[s:e] for s, e in spans) == text


def test_overlap_is_applied_between_consecutive_chunks():
    text = "0123456789" * 10  # 100 chars, no natural separators

    spans = recursive_split_spans(text, chunk_size=20, chunk_overlap=5, minimum_size=1)

    assert len(spans) > 1
    for i in range(len(spans) - 1):
        assert spans[i + 1][0] == spans[i][1] - 5
    assert all(e - s <= 20 for s, e in spans)


def test_zero_overlap_produces_contiguous_non_overlapping_chunks():
    text = "0123456789" * 10

    spans = recursive_split_spans(text, chunk_size=20, chunk_overlap=0, minimum_size=1)

    for i in range(len(spans) - 1):
        assert spans[i + 1][0] == spans[i][1]


def test_short_trailing_chunk_is_merged_into_previous_not_dropped():
    """§2.5: '너무 짧은 마지막 청크는 앞 청크와 병합 가능'. The short tail's
    content must survive (merged in), never silently discarded, and only
    the trailing pair merges — earlier chunks are untouched."""
    para_a = "A" * 50
    para_b = "B" * 45
    para_c = "C" * 4  # too short on its own
    text = f"{para_a}\n\n{para_b}\n\n{para_c}"

    chunks = recursive_split(text, chunk_size=50, chunk_overlap=0, minimum_size=10)

    assert len(chunks) == 2
    assert chunks[0] == para_a
    assert chunks[1].endswith(para_c)
    assert para_b in chunks[1]


def test_minimum_size_small_enough_leaves_chunks_unmerged():
    para_a = "A" * 50
    para_b = "B" * 45
    para_c = "C" * 4
    text = f"{para_a}\n\n{para_b}\n\n{para_c}"

    chunks = recursive_split(text, chunk_size=50, chunk_overlap=0, minimum_size=2)

    assert len(chunks) == 3
    assert chunks[-1] == para_c


def test_recursive_chunk_document_produces_unique_stable_ids_and_metadata():
    doc = {
        "document_id": "kb-1:plain.txt",
        "content": ("이것은 " * 50) + ("구조가 약한 일반 텍스트 문서입니다. " * 20),
        "metadata": {"source_path": "/src/plain.txt", "title": "plain", "file_name": "plain.txt"},
    }

    children = recursive_chunk_document(
        doc, "kb-1", chunk_size=200, chunk_overlap=20, minimum_size=20
    )

    assert len(children) > 1
    ids = [c["id"] for c in children]
    assert len(set(ids)) == len(ids)

    # Rebuild stability: same input -> same ids.
    again = recursive_chunk_document(doc, "kb-1", chunk_size=200, chunk_overlap=20, minimum_size=20)
    assert [c["id"] for c in again] == ids

    # Citation-critical metadata keys survive (search_runtime.hybrid reads these).
    for c in children:
        meta = c["metadata"]
        assert meta["source_path"] == "/src/plain.txt"
        assert meta["title"] == "plain"
        assert "page" in meta
        assert "section" in meta
        # Recursive has no Parent Store — no parent_id is claimed.
        assert "parent_id" not in meta
