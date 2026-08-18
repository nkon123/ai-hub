"""Central error codes and Error Envelope — 07-data-api-contracts.md §8, §10.2.

CLAUDE.md 구현 원칙: "Enum과 오류코드는 중앙 정의를 사용한다." The canonical
list lives in `docs/implementation-spec/07-data-api-contracts.md` §8; this
module mirrors only the codes search-runtime actually raises (a subset of
"공통" plus "Knowledge"). Do not invent new codes here — see
open-decisions.md D-062 for why §3.8's forced-ACL-override rejection reuses
`KNOWLEDGE_ACCESS_DENIED` ("Knowledge 또는 문서 접근 권한 없음") rather than
adding a new one: attempting to assert your own `classification` filter value
*is* an attempt at unauthorized access, which the existing code already
names precisely.
"""

from __future__ import annotations

from enum import StrEnum


class ErrorCode(StrEnum):
    VALIDATION_ERROR = "VALIDATION_ERROR"
    # D-079: the deployment itself refuses the operation, regardless of how
    # well-formed the request is — local Knowledge index registration is
    # switched off (no `SEARCH_LOCAL_INDEX_ROOTS`), or the named directory
    # lies outside the roots this deployment allows. The central "공통" code
    # (07-data-api-contracts.md §8), not `KNOWLEDGE_ACCESS_DENIED`: nothing
    # about the *user's* clearance is being evaluated here, so reusing the
    # ACL code would misreport a deployment-policy refusal as a data-access
    # one.
    PERMISSION_DENIED = "PERMISSION_DENIED"
    KNOWLEDGE_ACCESS_DENIED = "KNOWLEDGE_ACCESS_DENIED"
    # D-054: the target index's bm25.pkl is a not-yet-migrated legacy pickle
    # and this deployment refuses to unpickle it
    # (settings.ALLOW_LEGACY_PICKLE_BM25=False) — reusing this existing
    # central code (07-data-api-contracts.md §8 "Knowledge") rather than
    # inventing a new one (CLAUDE.md 구현 원칙: "오류코드는 중앙 정의를
    # 사용한다"): from the caller's perspective, an index artifact this
    # service will not load is indistinguishable from one it cannot parse.
    KNOWLEDGE_INDEX_CORRUPT = "KNOWLEDGE_INDEX_CORRUPT"


_STATUS_BY_CODE: dict[ErrorCode, int] = {
    ErrorCode.VALIDATION_ERROR: 400,
    ErrorCode.PERMISSION_DENIED: 403,
    ErrorCode.KNOWLEDGE_ACCESS_DENIED: 403,
    ErrorCode.KNOWLEDGE_INDEX_CORRUPT: 500,
}


def status_for(code: ErrorCode) -> int:
    return _STATUS_BY_CODE.get(code, 400)


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
