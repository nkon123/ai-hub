"""ID and Hash derivation (04-knowledge-platform.md §2.6).

Design goal (see docs/implementation-spec/open-decisions.md D-053): every id
must be BOTH

  * unique per position — two different sections that happen to contain the
    identical text must not collide (the bug this module replaces: the old
    `_chunk_id` hashed content only, so two different sections with the same
    sentence produced the same id and silently overwrote each other on
    Chroma upsert), and
  * stable across rebuilds of unchanged input — re-running indexing on the
    same source and profile must reproduce the same ids, never rotating them
    because of incidental processing order.

Both properties fall out of the same construction: every id is built from
`f"{base}|{index}|{anchor}|{text}"` where `index` is the item's position
within its parent's deterministic iteration order (stable because loaders
sort by path and chunkers iterate lists in order) and `text` is the item's
own content. Position alone gives uniqueness for identical-text siblings;
content alone gives stability across reruns; combining them (rather than
hashing text alone, as before) gives both at once.
"""

from __future__ import annotations

import hashlib


def _short_hash(payload: str) -> str:
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]


def make_document_id(knowledge_id: str, relative_path: str) -> str:
    """document_id = Source Namespace(knowledge_id) + normalized relative path."""
    return f"{knowledge_id}:{relative_path}"


def make_parent_id(document_id: str, index: int, anchor: str, text: str) -> str:
    """parent_id = document_id + Parent order/anchor + Parent hash.

    Also used as the synthetic per-document "unit" base for strategies
    (recursive, markdown) that have no persisted Parent Store — see
    chunkers/recursive.py and chunkers/markdown.py for why that is safe.
    """
    digest = _short_hash(f"{document_id}|{index}|{anchor}|{text}")
    return f"{document_id}::p{index:04d}::{digest}"


def make_child_id(parent_id: str, index: int, anchor: str, text: str) -> str:
    """chunk_id = parent_id + Child order/anchor + Child hash."""
    digest = _short_hash(f"{parent_id}|{index}|{anchor}|{text}")
    return f"{parent_id}::c{index:04d}::{digest}"
