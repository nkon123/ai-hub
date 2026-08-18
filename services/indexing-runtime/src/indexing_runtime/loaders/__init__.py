"""Document loaders (04-knowledge-platform.md §2.3).

The Loader's only responsibility is reading a source file and normalizing it
into the spec's common output shape — `{document_id, content, metadata}`.
Splitting into sections/chunks is the Chunking Strategy's job
(`indexing_runtime.chunkers`), not the Loader's — heading-based splitting
used to live here (`_split_by_heading`, H1/H2 only) which is exactly the
defect this revision fixes: it silently ignored H3 and left the Markdown
strategy's actual splitting logic unreachable/unimplemented. See
docs/implementation-spec/open-decisions.md D-053.

MVP Loaders (Markdown, Plain Text) decode `raw` as UTF-8 text directly and
are unchanged by the addition of the two 확장 Loaders below (PDF, Word) —
those instead extract text through `pdf_loader`/`docx_loader`, which raise
`MissingLoaderDependencyError` (a clear Korean message) instead of crashing
with a bare `ModuleNotFoundError` if `pypdf`/`python-docx` aren't installed.
See open-decisions.md D-073 for why those two dependencies are declared in
`pyproject.toml`. Note (measured 2026-08-15): they ARE in fact installed in
this development environment (pypdf 6.15.0, python-docx 1.2.0) — the earlier
claim here that they were never installed on this machine was stale, and it
misled a task brief that was written from it. The degrade path is therefore
not reachable by simply running here; it is covered by a monkeypatched test
instead of a "it will fail on this machine anyway" assumption.
"""

from __future__ import annotations

import hashlib
import mimetypes
from datetime import UTC, datetime
from pathlib import Path

from indexing_runtime.loaders.docx_loader import load_docx_text
from indexing_runtime.loaders.errors import MissingLoaderDependencyError
from indexing_runtime.loaders.pdf_loader import load_pdf_text

__all__ = [
    "LOADED_SUFFIXES",
    "MissingLoaderDependencyError",
    "load_document",
    "load_text_from_bytes",
]

# MVP Loaders (§2.3): Markdown, Plain Text. 확장 Loader (§2.3): PDF, Word.
_TEXT_SUFFIXES = frozenset({".md", ".markdown", ".txt"})
_PDF_SUFFIXES = frozenset({".pdf"})
_DOCX_SUFFIXES = frozenset({".docx"})
LOADED_SUFFIXES = _TEXT_SUFFIXES | _PDF_SUFFIXES | _DOCX_SUFFIXES


def _source_hash(raw: bytes) -> str:
    """source_hash: 원본 Bytes SHA-256 (§2.6)."""
    return hashlib.sha256(raw).hexdigest()


def _mime_type(path: Path) -> str:
    guessed, _ = mimetypes.guess_type(path.name)
    if guessed:
        return guessed
    return "text/markdown" if path.suffix.lower() in (".md", ".markdown") else "text/plain"


def load_document(path: Path, document_id: str, language: str = "ko") -> dict:
    """Load one source file into the common Loader output shape.

    Markdown/Plain Text (MVP, §2.3), PDF and Word (확장, §2.3). `document_id`
    is computed by the caller (indexing_runtime.chunkers.ids.make_document_id)
    since it needs the Knowledge namespace and the file's path relative to
    the source root, neither of which the loader itself knows.
    """
    suffix = path.suffix.lower()
    if suffix not in LOADED_SUFFIXES:
        raise ValueError(f"Unsupported file type: {path.suffix}")

    raw = path.read_bytes()

    if suffix in _TEXT_SUFFIXES:
        # Parser/Normalizer §2.4: 줄바꿈 통일 (CRLF/CR -> LF). Encoding errors
        # are allowed to raise — the pipeline records per-document load
        # failures at the call site rather than silently substituting
        # characters. Unchanged from before PDF/Word support existed.
        content = raw.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
    elif suffix in _PDF_SUFFIXES:
        content = load_pdf_text(raw).replace("\r\n", "\n").replace("\r", "\n")
    else:
        content = load_docx_text(raw).replace("\r\n", "\n").replace("\r", "\n")

    modified_at = datetime.fromtimestamp(path.stat().st_mtime, tz=UTC).isoformat()

    return {
        "document_id": document_id,
        "content": content,
        "metadata": {
            "source_path": str(path),
            "file_name": path.name,
            "source_hash": _source_hash(raw),
            "mime_type": _mime_type(path),
            "language": language,
            "modified_at": modified_at,
            "title": path.stem,
        },
    }


def load_text_from_bytes(raw: bytes, filename: str) -> str:
    """Extract plain text from in-memory bytes, dispatching on `filename`'s
    suffix exactly like `load_document`'s suffix handling — but never
    touching disk and never building a filesystem path from the
    caller-supplied `filename` (root CLAUDE.md 코드 규칙: "사용자가 제공한
    파일명으로 파일 경로를 만들지 않는다"). `filename` is read only for its
    suffix, via `Path(filename).suffix` — a pure string operation, no path is
    ever opened/joined with it.

    Used by `POST /indexing/v1/extract-text` (main.py) — the AI 추천 button's
    .pdf/.docx path (P12 Knowledge 등록, portal-web -> portal-api relay ->
    here). This is deliberately separate from the indexing pipeline itself
    (`pipeline.py` still calls `load_document` against a file already saved
    to `storage_root`): the AI 추천 flow runs *before* the document is
    uploaded/persisted, so there is no path to read from yet.

    Raises `ValueError` for a suffix outside `LOADED_SUFFIXES` (format
    nobody supports) and `MissingLoaderDependencyError` for a
    supported-but-unavailable PDF/Word dependency (D-073) — the caller must
    keep these two distinguishable; collapsing them tells an operator the
    wrong thing about whether the failure is fixable on this deployment.
    """
    suffix = Path(filename).suffix.lower()
    if suffix not in LOADED_SUFFIXES:
        raise ValueError(f"Unsupported file type: {suffix}")

    if suffix in _TEXT_SUFFIXES:
        content = raw.decode("utf-8")
    elif suffix in _PDF_SUFFIXES:
        content = load_pdf_text(raw)
    else:
        content = load_docx_text(raw)

    return content.replace("\r\n", "\n").replace("\r", "\n")
