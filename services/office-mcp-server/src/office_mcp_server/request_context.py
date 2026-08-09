"""Request Context — 05-mcp-security-governance.md §3.

Python counterpart of the extended `AuditContext` in
`packages/schemas/api/mcp-audit-context.schema.json` (see
docs/implementation-spec/open-decisions.md D-049 for why the two schemas were
reconciled into one shape instead of kept as parallel types).

Security boundary this module exists to enforce: "Context는 신뢰할 수 있는
Runtime/Authentication 계층에서 생성한다... Agent Prompt가 사용자 ID나 Role을
임의로 만들 수 없다." In this PoC that boundary is structural, not
cryptographic (D-015: Mock User Context) — `RequestContext` is parsed only
from the call envelope's dedicated `audit_context` field, never from the
tool's free-form `input` dict. A tool's `input_schema` never declares a
`user`/`role`/`org` property (see tools/*.py), so even if a Prompt Injection
attempts to smuggle `{"role": "ADMIN"}` inside `input`, it is just an
unrecognized business parameter there — it can never reach `context.user`.
"""

from __future__ import annotations

from pydantic import BaseModel, Field, ValidationError

from office_mcp_server.errors import ErrorCode, McpError


class RequestContextUser(BaseModel):
    model_config = {"extra": "forbid"}

    id: str
    organization_id: str
    site_id: str
    roles: list[str] = Field(min_length=1)


class RequestContext(BaseModel):
    """§3 필수 Context — every field is required; a missing/malformed field
    means "reject the request" (§3), not "default it"."""

    model_config = {"extra": "forbid"}

    request_id: str
    trace_id: str
    run_id: str
    service_id: str
    service_version: str
    agent_id: str
    agent_version: str
    user: RequestContextUser
    requested_tool: str


def parse_request_context(raw: object, *, expected_tool: str) -> RequestContext:
    """Validate the caller-supplied `audit_context` payload.

    Raises McpError(VALIDATION_ERROR) on any structural problem, and also
    when `requested_tool` in the context does not match the tool actually
    being invoked (a caller must not mint one context and use it to call a
    different tool than it declares)."""
    if not isinstance(raw, dict):
        raise McpError(
            ErrorCode.VALIDATION_ERROR,
            "요청 Context가 없거나 형식이 올바르지 않습니다.",
        )
    try:
        context = RequestContext.model_validate(raw)
    except ValidationError as exc:
        raise McpError(
            ErrorCode.VALIDATION_ERROR,
            "요청 Context 필수 필드가 누락되었거나 형식이 올바르지 않습니다.",
            details={"fields": sorted({str(e["loc"][0]) for e in exc.errors() if e["loc"]})},
        ) from exc

    if context.requested_tool != expected_tool:
        raise McpError(
            ErrorCode.VALIDATION_ERROR,
            "요청 Context의 대상 Tool과 호출 대상 Tool이 일치하지 않습니다.",
        )
    return context
