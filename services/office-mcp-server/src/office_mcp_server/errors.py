"""Central error codes and Error Envelope — 07-data-api-contracts.md §8, §10.2.

CLAUDE.md 구현 원칙: "Enum과 오류코드는 중앙 정의를 사용한다." The canonical
list lives in `docs/implementation-spec/07-data-api-contracts.md` §8; this
module mirrors only the codes office-mcp-server actually raises (a subset of
"공통" plus all of "MCP"). Do not invent new codes here.
"""

from __future__ import annotations

from enum import StrEnum

from fastapi.responses import JSONResponse


class ErrorCode(StrEnum):
    # 공통 (07-data-api-contracts.md §8 "공통")
    VALIDATION_ERROR = "VALIDATION_ERROR"
    AUTHENTICATION_REQUIRED = "AUTHENTICATION_REQUIRED"
    PERMISSION_DENIED = "PERMISSION_DENIED"
    RESOURCE_NOT_FOUND = "RESOURCE_NOT_FOUND"
    RATE_LIMITED = "RATE_LIMITED"
    INTERNAL_ERROR = "INTERNAL_ERROR"

    # MCP (07-data-api-contracts.md §8 "MCP")
    MCP_SERVER_UNAVAILABLE = "MCP_SERVER_UNAVAILABLE"
    MCP_TOOL_NOT_FOUND = "MCP_TOOL_NOT_FOUND"
    MCP_TOOL_DISABLED = "MCP_TOOL_DISABLED"
    MCP_INPUT_INVALID = "MCP_INPUT_INVALID"
    MCP_PERMISSION_DENIED = "MCP_PERMISSION_DENIED"
    MCP_EXECUTION_TIMEOUT = "MCP_EXECUTION_TIMEOUT"
    MCP_RESULT_LIMIT_EXCEEDED = "MCP_RESULT_LIMIT_EXCEEDED"


_STATUS_BY_CODE: dict[ErrorCode, int] = {
    ErrorCode.VALIDATION_ERROR: 400,
    ErrorCode.AUTHENTICATION_REQUIRED: 401,
    ErrorCode.PERMISSION_DENIED: 403,
    ErrorCode.RESOURCE_NOT_FOUND: 404,
    ErrorCode.RATE_LIMITED: 429,
    ErrorCode.INTERNAL_ERROR: 500,
    ErrorCode.MCP_SERVER_UNAVAILABLE: 503,
    ErrorCode.MCP_TOOL_NOT_FOUND: 404,
    ErrorCode.MCP_TOOL_DISABLED: 409,
    ErrorCode.MCP_INPUT_INVALID: 400,
    ErrorCode.MCP_PERMISSION_DENIED: 403,
    ErrorCode.MCP_EXECUTION_TIMEOUT: 504,
    ErrorCode.MCP_RESULT_LIMIT_EXCEEDED: 200,  # not an error transport-wise — truncated result
}


class McpError(Exception):
    """Raised anywhere in the pipeline; carries everything `error_response`
    needs. Never let a raw exception (with stack trace / internal message)
    reach the HTTP boundary — §9 "내부 오류·Stack Trace 제거"."""

    def __init__(
        self,
        code: ErrorCode,
        message: str,
        *,
        details: dict | None = None,
        status_code: int | None = None,
    ) -> None:
        self.code = code
        self.message = message
        self.details = details or {}
        self.status_code = status_code or _STATUS_BY_CODE.get(code, 400)
        super().__init__(f"{code.value}: {message}")


def error_response(
    status_code: int,
    code: ErrorCode | str,
    message: str,
    trace_id: str,
    details: dict | None = None,
) -> JSONResponse:
    """07-data-api-contracts.md §10.2 Error Envelope. Message must never
    contain password/SQL/stack trace/internal path text (CLAUDE.md)."""
    code_value = code.value if isinstance(code, ErrorCode) else code
    payload: dict = {"error": {"code": code_value, "message": message, "trace_id": trace_id}}
    if details:
        payload["error"]["details"] = details
    return JSONResponse(status_code=status_code, content=payload)


def mcp_error_response(error: McpError, trace_id: str) -> JSONResponse:
    return error_response(error.status_code, error.code, error.message, trace_id, error.details)
