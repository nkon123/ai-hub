"""`POST /api/v1/assets` upload-hardening error codes vs their documentation.

2026-08-19's upload hardening (`routers/assets.py::create_asset`) introduced
four distinct error codes — `ASSET_UPLOAD_TOO_MANY_FILES`,
`ASSET_UPLOAD_EXTENSION_REJECTED`, `ASSET_UPLOAD_FILE_TOO_LARGE`,
`ASSET_UPLOAD_REQUEST_TOO_LARGE` — but landed with no entry in
`packages/schemas/api/portal-openapi.yaml` or in
`docs/implementation-spec/07-data-api-contracts.md` §8 (오류코드 분류), the
repo's one place error codes are classified. A caller of this contract
(Desktop, M04) had no way to know these codes could come back at all.

This repo has neither a central Python `ErrorCode` enum nor any other
machine-readable registry for error codes — every code is a bare string
literal at its `error_response(...)` call site, checked against prose lists
in the two documents above (confirmed by grep before writing this test: no
`ErrorCode`/`ERROR_CODES` construct exists anywhere in the repo). So instead
of retyping the four strings a second time as this test's "expected" set —
which is exactly the hand-copy drift this repo has been burned by before
(`MCP_TOOL_SPECS`, see `test_mcp_tool_spec_drift.py`) — this test derives the
ground truth by scanning `routers/assets.py`'s actual source for
`ASSET_UPLOAD_*` string literals, and asserts the two documents mention
exactly that set. Change a code string in `assets.py` (rename, add, remove)
and this test's "source" side moves with it automatically; only the
documentation side needs a human to catch up, which is exactly the failure
this guard exists to catch.
"""

from __future__ import annotations

import inspect
import re
from pathlib import Path

import yaml
from portal_api.routers import assets as assets_router

from .conftest import API_DIR

_REPO_ROOT = Path(__file__).parent.parent.parent
_CONTRACTS_DOC = _REPO_ROOT / "docs" / "implementation-spec" / "07-data-api-contracts.md"

_UPLOAD_CODE_RE = re.compile(r"ASSET_UPLOAD_[A-Z_]+")


def _codes_in_source() -> set[str]:
    """Ground truth: every `ASSET_UPLOAD_*` string literal actually present
    in `routers/assets.py`'s source, derived by scanning the module's own
    source text rather than retyped by hand."""
    source = inspect.getsource(assets_router)
    literal_re = re.compile(r'"(ASSET_UPLOAD_[A-Z_]+)"')
    return set(literal_re.findall(source))


def _codes_in_openapi() -> set[str]:
    with (API_DIR / "portal-openapi.yaml").open(encoding="utf-8") as f:
        spec = yaml.safe_load(f)
    description = (
        spec["paths"]["/api/v1/assets"]["post"]["responses"]["400"]["description"]
    )
    return set(_UPLOAD_CODE_RE.findall(description))


def _codes_in_contracts_doc() -> set[str]:
    text = _CONTRACTS_DOC.read_text(encoding="utf-8")
    return set(_UPLOAD_CODE_RE.findall(text))


def test_source_actually_defines_upload_codes() -> None:
    """Guard on the guard: if this were empty, every check below would
    vacuously pass."""
    assert _codes_in_source(), (
        "Expected routers/assets.py to contain ASSET_UPLOAD_* string "
        "literals — the scan regex or the module path may have changed."
    )


def test_openapi_documents_every_upload_error_code() -> None:
    source_codes = _codes_in_source()
    openapi_codes = _codes_in_openapi()
    assert openapi_codes == source_codes, (
        "packages/schemas/api/portal-openapi.yaml's POST /api/v1/assets "
        "400 response description lists a different set of ASSET_UPLOAD_* "
        f"codes than routers/assets.py actually emits.\n"
        f"  in source only:  {sorted(source_codes - openapi_codes)}\n"
        f"  in openapi only: {sorted(openapi_codes - source_codes)}"
    )


def test_contracts_doc_documents_every_upload_error_code() -> None:
    source_codes = _codes_in_source()
    doc_codes = _codes_in_contracts_doc()
    assert doc_codes == source_codes, (
        "docs/implementation-spec/07-data-api-contracts.md §8 (오류코드 "
        "분류) lists a different set of ASSET_UPLOAD_* codes than "
        "routers/assets.py actually emits.\n"
        f"  in source only: {sorted(source_codes - doc_codes)}\n"
        f"  in doc only:    {sorted(doc_codes - source_codes)}"
    )
