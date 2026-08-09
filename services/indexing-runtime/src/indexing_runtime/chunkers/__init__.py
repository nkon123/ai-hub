"""Chunking strategy dispatch (04-knowledge-platform.md §2.5).

Each strategy lives in its own module (single responsibility):
  - recursive.py    — paragraph/line/sentence/whitespace/char splitting
  - markdown.py      — heading-based splitting + Title Path metadata
  - parent_child.py  — size-based Parent/Child splitting + Parent Store

This module only selects among them based on a resolved profile dict (see
indexing_runtime.profile.resolve_profile) and concatenates their per-document
output into the pipeline's (parents, children) shape.
"""

from __future__ import annotations

from indexing_runtime.chunkers.markdown import markdown_chunk_document
from indexing_runtime.chunkers.parent_child import parent_child_chunk_document
from indexing_runtime.chunkers.recursive import recursive_chunk_document

__all__ = ["chunk_documents"]


def chunk_documents(
    documents: list[dict], knowledge_id: str, profile: dict
) -> tuple[list[dict], list[dict]]:
    """Chunk every loaded document per the resolved profile's strategy.

    `documents` is the Loader's common output shape (§2.3): each item has
    `document_id`, `content`, `metadata`. Returns (parents, children) —
    `parents` is empty for strategies without a Parent Store (recursive,
    markdown).
    """
    strategy = profile["chunking_strategy"]
    chunk_size = profile["chunk_size"]
    chunk_overlap = profile["chunk_overlap"]
    minimum_size = profile["minimum_size"]

    all_parents: list[dict] = []
    all_children: list[dict] = []

    for doc in documents:
        if strategy == "recursive":
            all_children.extend(
                recursive_chunk_document(doc, knowledge_id, chunk_size, chunk_overlap, minimum_size)
            )
        elif strategy == "markdown":
            all_children.extend(
                markdown_chunk_document(doc, knowledge_id, chunk_size, chunk_overlap, minimum_size)
            )
        elif strategy == "parent_child":
            parents, children = parent_child_chunk_document(
                doc,
                knowledge_id,
                profile["parent_chunk_size"],
                chunk_size,
                chunk_overlap,
                minimum_size,
            )
            all_parents.extend(parents)
            all_children.extend(children)
        else:
            raise ValueError(
                f"Unknown chunking_strategy: {strategy!r}; expected one of "
                "'recursive', 'markdown', 'parent_child'"
            )

    return all_parents, all_children
