"""Absolute build-host path relativization (04-knowledge-platform.md §4.1,
D-054's companion problem).

`services/indexing-runtime` stores each chunk/parent's `source_path` as the
*absolute* filesystem path it read from at index time — e.g.
`/Users/victory/Dev/.../apps/portal-api/storage/knowledge/<asset>/<version>/
remote-work-policy.md`. Shipping that verbatim leaks the build host's
directory layout and the builder's OS username to anyone who receives the
Knowledge Package. `knowledge_packager.scanner` FATALs on this pattern; this
module is the fix — it rewrites the *package's own copy* of the affected
artifacts so a package can be built clean instead of merely rejected.

Two artifacts carry this field, and BOTH turn out to have a residual
byte-level leak this module cannot fully eliminate — for two unrelated
reasons, both tracked as WARNING-severity scanner findings (never silently
dropped) per `package-policy.yaml`'s `known_residual_leak_artifacts`
override:

  - `parents.json` — a plain JSON file. Rewritten cleanly in place on the
    package's copy (never on the original under `data/indexes/`, which
    this package treats as strictly read-only). No residual leak here —
    the old value is gone once this function returns.

  - Chroma's child-chunk metadata — stored in `chroma.sqlite3`, not JSON,
    so it is safe to open with the `chromadb` client (not a pickle) and
    call `Collection.update()` to correct the copied collection's
    *queryable* metadata. **This does not fully clean the file**: Chroma
    persists every `add()`/`update()` call as an immutable row in an
    internal `embeddings_queue` table (its own write-ahead log for
    consistency/sync). `Collection.update()` appends a new queue entry; it
    does not delete the original `add()` entry, so the pre-relativization
    absolute path remains physically present in `chroma.sqlite3` — verified
    empirically by reading the `embeddings_queue.metadata` column directly
    with `sqlite3`, and confirmed a `VACUUM` afterward does not remove it
    (the row is live/referenced, not a freed page, so VACUUM has nothing to
    reclaim). `knowledge_packager.scanner`'s byte-level scan (see its module
    docstring) correctly still finds this residue; it is downgraded from
    FATAL to WARNING by policy rather than either lying about the package
    being clean or blocking the build over something this tool cannot fix.

`bm25.json` (D-054's resolution — see `knowledge_packager.bm25_inspect`
module docstring) carries the *same* `source_path` field inside its
`chunk_metadata` list, but since it is plain JSON, `rewrite_bm25_json`
below fixes it exactly the way `rewrite_parents_json` fixes `parents.json`
— no residual leak, no pickle involved. A package built from an index not
yet migrated to `bm25.json` still ships a legacy `bm25.pkl`, which for a
different reason is still not attempted: rewriting it would require
unpickling it, which `knowledge_packager.bm25_inspect`'s module docstring
explains this package refuses to do (arbitrary code execution risk) —
`bm25.pkl` therefore remains in `package-policy.yaml`'s
`known_residual_leak_artifacts` for exactly that (and only that) case.

See open-decisions.md D-054 for the Chroma residual-leak case and why it
remains only partially fixable.

For `parents.json`, the original absolute value is never retained anywhere
in the package (not even hashed) after rewriting — "레코드 부재를 정직하게
표시" (honestly record its absence) rather than merely relocating the same
leak. For `chroma.sqlite3`, no such guarantee can be made — this module
does not claim otherwise.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_LEAK_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^/Users/[^/]+(/.*)?$"),
    re.compile(r"^/home/[^/]+(/.*)?$"),
    re.compile(r"^[A-Za-z]:\\Users\\.*$"),
)

_REMOVED_SENTINEL = "(build-host 절대경로 — Package 조립 시 제거됨)"


def looks_like_leaking_absolute_path(value: Any) -> bool:
    if not isinstance(value, str) or not value:
        return False
    return any(pattern.match(value) for pattern in _LEAK_PATTERNS)


def relativize_source_path(value: Any, replacement: str) -> str:
    """Returns `replacement` if `value` looks like a build-host absolute
    path, else `value` unchanged. `replacement` should be the document's
    already-derived `relative_source_path` (see
    `knowledge_packager.source_manifest`) so the rewritten field stays a
    genuinely useful relative pointer rather than a placeholder string."""
    if looks_like_leaking_absolute_path(value):
        return replacement
    return value


@dataclass(frozen=True)
class RelativizeResult:
    parents_rewritten: int
    chroma_rewritten: int

    @property
    def total_rewritten(self) -> int:
        return self.parents_rewritten + self.chroma_rewritten


def rewrite_parents_json(
    parents_path: Path, knowledge_id: str, relative_source_path_by_document_id: dict[str, str]
) -> int:
    """Rewrite `source_path` in-place on a package-owned copy of
    parents.json. Returns the number of entries changed. Works for both ID
    generations: the lookup key is `source_manifest.derive_document_id`
    (not a raw `metadata["document_id"]` read), since legacy entries don't
    carry that field natively."""
    import json

    from knowledge_packager.source_manifest import derive_document_id

    data: dict[str, dict[str, Any]] = json.loads(parents_path.read_text(encoding="utf-8"))
    rewritten = 0
    for entry in data.values():
        metadata = entry.get("metadata", {})
        document_id = derive_document_id(knowledge_id, metadata)
        replacement = relative_source_path_by_document_id.get(document_id)
        if replacement is None:
            continue
        original = metadata.get("source_path")
        if looks_like_leaking_absolute_path(original):
            metadata["source_path"] = replacement
            metadata["source_path_relativized"] = True
            rewritten += 1
    if rewritten:
        parents_path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    return rewritten


def rewrite_chroma_metadata(
    chroma_dir: Path,
    collection_name: str,
    knowledge_id: str,
    relative_source_path_by_document_id: dict[str, str],
) -> int:
    """Fixes the *queryable* metadata on the package's own copy of the
    Chroma collection via `Collection.update()` (metadata-only update —
    never touches embeddings/documents). Must only ever be called on a path
    already copied into the package output directory, never on
    `data/indexes/` itself.

    Unlike `rewrite_parents_json`, this does NOT fully remove the old
    absolute path from `chroma.sqlite3` — see module docstring for why
    (Chroma's `embeddings_queue` write-ahead log retains the original
    `add()` call's metadata). Callers should not treat a non-zero return
    value as "the leak is gone from this file," only as "the leak is gone
    from what `Collection.get()` returns."
    """
    import chromadb

    from knowledge_packager.source_manifest import derive_document_id

    client = chromadb.PersistentClient(path=str(chroma_dir))
    collection = client.get_collection(collection_name)
    existing = collection.get(include=["metadatas"])

    changed_ids: list[str] = []
    changed_metadatas: list[dict[str, Any]] = []
    for record_id, metadata in zip(existing["ids"], existing["metadatas"] or [], strict=True):
        metadata = dict(metadata or {})
        document_id = derive_document_id(knowledge_id, metadata)
        replacement = relative_source_path_by_document_id.get(document_id)
        if replacement is None:
            continue
        original = metadata.get("source_path")
        if looks_like_leaking_absolute_path(original):
            metadata["source_path"] = replacement
            metadata["source_path_relativized"] = True
            changed_ids.append(record_id)
            changed_metadatas.append(metadata)

    if changed_ids:
        collection.update(ids=changed_ids, metadatas=changed_metadatas)
    return len(changed_ids)


def rewrite_bm25_json(
    bm25_json_path: Path, knowledge_id: str, relative_source_path_by_document_id: dict[str, str]
) -> int:
    """Rewrite `source_path` in-place on a package-owned copy of
    `bm25.json`'s `chunk_metadata` entries. Returns the number of entries
    changed. Mirrors `rewrite_parents_json` exactly (same lookup-by-
    `derive_document_id` logic, same "only touch values that actually look
    like a leaking absolute path" guard) — the only reason this was not
    possible before D-054 is that the old `bm25.pkl` format required
    unpickling to edit, which this package refuses to do (see module
    docstring). A no-op (returns 0, does not touch the file) if
    `bm25_json_path` does not exist — e.g. a package built from an index
    not yet migrated off `bm25.pkl`, where this function is simply not
    called."""
    import json

    from knowledge_packager.source_manifest import derive_document_id

    if not bm25_json_path.is_file():
        return 0

    data: dict[str, Any] = json.loads(bm25_json_path.read_text(encoding="utf-8"))
    chunk_metadata = data.get("chunk_metadata", [])
    rewritten = 0
    for metadata in chunk_metadata:
        document_id = derive_document_id(knowledge_id, metadata)
        replacement = relative_source_path_by_document_id.get(document_id)
        if replacement is None:
            continue
        original = metadata.get("source_path")
        if looks_like_leaking_absolute_path(original):
            metadata["source_path"] = replacement
            metadata["source_path_relativized"] = True
            rewritten += 1
    if rewritten:
        bm25_json_path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return rewritten
