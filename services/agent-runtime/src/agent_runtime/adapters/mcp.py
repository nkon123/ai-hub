"""MCP tool-call adapter backed by the Office MCP Server HTTP API (M10).

`HttpMCPAdapter.call_tool` is a thin, honest transport layer: it never
decides *whether* to call a tool (that is Workflow's ANALYZE/TOOL_CONFIRM
job — see `agent_runtime.mcp_tools` and `agent_runtime.workflow`) and it
never constructs SQL or free-form queries — `request["input"]` is passed
through byte-for-byte to `POST /mcp/v1/tools/{tool_name}/call`, which is the
only thing this adapter is allowed to talk to (05-mcp-security-governance.md
§1 "MCP Server는 Agent의 판단을 대신하지 않는다").

Any non-2xx response or a body containing an `error` key is translated into
`MCPCallError` so callers have one place to catch "the MCP call did not
succeed" — a transport failure (timeout/connection refused) and a business
rejection (e.g. `MCP_PERMISSION_DENIED`) both surface the same way, matching
office-mcp-server's own Error Envelope codes (07-data-api-contracts.md §8
"MCP") rather than inventing new ones.
"""

from __future__ import annotations

from typing import Any

import httpx

from agent_runtime.adapters import MCPAdapter


class MCPCallError(Exception):
    """Raised by `HttpMCPAdapter.call_tool` for any non-success outcome —
    transport failure or a structured `{"error": {...}}` response body alike.

    `code` mirrors office-mcp-server's central `ErrorCode` values
    (`MCP_INPUT_INVALID`, `MCP_PERMISSION_DENIED`, `MCP_EXECUTION_TIMEOUT`,
    ...) when the server actually replied; `MCP_SERVER_UNAVAILABLE` covers
    the case where it did not reply at all (connection error/timeout/bad
    body) — that code already exists in the central list for exactly this.
    """

    def __init__(self, code: str, message: str, trace_id: str | None = None) -> None:
        self.code = code
        self.message = message
        self.trace_id = trace_id
        super().__init__(f"{code}: {message}")


class HttpMCPAdapter(MCPAdapter):
    """Calls office-mcp-server's `POST /mcp/v1/tools/{tool_name}/call`.

    `request` must already be a fully-formed `ToolCallRequest`
    (`packages/schemas/api/mcp-audit-context.schema.json`):
    `{tool_name, server_alias, input, audit_context, confirmed}` — built by
    `agent_runtime.workflow`, never by this adapter.
    """

    def __init__(self, office_mcp_url: str, timeout_seconds: float = 15.0) -> None:
        self._office_mcp_url = office_mcp_url.rstrip("/")
        self._timeout_seconds = timeout_seconds

    async def call_tool(self, request: dict[str, Any]) -> dict[str, Any]:
        tool_name = request["tool_name"]
        trace_id = (request.get("audit_context") or {}).get("trace_id")
        headers = {"X-Trace-ID": trace_id} if trace_id else {}

        try:
            async with httpx.AsyncClient(timeout=self._timeout_seconds) as client:
                response = await client.post(
                    f"{self._office_mcp_url}/mcp/v1/tools/{tool_name}/call",
                    json=request,
                    headers=headers,
                )
        except httpx.TimeoutException as exc:
            raise MCPCallError(
                "MCP_EXECUTION_TIMEOUT", "MCP Tool 호출이 시간 초과되었습니다.", trace_id
            ) from exc
        except httpx.HTTPError as exc:
            raise MCPCallError(
                "MCP_SERVER_UNAVAILABLE", "MCP Server에 연결할 수 없습니다.", trace_id
            ) from exc

        try:
            body: dict[str, Any] = response.json()
        except ValueError as exc:
            raise MCPCallError(
                "MCP_SERVER_UNAVAILABLE", "MCP Server 응답을 해석할 수 없습니다.", trace_id
            ) from exc

        if response.status_code >= 400 or "error" in body:
            error = body.get("error", {})
            raise MCPCallError(
                error.get("code", "MCP_SERVER_UNAVAILABLE"),
                error.get("message", "MCP Tool 호출이 실패했습니다."),
                error.get("trace_id", trace_id),
            )
        return body
