"""Parent-Child chunking strategy (04-knowledge-platform.md §2.5 Parent-Child)."""

from __future__ import annotations

from indexing_runtime.chunkers.parent_child import parent_child_chunk_document

DOC_CONTENT = """# 재택근무 정책

## 재택근무 신청

- 주 최대 2일까지 재택근무를 신청할 수 있다.
- 신청은 팀장 승인 후 확정된다.

## 장비 지원

- 재택근무자에게는 모니터 1대와 노트북 거치대를 지급한다.
- 인터넷 요금은 월 3만원까지 지원한다.

## 근무 시간

- 재택근무 중에도 코어타임은 동일하게 적용된다.
"""


def _make_doc(content: str = DOC_CONTENT) -> dict:
    return {
        "document_id": "kb-1:remote-work-policy.md",
        "content": content,
        "metadata": {
            "source_path": "/src/remote-work-policy.md",
            "title": "remote-work-policy",
            "file_name": "remote-work-policy.md",
        },
    }


def test_children_reference_parent_id():
    doc = _make_doc()

    parents, children = parent_child_chunk_document(
        doc, "kb-1", parent_chunk_size=200, chunk_size=80, chunk_overlap=10, minimum_size=10
    )

    parent_ids = {p["id"] for p in parents}
    assert parent_ids
    for c in children:
        assert c["parent_id"] in parent_ids
        assert c["metadata"]["parent_id"] in parent_ids


def test_parent_text_is_not_duplicated_into_child_metadata():
    """§2.5 forbids: '모든 Child Metadata에 Parent 본문을 중복 저장'."""
    doc = _make_doc()

    parents, children = parent_child_chunk_document(
        doc, "kb-1", parent_chunk_size=200, chunk_size=80, chunk_overlap=10, minimum_size=10
    )

    parent_texts = {p["text"] for p in parents}
    for c in children:
        assert "text" not in c["metadata"]
        for key, value in c["metadata"].items():
            if isinstance(value, str):
                assert value not in parent_texts or len(value) < 20, (
                    f"child metadata key {key!r} appears to carry parent body text"
                )


def test_parents_are_stored_once_not_per_child():
    doc = _make_doc()

    parents, children = parent_child_chunk_document(
        doc, "kb-1", parent_chunk_size=100, chunk_size=40, chunk_overlap=5, minimum_size=5
    )

    # At least one parent must have produced more than one child, proving
    # the parent body itself is not re-emitted per child.
    parent_child_counts: dict[str, int] = {}
    for c in children:
        parent_child_counts[c["parent_id"]] = parent_child_counts.get(c["parent_id"], 0) + 1
    assert any(count > 1 for count in parent_child_counts.values())

    parent_ids = [p["id"] for p in parents]
    assert len(set(parent_ids)) == len(parent_ids)  # each parent appears exactly once


def test_ids_unique_and_stable_across_reruns():
    doc = _make_doc()

    parents1, children1 = parent_child_chunk_document(
        doc, "kb-1", parent_chunk_size=200, chunk_size=80, chunk_overlap=10, minimum_size=10
    )
    parents2, children2 = parent_child_chunk_document(
        doc, "kb-1", parent_chunk_size=200, chunk_size=80, chunk_overlap=10, minimum_size=10
    )

    assert [p["id"] for p in parents1] == [p["id"] for p in parents2]
    assert [c["id"] for c in children1] == [c["id"] for c in children2]

    all_ids = [p["id"] for p in parents1] + [c["id"] for c in children1]
    assert len(set(all_ids)) == len(all_ids)


def test_heading_section_metadata_tags_parents_for_citation_quality():
    """Parent-Child splits by size, not headings, but each parent should
    still carry a sensible `section`/`title_path` from the heading it falls
    under — this is what keeps citations on real HR-policy documents
    meaningful under Parent-Child, not just under the Markdown strategy."""
    doc = _make_doc()

    parents, _children = parent_child_chunk_document(
        doc, "kb-1", parent_chunk_size=80, chunk_size=40, chunk_overlap=5, minimum_size=5
    )

    sections = {p["metadata"]["section"] for p in parents}
    assert sections & {"재택근무 정책", "재택근무 신청", "장비 지원", "근무 시간"}


REAL_REMOTE_WORK_POLICY_CONTENT = """# 재택근무 정책

## 재택근무 신청

- 주 최대 2일까지 재택근무를 신청할 수 있다.
- 신청은 팀장 승인 후 확정된다.

## 장비 지원

- 재택근무자에게는 모니터 1대와 노트북 거치대를 지급한다.
- 인터넷 요금은 월 3만원까지 지원한다.

## 근무 시간

- 재택근무 중에도 코어타임(오전 10시~오후 4시)은 동일하게 적용된다.
"""


def test_heading_boundaries_are_hard_split_points_not_just_tags():
    """Regression test for the 2026-08-07 production incident.

    A prior revision made heading sections a *tag* applied after size-based
    splitting rather than a *hard split boundary* applied before it. Because
    `parent_chunk_size` (2048, the profile default) is far larger than this
    real seeded document (193 characters — copied verbatim from
    `apps/portal-api/storage/knowledge/.../remote-work-policy.md`), the
    whole document collapsed into a single parent/child spanning all three
    `##` sections. Its embedding was then diluted across unrelated topics
    (재택근무 신청/장비 지원/근무 시간) until every real question fell below
    the D-046 similarity threshold and the published chatbot stopped
    answering — while all 60 chunker unit tests (which used synthetic,
    smaller `parent_chunk_size` values that happened not to exceed the
    fixture's length) kept passing.

    This must produce one chunk per `##` section (four total, including the
    bare `#` title section), each tagged with its own specific heading —
    not one chunk for the whole document, and not the document title
    ("재택근무 정책") on every chunk.
    """
    doc = _make_doc(REAL_REMOTE_WORK_POLICY_CONTENT)

    # Profile defaults (indexing_runtime.profile.DEFAULT_PROFILE): the exact
    # sizes that were in effect for the live document when this broke —
    # both are far bigger than the whole document, which is the point.
    parents, children = parent_child_chunk_document(
        doc, "kb-1", parent_chunk_size=2048, chunk_size=512, chunk_overlap=64, minimum_size=64
    )

    assert len(parents) == 4
    assert len(children) == 4

    sections = [c["metadata"]["section"] for c in children]
    assert sections == ["재택근무 정책", "재택근무 신청", "장비 지원", "근무 시간"]

    # The specific-heading assertion that actually broke: every non-title
    # chunk's section must be its own heading, never the document title
    # bleeding across sections because everything got merged into one span.
    equipment = next(c for c in children if c["metadata"]["section"] == "장비 지원")
    assert "모니터 1대" in equipment["text"]
    assert "인터넷 요금" in equipment["text"]
    assert "재택근무 신청" not in equipment["text"]
    assert "코어타임" not in equipment["text"]


def test_citation_critical_metadata_keys_survive_on_parents_and_children():
    doc = _make_doc()

    parents, children = parent_child_chunk_document(
        doc, "kb-1", parent_chunk_size=200, chunk_size=80, chunk_overlap=10, minimum_size=10
    )

    for record in [*parents, *children]:
        meta = record["metadata"]
        assert meta["source_path"] == "/src/remote-work-policy.md"
        assert meta["title"] == "remote-work-policy"
        assert isinstance(meta["page"], int)
        assert "section" in meta
