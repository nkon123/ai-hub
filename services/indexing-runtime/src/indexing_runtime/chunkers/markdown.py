"""Markdown chunking strategy (04-knowledge-platform.md §2.5 Markdown).

1. `#`/`##`/`###` 제목으로 Section 분리 — chunkers/heading.py.
2. Section Metadata에 Title Path 저장 — `title_path` (list) + `section`
   (leaf title, kept for backward-compatible citation metadata).
3. 큰 Section만 Recursive 분할 — sections under chunk_size are kept whole.
4. Chunk 본문 또는 Metadata에 제목 Context 포함 — chosen: Metadata only
   (`title_path`/`section`), not prepended to the embedded text, so the
   embedding stays the section's own wording rather than a mix of heading
   breadcrumb + body.

No Parent Store is written for this strategy (same reasoning as Recursive —
see chunkers/recursive.py's docstring on the synthetic, unpersisted
`make_parent_id` anchor).
"""

from __future__ import annotations

from indexing_runtime.chunkers.heading import parse_heading_sections
from indexing_runtime.chunkers.ids import make_child_id, make_parent_id
from indexing_runtime.chunkers.recursive import recursive_split


def markdown_chunk_document(
    doc: dict, knowledge_id: str, chunk_size: int, chunk_overlap: int, minimum_size: int
) -> list[dict]:
    content = doc["content"]
    document_id = doc["document_id"]
    meta = doc["metadata"]

    sections = parse_heading_sections(content)
    children: list[dict] = []
    child_index = 0

    for section_index, section in enumerate(sections):
        text = section["text"].strip()
        if not text:
            continue
        title_path: list[str] = section["title_path"]
        anchor = " > ".join(title_path)
        section_leaf = title_path[-1] if title_path else ""

        unit_id = make_parent_id(document_id, section_index, anchor, text)
        pieces = (
            recursive_split(text, chunk_size, chunk_overlap, minimum_size)
            if len(text) > chunk_size
            else [text]
        )

        for piece in pieces:
            chunk_id = make_child_id(unit_id, child_index, anchor, piece)
            children.append(
                {
                    "id": chunk_id,
                    "text": piece,
                    "metadata": {
                        "knowledge_id": knowledge_id,
                        "document_id": document_id,
                        "source_path": meta.get("source_path", ""),
                        "title": meta.get("title", ""),
                        "section": section_leaf,
                        "title_path": title_path,
                        "page": section_index + 1,
                        "chunk_type": "markdown_section",
                    },
                }
            )
            child_index += 1

    return children
