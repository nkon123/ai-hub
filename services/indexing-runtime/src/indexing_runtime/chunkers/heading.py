"""Markdown heading parsing shared by the Markdown and Parent-Child strategies.

The Markdown strategy (04-knowledge-platform.md §2.5) splits ON headings.
Parent-Child splits by size, not headings — but reuses this parser purely to
*tag* each parent with the Title Path of the heading section it falls under,
so citations on real HR-policy-style documents (`## 장비 지원`, ...) keep a
meaningful `section` value under Parent-Child too, not just under Markdown.
Splitting and metadata-tagging are kept as separate concerns on purpose.
"""

from __future__ import annotations

import re

_HEADING_RE = re.compile(r"^(#{1,3})[ \t]+(.+?)[ \t]*$", re.MULTILINE)


def parse_heading_sections(content: str) -> list[dict]:
    """Split `content` into sections at `#`/`##`/`###` headings.

    Returns a list of {"start", "end", "title_path", "text"} covering
    [0, len(content)) contiguously and in order. `title_path` is the stack of
    ancestor heading titles (e.g. ["재택근무 정책", "장비 지원"]) — empty for
    any text before the first heading (or for a document with no headings at
    all, in which case a single section covering the whole document with an
    empty title_path is returned).
    """
    matches = list(_HEADING_RE.finditer(content))
    if not matches:
        return [{"start": 0, "end": len(content), "title_path": [], "text": content}]

    sections: list[dict] = []

    if matches[0].start() > 0:
        preamble = content[: matches[0].start()]
        if preamble.strip():
            sections.append(
                {"start": 0, "end": matches[0].start(), "title_path": [], "text": preamble}
            )

    stack: list[tuple[int, str]] = []
    for i, match in enumerate(matches):
        level = len(match.group(1))
        title = match.group(2).strip()
        stack = [entry for entry in stack if entry[0] < level]
        stack.append((level, title))
        title_path = [t for _, t in stack]

        start = match.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(content)
        sections.append(
            {"start": start, "end": end, "title_path": title_path, "text": content[start:end]}
        )

    return sections


def section_at(sections: list[dict], offset: int) -> tuple[int, list[str]]:
    """Return (section_index, title_path) for the section containing `offset`.

    Falls back to the last section if `offset` is past the end (defensive —
    should not happen for a valid offset into the same `content`).
    """
    for idx, section in enumerate(sections):
        if section["start"] <= offset < section["end"]:
            return idx, section["title_path"]
    if sections:
        return len(sections) - 1, sections[-1]["title_path"]
    return 0, []
