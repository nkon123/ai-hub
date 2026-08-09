"""Markdown heading parsing shared by markdown.py and parent_child.py."""

from __future__ import annotations

from indexing_runtime.chunkers.heading import parse_heading_sections, section_at


def test_no_headings_returns_single_section_with_empty_title_path():
    content = "그냥 평문입니다. 제목이 없습니다."

    sections = parse_heading_sections(content)

    assert len(sections) == 1
    assert sections[0]["title_path"] == []
    assert sections[0]["text"] == content


def test_preamble_before_first_heading_is_kept_as_its_own_section():
    content = "머리말입니다.\n\n# 제목\n\n본문\n"

    sections = parse_heading_sections(content)

    assert sections[0]["title_path"] == []
    assert "머리말" in sections[0]["text"]
    assert sections[1]["title_path"] == ["제목"]


def test_h3_nests_under_most_recent_h2_under_most_recent_h1():
    content = "# A\n\n## B\n\n### C\n\ntext\n"

    sections = parse_heading_sections(content)

    title_paths = [s["title_path"] for s in sections]
    assert title_paths == [["A"], ["A", "B"], ["A", "B", "C"]]


def test_new_h2_resets_h3_nesting():
    content = "# A\n\n## B\n\n### C\n\n## D\n\ntext\n"

    sections = parse_heading_sections(content)

    title_paths = [s["title_path"] for s in sections]
    assert title_paths == [["A"], ["A", "B"], ["A", "B", "C"], ["A", "D"]]


def test_sections_cover_the_full_content_contiguously():
    content = "# A\n\nbody a\n\n## B\n\nbody b\n"

    sections = parse_heading_sections(content)

    assert sections[0]["start"] == 0
    assert sections[-1]["end"] == len(content)
    for i in range(len(sections) - 1):
        assert sections[i]["end"] == sections[i + 1]["start"]


def test_section_at_returns_index_and_title_path_for_offset():
    content = "# A\n\nbody a\n\n## B\n\nbody b\n"
    sections = parse_heading_sections(content)

    offset_in_b = content.index("body b")
    idx, title_path = section_at(sections, offset_in_b)

    assert title_path == ["A", "B"]
    assert sections[idx]["title_path"] == ["A", "B"]
