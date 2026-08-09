"""Document-id ↔ citation matching rule (D-045, see open-decisions.md).

search-runtime's citation shape (services/search-runtime/src/search_runtime/
hybrid.py) does not carry a `document_id` field — only `document_path` and
`document_title` (04-knowledge-platform.md §3.12 lists document_id as a
required Citation field, but M08's PoC implementation predates that and
returns a path/title instead). To compute document-level Recall@K without
changing the live search-runtime contract, this evaluator derives a document
id by taking the filename stem (no extension) of document_path, falling back
to document_title, and lower-casing it.

Evaluation Dataset authors must write `expected_document_ids` /
`forbidden_document_ids` using that same convention (e.g. "remote-work-policy"
for a source file named `remote-work-policy.md`) — this module also
normalizes the dataset side the same way, so a fixture may write either
"remote-work-policy" or "remote-work-policy.md" and get the same match.
"""

from __future__ import annotations

from pathlib import PurePosixPath

from evaluation_runner.search_client import Citation


def _normalize(raw: str) -> str:
    if not raw:
        return ""
    # PurePosixPath handles both '/' and already-bare names; strips exactly
    # one suffix (".md", ".txt", ...) if present, otherwise returns raw as-is.
    stem = PurePosixPath(raw.strip()).stem
    return stem.strip().lower()


def document_id_from_citation(citation: Citation) -> str:
    """Derive the document id an expected_document_ids entry should match."""
    raw = citation.document_path or citation.document_title or ""
    return _normalize(raw)


def normalize_expected_document_id(doc_id: str) -> str:
    """Normalize one dataset-authored expected/forbidden document id the same way."""
    return _normalize(doc_id)
