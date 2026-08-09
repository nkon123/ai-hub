"""Tool Call Pipeline — wires together every layer in
05-mcp-security-governance.md §2:

    Request Context -> Tool Registry (existence + Kill Switch)
    -> Authorization Policy -> Input Validation -> User Confirmation
    -> Execution Guard (rate limit + timeout) -> Tool Handler -> Connector
    -> Output Filter -> Audit

Implementation note on ordering: §2's diagram lists "Authorization Policy"
before "Tool Registry", but a permission decision needs the tool's
`allowed_roles`/`allowed_orgs` metadata *from* the registry, so this
pipeline resolves the tool first and authorizes against it — the diagram
reads as architectural layering, not a strict must-not-reorder sequence.
"""

from __future__ import annotations

import logging
import time

from observability import bind_run_id, bind_trace_id

from office_mcp_server.audit import (
    AuditResult,
    AuditSink,
    build_event,
    now_iso,
)
from office_mcp_server.connector import Connector
from office_mcp_server.errors import ErrorCode, McpError
from office_mcp_server.execution import RateLimiter, result_limit_info, run_with_timeout
from office_mcp_server.output_filter import apply_output_filter
from office_mcp_server.permissions import check_permission
from office_mcp_server.request_context import RequestContext, parse_request_context
from office_mcp_server.tool_registry import ToolRegistry, UserConfirmationPolicy
from office_mcp_server.tools import db_metadata, table_count

_logger = logging.getLogger("office_mcp_server.pipeline")

_HANDLERS = {
    "db_metadata.get_tables": db_metadata.get_tables,
    "db_metadata.get_columns": db_metadata.get_columns,
    "table_count.query": table_count.query,
}

# Structural + allowlist validation only (no Connector call) — run *before*
# the §8.4 confirmation gate so a disallowed table/field fails as
# MCP_INPUT_INVALID rather than being masked behind "please confirm".
_INPUT_VALIDATORS = {
    "db_metadata.get_tables": db_metadata.validate_tables_input,
    "db_metadata.get_columns": db_metadata.validate_columns_input,
    "table_count.query": table_count.validate_input,
}

_CONFIRMATION_CHECKS = {
    "table_count.query": table_count.requires_confirmation,
}

SERVER_ALIAS = "oracle-connector"


def _audit_result_for(error: McpError) -> AuditResult:
    if error.code == ErrorCode.MCP_PERMISSION_DENIED:
        return AuditResult.DENIED
    if error.code == ErrorCode.MCP_EXECUTION_TIMEOUT:
        return AuditResult.TIMEOUT
    return AuditResult.FAILED


class ToolCallPipeline:
    def __init__(
        self,
        registry: ToolRegistry,
        connector: Connector,
        audit_sink: AuditSink,
        rate_limiter: RateLimiter | None = None,
    ) -> None:
        self.registry = registry
        self.connector = connector
        self.audit_sink = audit_sink
        self.rate_limiter = rate_limiter or RateLimiter()

    async def call(self, tool_name: str, body: dict) -> dict:
        if not isinstance(body, dict):
            raise McpError(ErrorCode.VALIDATION_ERROR, "요청 본문 형식이 올바르지 않습니다.")

        raw_context = body.get("audit_context")
        try:
            context = parse_request_context(raw_context, expected_tool=tool_name)
        except McpError:
            _logger.warning("MCP call rejected: invalid or missing request context")
            raise

        # Bind the caller-declared trace_id/run_id (Request Context §3, never
        # trusted from anywhere but this dedicated field — see
        # request_context.py) so every log line for the rest of this call,
        # including the audit event LoggingAuditSink emits below, carries the
        # same id agent-runtime logged for this run.
        bind_trace_id(context.trace_id)
        bind_run_id(context.run_id)

        started_monotonic = time.monotonic()
        started_at_iso = now_iso()
        _logger.info(
            "mcp.tool_call.started tool=%s server_alias=%s",
            tool_name,
            body.get("server_alias"),
        )

        try:
            return await self._call_inner(tool_name, body, context, started_monotonic)
        except McpError as error:
            duration_ms = int((time.monotonic() - started_monotonic) * 1000)
            tool = self.registry.get(tool_name)
            self.audit_sink.record(
                build_event(
                    event_type="MCP_TOOL_COMPLETED",
                    trace_id=context.trace_id,
                    run_id=context.run_id,
                    user_id=context.user.id,
                    organization_id=context.user.organization_id,
                    service_id=context.service_id,
                    agent_id=context.agent_id,
                    tool_name=tool_name,
                    tool_version=tool.version if tool else None,
                    started_at=started_at_iso,
                    duration_ms=duration_ms,
                    result=_audit_result_for(error),
                )
            )
            raise

    async def _call_inner(
        self,
        tool_name: str,
        body: dict,
        context: RequestContext,
        started_monotonic: float,
    ) -> dict:
        server_alias = body.get("server_alias")
        if server_alias != SERVER_ALIAS:
            raise McpError(ErrorCode.MCP_TOOL_NOT_FOUND, "요청한 MCP Server를 찾을 수 없습니다.")

        body_tool_name = body.get("tool_name")
        if body_tool_name is not None and body_tool_name != tool_name:
            raise McpError(
                ErrorCode.VALIDATION_ERROR, "요청 본문의 tool_name이 대상 Tool과 일치하지 않습니다."
            )

        tool = self.registry.get(tool_name)
        if tool is None:
            raise McpError(ErrorCode.MCP_TOOL_NOT_FOUND, "존재하지 않는 Tool입니다.")
        if not self.registry.is_active(tool_name):
            raise McpError(ErrorCode.MCP_TOOL_DISABLED, "현재 비활성화된 Tool입니다.")

        check_permission(tool, context)

        raw_input = body.get("input")
        if not isinstance(raw_input, dict):
            raise McpError(
                ErrorCode.MCP_INPUT_INVALID, "Tool 입력 값이 없거나 형식이 올바르지 않습니다."
            )

        # Input Validator (§2) — runs before Execution Guard/confirmation so
        # a structurally invalid or non-allowlisted request never reaches
        # the confirmation gate or the Connector.
        _INPUT_VALIDATORS[tool_name](raw_input)

        confirmed = bool(body.get("confirmed", False))
        if tool.user_confirmation_policy == UserConfirmationPolicy.ALWAYS and not confirmed:
            raise McpError(
                ErrorCode.VALIDATION_ERROR,
                "이 Tool은 매 호출마다 사용자 확인이 필요합니다.",
                details={"requires_confirmation": True},
            )
        if tool.user_confirmation_policy == UserConfirmationPolicy.ON_PARAMETER and not confirmed:
            check_fn = _CONFIRMATION_CHECKS.get(tool_name)
            if check_fn is not None and check_fn(raw_input):
                raise McpError(
                    ErrorCode.VALIDATION_ERROR,
                    "이 요청 조건에서는 사용자 확인이 필요합니다.",
                    details={"requires_confirmation": True},
                )

        self.rate_limiter.check_tool_call(
            user_id=context.user.id,
            agent_or_service_id=context.agent_id,
            tool_name=tool_name,
            tool_limit=tool.rate_limit_per_minute,
        )

        handler = _HANDLERS[tool_name]
        raw_output = await run_with_timeout(
            handler(self.connector, raw_input, context), tool.timeout_seconds
        )

        is_get_columns = tool_name == "db_metadata.get_columns"
        table_for_filter = raw_input.get("table") if is_get_columns else None
        final_output, truncated = apply_output_filter(tool, raw_output, table=table_for_filter)

        duration_ms = int((time.monotonic() - started_monotonic) * 1000)
        row_count = _extract_row_count(final_output)

        self.audit_sink.record(
            build_event(
                event_type="MCP_TOOL_COMPLETED",
                trace_id=context.trace_id,
                run_id=context.run_id,
                user_id=context.user.id,
                organization_id=context.user.organization_id,
                service_id=context.service_id,
                agent_id=context.agent_id,
                tool_name=tool_name,
                tool_version=tool.version,
                started_at=now_iso(),
                duration_ms=duration_ms,
                result=AuditResult.SUCCEEDED,
                row_count=row_count,
                truncated=truncated,
            )
        )

        response = {
            "success": True,
            "tool_name": tool_name,
            "tool_version": tool.version,
            "output": final_output,
            "duration_ms": duration_ms,
            "trace_id": context.trace_id,
            "rows_returned": row_count,
            "truncated": truncated,
        }
        if truncated:
            response["limit_info"] = result_limit_info(tool)
        return response


def _extract_row_count(output: dict) -> int | None:
    for value in output.values():
        if isinstance(value, list):
            return len(value)
    return None
