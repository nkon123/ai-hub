"""Strategy dispatch (indexing_runtime.chunkers.chunk_documents) — pure, no I/O."""

from __future__ import annotations

import pytest
from indexing_runtime.chunkers import chunk_documents
from indexing_runtime.profile import resolve_profile

DOC = {
    "document_id": "kb-1:d.md",
    "content": "# 제목\n\n## 절1\n\n본문 내용입니다.\n\n## 절2\n\n또 다른 본문입니다.\n",
    "metadata": {"source_path": "/src/d.md", "title": "d", "file_name": "d.md"},
}


def test_default_profile_dispatches_to_parent_child_and_produces_parents():
    profile = resolve_profile(None)

    parents, children = chunk_documents([DOC], "kb-1", profile)

    assert parents  # parent_child is the only strategy with a Parent Store
    assert children
    for c in children:
        assert c["metadata"]["parent_id"] in {p["id"] for p in parents}


def test_recursive_profile_produces_no_parents():
    profile = resolve_profile({"chunking_strategy": "recursive"})

    parents, children = chunk_documents([DOC], "kb-1", profile)

    assert parents == []
    assert children
    for c in children:
        assert "parent_id" not in c["metadata"]


def test_markdown_profile_produces_no_parents_but_has_title_path():
    profile = resolve_profile({"chunking_strategy": "markdown"})

    parents, children = chunk_documents([DOC], "kb-1", profile)

    assert parents == []
    assert children
    assert any(c["metadata"]["title_path"] == ["제목", "절1"] for c in children)


def test_unknown_strategy_raises_at_dispatch_time():
    profile = dict(resolve_profile(None))
    profile["chunking_strategy"] = "not_a_real_strategy"

    with pytest.raises(ValueError, match="Unknown chunking_strategy"):
        chunk_documents([DOC], "kb-1", profile)


def test_multiple_documents_all_get_chunked():
    doc2 = {
        "document_id": "kb-1:e.md",
        "content": "# 다른 문서\n\n내용.\n",
        "metadata": {"source_path": "/src/e.md", "title": "e", "file_name": "e.md"},
    }
    profile = resolve_profile({"chunking_strategy": "markdown"})

    _parents, children = chunk_documents([DOC, doc2], "kb-1", profile)

    document_ids = {c["metadata"]["document_id"] for c in children}
    assert document_ids == {"kb-1:d.md", "kb-1:e.md"}
