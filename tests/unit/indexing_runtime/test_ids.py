"""ID/Hash scheme (04-knowledge-platform.md §2.6).

Pure functions, no Ollama/Chroma/network involved.
"""

from __future__ import annotations

from indexing_runtime.chunkers.ids import make_child_id, make_document_id, make_parent_id


def test_document_id_is_namespace_plus_normalized_relative_path():
    assert make_document_id("kb-1", "docs/a.md") == "kb-1:docs/a.md"


def test_collision_regression_different_sections_same_text_get_different_parent_ids():
    """The bug this replaces: the old `_chunk_id(knowledge_id, text)` hashed
    content only, so two different sections containing the identical
    sentence produced the SAME id (2 chunks -> 1 unique id), silently
    dropping one on Chroma upsert. Position (and/or anchor) must
    disambiguate same-text siblings."""
    document_id = "kb-1:docs/a.md"
    text = "동일한 문장입니다."

    parent_a = make_parent_id(document_id, 0, "Section A", text)
    parent_b = make_parent_id(document_id, 1, "Section B", text)

    assert parent_a != parent_b


def test_collision_regression_same_position_different_anchor_still_differs():
    """Even at the same numeric index, a different anchor (e.g. different
    Title Path) must still produce a different id."""
    document_id = "kb-1:docs/a.md"
    text = "동일한 문장입니다."

    parent_a = make_parent_id(document_id, 0, "Section A", text)
    parent_b = make_parent_id(document_id, 0, "Section B", text)

    assert parent_a != parent_b


def test_collision_regression_chunk_ids_differ_too():
    parent_a = make_parent_id("kb-1:docs/a.md", 0, "Section A", "text")
    parent_b = make_parent_id("kb-1:docs/a.md", 1, "Section B", "text")

    child_a = make_child_id(parent_a, 0, "", "동일한 문장입니다.")
    child_b = make_child_id(parent_b, 0, "", "동일한 문장입니다.")

    assert child_a != child_b


def test_different_documents_same_everything_else_still_differ():
    text = "동일한 문장입니다."
    id1 = make_parent_id("kb-1:docs/a.md", 0, "", text)
    id2 = make_parent_id("kb-1:docs/b.md", 0, "", text)
    assert id1 != id2


def test_stability_parent_id_is_deterministic_across_reruns():
    """§2.6 acceptance criterion: 동일 Source와 Indexing Profile로 재실행했을
    때 동일 Stable ID를 생성한다 — no dependence on wall-clock time, object
    identity, or iteration order beyond the explicit index/anchor inputs."""
    args = ("kb-1:docs/a.md", 3, "장비 지원", "재택근무자에게는 모니터 1대를 지급한다.")
    assert make_parent_id(*args) == make_parent_id(*args)


def test_stability_chunk_id_is_deterministic_across_reruns():
    parent_id = make_parent_id("kb-1:docs/a.md", 3, "장비 지원", "parent text")
    args = (parent_id, 2, "", "child text")
    assert make_child_id(*args) == make_child_id(*args)


def test_content_change_changes_the_id():
    """A changed document must produce a different id (the id doubles as a
    lightweight change-detection signal per §2.6's stated purpose)."""
    base = make_parent_id("kb-1:docs/a.md", 0, "", "original text")
    changed = make_parent_id("kb-1:docs/a.md", 0, "", "edited text")
    assert base != changed
