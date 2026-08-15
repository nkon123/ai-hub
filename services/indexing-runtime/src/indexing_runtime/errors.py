"""Central error codes and Error Envelope — 07-data-api-contracts.md §8, §10.2.

Mirrors `search_runtime.errors` (M08) structurally, but is NOT imported from
there — CLAUDE.md 구현 원칙 2 ("모듈 간 내부 폴더 직접 Import를 금지한다")
and this codebase's existing precedent of duplicating small
service-internal modules across the M07/M08 boundary rather than sharing
them (see `chroma_client_cache.py`, D-067, for the same reasoning). Only the
codes indexing-runtime actually raises live here — do not invent new codes;
the canonical list is `docs/implementation-spec/07-data-api-contracts.md`
§8.
"""

from __future__ import annotations

from enum import StrEnum


class ErrorCode(StrEnum):
    MODEL_UNAVAILABLE = "MODEL_UNAVAILABLE"
    # POST /indexing/v1/extract-text (P12 AI 추천 .pdf/.docx 경로). Both are
    # from the 07-data-api-contracts.md §8 common list — reused rather than
    # invented, per this module's docstring.
    VALIDATION_ERROR = "VALIDATION_ERROR"
    # A supported format (in LOADED_SUFFIXES) whose optional dependency
    # (pypdf/python-docx, D-073) isn't installed on this deployment — NOT
    # the same fact as VALIDATION_ERROR's "nobody supports this format".
    DEPENDENCY_UNAVAILABLE = "DEPENDENCY_UNAVAILABLE"


_STATUS_BY_CODE: dict[ErrorCode, int] = {
    ErrorCode.MODEL_UNAVAILABLE: 503,
    ErrorCode.VALIDATION_ERROR: 400,
    ErrorCode.DEPENDENCY_UNAVAILABLE: 503,
}


def status_for(code: ErrorCode) -> int:
    return _STATUS_BY_CODE.get(code, 500)


def error_envelope(
    code: ErrorCode,
    message: str,
    trace_id: str,
    *,
    details: dict | None = None,
) -> dict:
    """07-data-api-contracts.md §10.2 Error Envelope. Message must never
    contain a stack trace or internal path (CLAUDE.md)."""
    payload: dict = {"error": {"code": code.value, "message": message, "trace_id": trace_id}}
    if details:
        payload["error"]["details"] = details
    return payload
