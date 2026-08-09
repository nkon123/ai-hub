"""Document-id <-> citation matching rule (D-045)."""

from __future__ import annotations

from evaluation_runner.matching import document_id_from_citation, normalize_expected_document_id
from evaluation_runner.search_client import Citation


def _citation(document_path: str = "", document_title: str = "") -> Citation:
    return Citation(
        chunk_id="c1",
        parent_chunk_id=None,
        document_path=document_path,
        document_title=document_title,
        page=1,
        section="s",
        excerpt="",
        parent_context="",
        score=1.0,
    )


def test_document_id_uses_filename_stem_of_document_path() -> None:
    citation = _citation(document_path="/storage/knowledge/xyz/1.0.0/remote-work-policy.md")
    assert document_id_from_citation(citation) == "remote-work-policy"


def test_document_id_falls_back_to_document_title_when_path_missing() -> None:
    citation = _citation(document_path="", document_title="Remote-Work-Policy.md")
    assert document_id_from_citation(citation) == "remote-work-policy"


def test_document_id_empty_when_both_missing() -> None:
    citation = _citation()
    assert document_id_from_citation(citation) == ""


def test_normalize_expected_document_id_accepts_bare_id_or_filename() -> None:
    assert normalize_expected_document_id("remote-work-policy") == "remote-work-policy"
    assert normalize_expected_document_id("remote-work-policy.md") == "remote-work-policy"
    assert normalize_expected_document_id("Remote-Work-Policy.MD") == "remote-work-policy"
