"""Markdown chunking strategy (04-knowledge-platform.md §2.5 Markdown)."""

from __future__ import annotations

from indexing_runtime.chunkers.markdown import markdown_chunk_document

DOC_CONTENT = """# 재택근무 정책

## 재택근무 신청

- 주 최대 2일까지 재택근무를 신청할 수 있다.
- 신청은 팀장 승인 후 확정된다.

## 장비 지원

- 재택근무자에게는 모니터 1대와 노트북 거치대를 지급한다.
- 인터넷 요금은 월 3만원까지 지원한다.

### 세부 규정

이 항목은 상세 규정을 담고 있다.

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


def _chunk(doc: dict, *, chunk_size: int = 512, chunk_overlap: int = 64, minimum_size: int = 10):
    return markdown_chunk_document(doc, "kb-1", chunk_size, chunk_overlap, minimum_size)


def test_splits_on_h1_h2_and_h3():
    doc = _make_doc()

    children = _chunk(doc)

    sections = [c["metadata"]["section"] for c in children]
    assert sections == ["재택근무 정책", "재택근무 신청", "장비 지원", "세부 규정", "근무 시간"]


def test_title_path_reflects_heading_nesting():
    doc = _make_doc()

    children = _chunk(doc)

    by_section = {c["metadata"]["section"]: c["metadata"]["title_path"] for c in children}
    assert by_section["재택근무 정책"] == ["재택근무 정책"]
    assert by_section["장비 지원"] == ["재택근무 정책", "장비 지원"]
    # H3 nests under the most recent H2, which nests under the H1.
    assert by_section["세부 규정"] == ["재택근무 정책", "장비 지원", "세부 규정"]


def test_small_sections_are_kept_whole():
    doc = _make_doc()

    children = _chunk(doc)

    # Every section here is well under chunk_size=512 -> exactly one chunk
    # per heading, none of them recursively re-split.
    assert len(children) == 5
    equipment = next(c for c in children if c["metadata"]["section"] == "장비 지원")
    assert "모니터 1대" in equipment["text"]
    assert "인터넷 요금" in equipment["text"]


def test_large_section_is_recursively_split_small_sections_are_not():
    large_body = "이 항목은 상세 규정을 담고 있다. " * 40  # forces a split
    content = f"# 문서\n\n## 짧은 절\n\n짧다.\n\n## 긴 절\n\n{large_body}\n"
    doc = _make_doc(content)

    children = _chunk(doc, chunk_size=200, chunk_overlap=20)

    short_chunks = [c for c in children if c["metadata"]["section"] == "짧은 절"]
    long_chunks = [c for c in children if c["metadata"]["section"] == "긴 절"]
    assert len(short_chunks) == 1
    assert len(long_chunks) > 1
    assert all(len(c["text"]) <= 200 + 20 for c in long_chunks)  # allow overlap slack


def test_chunk_ids_are_unique_and_stable():
    doc = _make_doc()

    first = _chunk(doc)
    second = _chunk(doc)

    ids = [c["id"] for c in first]
    assert len(set(ids)) == len(ids)
    assert [c["id"] for c in second] == ids


def test_citation_critical_metadata_keys_survive():
    doc = _make_doc()

    children = _chunk(doc)

    for c in children:
        meta = c["metadata"]
        assert meta["source_path"] == "/src/remote-work-policy.md"
        assert meta["title"] == "remote-work-policy"
        assert isinstance(meta["page"], int)
        assert meta["section"]  # non-empty leaf title
        # Markdown strategy has no Parent Store either.
        assert "parent_id" not in meta
