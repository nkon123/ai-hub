"""Word(.docx) Document Loader (04-knowledge-platform.md §2.3 확장 Loader —
Word).

Uses `python-docx` — pure-Python, MIT licensed (its only runtime dependency,
`lxml`, ships prebuilt wheels for win_amd64, so it needs no C build toolchain
on the target Windows PC either). See `indexing-runtime`'s `pyproject.toml`
`dependencies` entry for the closed-network install rationale.

The `import docx` is inside the function (lazy) for the same reason as
`pdf_loader.load_pdf_text`: a machine without `python-docx` installed can
still start indexing-runtime and index Markdown/Text/PDF Knowledge — only
loading an actual `.docx` source needs it.

Legacy binary `.doc` (pre-2007 Word) is explicitly out of scope — python-docx
only reads the OOXML `.docx` format, and this loader does not attempt to
sniff or convert `.doc` files.
"""

from __future__ import annotations

import io

from indexing_runtime.loaders.errors import MissingLoaderDependencyError


def load_docx_text(raw: bytes) -> str:
    """Extract plain text from a .docx file's raw bytes.

    Paragraphs are joined with a single newline, matching how a plain-text
    export of the same document would read. Tables, headers/footers, and
    embedded images are not extracted in this MVP loader (04-knowledge
    -platform.md §2.3 lists Word only as an 확장 Loader, not a fully-scoped
    one) — a document that is *only* tables would load as an empty/near
    -empty string rather than raising an error.
    """
    try:
        import docx
    except ImportError as exc:
        raise MissingLoaderDependencyError(
            "DOCX 로더에 필요한 python-docx가 설치되어 있지 않습니다. "
            "indexing-runtime 패키지를 다시 설치한 뒤 다시 시도하세요 (uv sync)."
        ) from exc

    document = docx.Document(io.BytesIO(raw))
    paragraphs = [p.text for p in document.paragraphs]
    return "\n".join(paragraphs)
