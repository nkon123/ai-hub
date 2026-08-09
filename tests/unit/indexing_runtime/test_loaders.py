"""Document Loader (04-knowledge-platform.md §2.3) — reads real temp files
(pytest tmp_path) but no network/Ollama/Chroma involved."""

from __future__ import annotations

import hashlib

import pytest
from indexing_runtime.loaders import load_document


def test_load_markdown_returns_common_shape(tmp_path):
    path = tmp_path / "a.md"
    path.write_text("# 제목\n\n본문\n", encoding="utf-8")

    doc = load_document(path, document_id="kb-1:a.md")

    assert doc["document_id"] == "kb-1:a.md"
    assert doc["content"] == "# 제목\n\n본문\n"
    meta = doc["metadata"]
    assert meta["source_path"] == str(path)
    assert meta["file_name"] == "a.md"
    assert meta["mime_type"] == "text/markdown"
    assert meta["language"] == "ko"
    assert meta["title"] == "a"
    assert "modified_at" in meta


def test_load_document_computes_sha256_source_hash(tmp_path):
    path = tmp_path / "a.txt"
    raw = b"hello world"
    path.write_bytes(raw)

    doc = load_document(path, document_id="kb-1:a.txt")

    assert doc["metadata"]["source_hash"] == hashlib.sha256(raw).hexdigest()


def test_normalizes_crlf_to_lf(tmp_path):
    path = tmp_path / "a.txt"
    path.write_bytes(b"line1\r\nline2\r\n")

    doc = load_document(path, document_id="kb-1:a.txt")

    assert doc["content"] == "line1\nline2\n"


def test_unsupported_extension_raises():
    from pathlib import Path

    # .pptx (PowerPoint) is listed in 04-knowledge-platform.md §2.3 as a
    # future 확장 Loader, not yet implemented — unlike .pdf/.docx below, it's
    # a genuinely unsupported extension today.
    with pytest.raises(ValueError, match="Unsupported"):
        load_document(Path("/nonexistent/a.pptx"), document_id="kb-1:a.pptx")


def test_does_not_split_content_loader_is_not_a_chunker(tmp_path):
    """Regression guard: splitting by heading used to live in the loader
    (H1/H2 only) — the loader must now return the WHOLE file content as a
    single document; chunking strategy owns splitting."""
    path = tmp_path / "a.md"
    path.write_text("# H1\n\n## H2\n\n### H3\n\nbody\n", encoding="utf-8")

    doc = load_document(path, document_id="kb-1:a.md")

    assert doc["content"] == "# H1\n\n## H2\n\n### H3\n\nbody\n"
