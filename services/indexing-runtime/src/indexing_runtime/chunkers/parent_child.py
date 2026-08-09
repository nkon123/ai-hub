"""Parent-Child chunking strategy (04-knowledge-platform.md §2.5 Parent-Child).

1. Heading Section으로 먼저 Hard Split — `#`/`##`/`###` 경계를 Parent가
   넘어서지 않는다 (chunkers/heading.py::parse_heading_sections). §2.5는
   Parent-Child를 "긴 규정·업무 지침"처럼 문맥이 Section 구조로 나뉘는
   문서에 적합하다고 설명하므로, Section 경계는 Parent가 절대 가로지르지
   않는 Hard Boundary로 취급한다 — Size 기반 분할은 이 경계 *안에서만*
   적용된다 (D-053 후속, 2026-08-07 회귀 수정).
2. Section 내부에서 Parent Splitter로 문맥 생성 — recursive_split_spans at
   parent_chunk_size, Section 텍스트 범위로 한정.
3. Parent별 Stable ID 생성 — chunkers/ids.make_parent_id.
4. Parent를 Child Splitter로 분할 — recursive_split at chunk_size on each
   parent's own text.
5. Child에 parent_id만 저장 — parent text is never copied into child
   metadata, only `parent_id` (the forbidden case in §2.5: "모든 Child
   Metadata에 Parent 본문을 중복 저장").
6. Parent 본문은 parents 배열/맵에 한 번만 저장 — pipeline.py persists this
   as `parents.json`, one entry per parent id.

Each parent/child is tagged with the Title Path of the heading section it
was split from (chunkers/heading.py) for citation metadata (`section`).
Because sections are now a hard split boundary rather than a post-hoc tag,
this is exact, not a best-effort offset lookup — every parent falls under
exactly one section by construction.

Regression note (2026-08-07): a prior revision moved heading splitting from
the Loader into this module but implemented it as *tagging only* (Size
Splitter ran over the whole document first, `section_at` merely looked up
which heading an offset fell under afterwards). For documents smaller than
`parent_chunk_size` — e.g. `remote-work-policy.md`, 193 characters — the
entire document collapsed into a single parent/child spanning all sections,
diluting its embedding across unrelated topics until every real question
fell below the D-046 similarity threshold and the published chatbot stopped
answering. Splitting at heading boundaries *first* (this revision) restores
one-parent(-or-more)-per-section behavior regardless of how large
`parent_chunk_size` is relative to the document.
"""

from __future__ import annotations

from indexing_runtime.chunkers.heading import parse_heading_sections
from indexing_runtime.chunkers.ids import make_child_id, make_parent_id
from indexing_runtime.chunkers.recursive import recursive_split, recursive_split_spans


def parent_child_chunk_document(
    doc: dict,
    knowledge_id: str,
    parent_chunk_size: int,
    chunk_size: int,
    chunk_overlap: int,
    minimum_size: int,
) -> tuple[list[dict], list[dict]]:
    content = doc["content"]
    document_id = doc["document_id"]
    meta = doc["metadata"]

    sections = parse_heading_sections(content)

    parents: list[dict] = []
    children: list[dict] = []
    p_index = 0

    for section_index, section in enumerate(sections):
        section_text = section["text"]
        title_path: list[str] = section["title_path"]
        section_leaf = title_path[-1] if title_path else ""
        anchor = " > ".join(title_path)

        # Size-based splitting happens *within* this section only — the
        # heading boundary above is never crossed.
        parent_spans = recursive_split_spans(
            section_text, parent_chunk_size, chunk_overlap, minimum_size
        )

        for s_start, s_end in parent_spans:
            parent_text = section_text[s_start:s_end].strip()
            if not parent_text:
                continue

            parent_id = make_parent_id(document_id, p_index, anchor, parent_text)
            parents.append(
                {
                    "id": parent_id,
                    "text": parent_text,
                    "metadata": {
                        "knowledge_id": knowledge_id,
                        "document_id": document_id,
                        "source_path": meta.get("source_path", ""),
                        "title": meta.get("title", ""),
                        "section": section_leaf,
                        "title_path": title_path,
                        "page": section_index + 1,
                        "chunk_type": "parent",
                    },
                }
            )

            child_texts = recursive_split(parent_text, chunk_size, chunk_overlap, minimum_size)
            for c_index, child_text in enumerate(child_texts):
                chunk_id = make_child_id(parent_id, c_index, anchor, child_text)
                children.append(
                    {
                        "id": chunk_id,
                        "text": child_text,
                        "parent_id": parent_id,
                        "metadata": {
                            "knowledge_id": knowledge_id,
                            "document_id": document_id,
                            "source_path": meta.get("source_path", ""),
                            "title": meta.get("title", ""),
                            "section": section_leaf,
                            "title_path": title_path,
                            "page": section_index + 1,
                            "chunk_type": "child",
                            "parent_id": parent_id,
                        },
                    }
                )

            p_index += 1

    return parents, children
