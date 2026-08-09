"""PDF Document Loader (04-knowledge-platform.md §2.3 확장 Loader — PDF).

Uses `pypdf` — pure-Python, BSD-3-Clause licensed, no native/binary
dependency. See `indexing-runtime`'s `pyproject.toml` `dependencies` entry
for the closed-network install rationale.

The `import pypdf` is inside the function (lazy), not at module load time,
so that indexing-runtime keeps starting up and indexing Markdown/Text
Knowledge even on a machine where `pypdf` hasn't been installed yet — only
loading an actual `.pdf` source needs it, and only at that moment.
"""

from __future__ import annotations

import io

from indexing_runtime.loaders.errors import MissingLoaderDependencyError


def load_pdf_text(raw: bytes) -> str:
    """Extract plain text from a PDF file's raw bytes.

    Pages are joined with a blank line ("\\n\\n") so the Markdown/Text
    chunking strategies downstream see natural paragraph-like breaks between
    pages instead of text running together. A page pypdf can't extract text
    from (e.g. a scanned image page with no text layer — OCR is out of scope
    for this MVP loader) contributes an empty string rather than failing the
    whole document.
    """
    try:
        import pypdf
    except ImportError as exc:
        raise MissingLoaderDependencyError(
            "PDF 로더에 필요한 pypdf가 설치되어 있지 않습니다. "
            "indexing-runtime 패키지를 다시 설치한 뒤 다시 시도하세요 (uv sync)."
        ) from exc

    reader = pypdf.PdfReader(io.BytesIO(raw))
    pages = [page.extract_text() or "" for page in reader.pages]
    return "\n\n".join(pages)
