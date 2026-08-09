"""Source Manifest assembly (04-knowledge-platform.md §4.2).

Builds one `SourceDocumentEntry` per unique source document by grouping
`parents.json` entries (both ID generations — see module docstring of
`knowledge_packager.index_reader`). Every field this module cannot honestly
populate from data actually present in the index directory (or from an
optional caller-supplied Asset Manifest) is set to the `NOT_RECORDED`
("미기재") sentinel — never guessed. This mirrors
`evaluation_runner.data_card`'s discipline exactly (CLAUDE.md: "Never
fabricate metadata").
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from knowledge_packager.models import NOT_RECORDED, SourceDocumentEntry


def _basename(path_like: str) -> str:
    if not path_like:
        return ""
    return path_like.replace("\\", "/").rsplit("/", 1)[-1]


def derive_document_id(knowledge_id: str, metadata: dict[str, Any]) -> str:
    """The document id a parent/child chunk belongs to.

    New-generation index dirs carry this natively in `metadata.document_id`
    (`<knowledge_id>:<relative_path>`, see
    `indexing_runtime.chunkers.ids.make_document_id`). Legacy index dirs
    predate that field, so this derives an equivalent id from whatever
    filename-shaped hint is available (`title`, then `source_path`'s
    basename) — reimplementing the same `f"{knowledge_id}:{relative_path}"`
    *convention* locally rather than importing indexing_runtime (CLAUDE.md
    구현 원칙 2: 모듈 간 내부 폴더 직접 Import 금지). This is a formatting
    convention, not business logic, so duplicating it here carries no
    meaningful drift risk.
    """
    native = metadata.get("document_id")
    if isinstance(native, str) and native:
        return native
    hint = metadata.get("title") or _basename(str(metadata.get("source_path", ""))) or "unknown"
    return f"{knowledge_id}:{_basename(str(hint))}"


def derive_relative_source_path(
    document_id: str, knowledge_id: str, metadata: dict[str, Any]
) -> str:
    """The document-relative path a Source Manifest entry should record.

    For the new ID generation this is exact (recovered from `document_id`
    itself). For legacy entries, only a filename-shaped hint is available —
    the true relative directory structure beyond the basename is not
    recoverable from legacy metadata, so this returns just the basename
    rather than fabricating intermediate path segments.
    """
    prefix = f"{knowledge_id}:"
    if document_id.startswith(prefix) and len(document_id) > len(prefix):
        return document_id[len(prefix) :]
    hint = metadata.get("title") or _basename(str(metadata.get("source_path", "")))
    return _basename(str(hint)) if hint else NOT_RECORDED


def _try_hash_source_file(source_path: Any) -> str:
    """Best-effort sha256 of the *original* source file, read from the
    build host's filesystem at the absolute path indexing-runtime recorded
    (this reads the ORIGINAL under e.g. apps/portal-api/storage/, never
    anything under data/indexes/, and never writes to it). If the path is
    missing, not absolute, or unreadable — e.g. the package is being built
    on a different host than the one that indexed the document, or the
    source was since deleted — this honestly returns NOT_RECORDED rather
    than fabricating a hash."""
    if not isinstance(source_path, str) or not source_path:
        return NOT_RECORDED
    try:
        path = Path(source_path)
        if not path.is_absolute() or not path.is_file():
            return NOT_RECORDED
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return NOT_RECORDED


def build_source_manifest(
    knowledge_id: str,
    parents: dict[str, dict[str, Any]],
    owner: dict[str, Any] | str | None = None,
    classification: str | None = None,
) -> list[SourceDocumentEntry]:
    """One entry per unique document, derived from `parents.json`. Ordered
    by document id for a deterministic, diffable Source Manifest."""
    by_document: dict[str, dict[str, Any]] = {}
    for parent_id in sorted(parents.keys()):
        entry = parents[parent_id]
        metadata = entry.get("metadata", {})
        document_id = derive_document_id(knowledge_id, metadata)
        by_document.setdefault(document_id, metadata)

    documents: list[SourceDocumentEntry] = []
    for document_id in sorted(by_document.keys()):
        metadata = by_document[document_id]
        relative_source_path = derive_relative_source_path(document_id, knowledge_id, metadata)
        display_name = str(metadata.get("title") or relative_source_path or document_id)
        documents.append(
            SourceDocumentEntry(
                document_id=document_id,
                display_name=display_name,
                relative_source_path=relative_source_path,
                source_hash=_try_hash_source_file(metadata.get("source_path")),
                source_version=NOT_RECORDED,
                owner=owner if owner is not None else NOT_RECORDED,
                classification=classification if classification is not None else NOT_RECORDED,
                license_or_usage_basis=NOT_RECORDED,
                effective_date=NOT_RECORDED,
                status=NOT_RECORDED,
                parser_identity=NOT_RECORDED,
            )
        )
    return documents


def relative_source_path_by_document_id(
    knowledge_id: str, parents: dict[str, dict[str, Any]]
) -> dict[str, str]:
    """Convenience index used by `knowledge_packager.relativize` to map a
    derived document id to the relative path it should rewrite absolute
    `source_path` leaks to."""
    result: dict[str, str] = {}
    for entry in parents.values():
        metadata = entry.get("metadata", {})
        document_id = derive_document_id(knowledge_id, metadata)
        result.setdefault(
            document_id, derive_relative_source_path(document_id, knowledge_id, metadata)
        )
    return result
