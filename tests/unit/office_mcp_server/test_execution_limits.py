"""Execution Control — 05-mcp-security-governance.md §8.

Rate limit, timeout, and result limits (row/byte/field-length truncation +
`truncated`/`limit_info`)."""

from __future__ import annotations

import asyncio

import pytest
from office_mcp_server.audit import InMemoryAuditSink
from office_mcp_server.connector import Connector, ConnectorStatus, MockOracleConnector, QueryId
from office_mcp_server.errors import ErrorCode, McpError
from office_mcp_server.execution import RateLimiter, apply_result_limits
from office_mcp_server.pipeline import ToolCallPipeline
from office_mcp_server.request_context import RequestContext
from office_mcp_server.tool_registry import RegisteredTool, ToolRegistry
from office_mcp_server.tools_setup import register_poc_tools

from .conftest import make_call_body, make_context

# ---------------------------------------------------------------------------
# Result limits (row / byte / field length)
# ---------------------------------------------------------------------------


def _tool(**overrides) -> RegisteredTool:
    defaults = dict(
        name="t",
        version="1.0.0",
        server_alias="oracle-connector",
        description="d",
        input_schema={},
        output_schema={},
        max_rows=2,
        max_bytes=10_000,
        max_field_length=5,
    )
    defaults.update(overrides)
    return RegisteredTool(**defaults)


def test_apply_result_limits_caps_row_count() -> None:
    tool = _tool(max_rows=2, max_bytes=10_000, max_field_length=100)
    output = {"items": [{"x": 1}, {"x": 2}, {"x": 3}, {"x": 4}]}
    result, truncated = apply_result_limits(tool, output)
    assert len(result["items"]) == 2
    assert truncated is True


def test_apply_result_limits_no_truncation_when_within_limits() -> None:
    tool = _tool(max_rows=10, max_bytes=10_000, max_field_length=100)
    output = {"items": [{"x": 1}, {"x": 2}]}
    result, truncated = apply_result_limits(tool, output)
    assert len(result["items"]) == 2
    assert truncated is False


def test_apply_result_limits_truncates_long_field_strings() -> None:
    tool = _tool(max_rows=10, max_bytes=10_000, max_field_length=5)
    output = {"items": [{"comment": "this is a very long comment"}]}
    result, truncated = apply_result_limits(tool, output)
    assert result["items"][0]["comment"] == "this …"  # first 5 chars + ellipsis
    assert truncated is True


def test_apply_result_limits_shrinks_further_when_over_byte_budget() -> None:
    tool = _tool(max_rows=1000, max_bytes=80, max_field_length=1000)
    output = {"items": [{"x": "a" * 20} for _ in range(20)]}
    result, truncated = apply_result_limits(tool, output)
    assert truncated is True
    assert len(result["items"]) < 20


async def test_endpoint_reports_truncated_and_limit_info(
    pipeline: ToolCallPipeline, registry: ToolRegistry
) -> None:
    # Force a tiny max_rows on the already-registered get_tables tool so the
    # (2-table) mock dataset overflows it.
    tool = registry.get("db_metadata.get_tables")
    assert tool is not None
    tiny_tool = RegisteredTool(**{**tool.__dict__, "max_rows": 1})
    registry._tools["db_metadata.get_tables"] = tiny_tool  # test-only direct patch

    ctx = make_context(requested_tool="db_metadata.get_tables")
    body = make_call_body(tool_name="db_metadata.get_tables", input_={"schema": "APP"}, context=ctx)
    result = await pipeline.call("db_metadata.get_tables", body)

    assert result["truncated"] is True
    assert result["limit_info"] == {
        "max_rows": 1,
        "max_bytes": tiny_tool.max_bytes,
        "max_field_length": tiny_tool.max_field_length,
    }
    assert len(result["output"]["items"]) == 1


# ---------------------------------------------------------------------------
# Timeout
# ---------------------------------------------------------------------------


class _SlowConnector(Connector):
    async def health(self) -> ConnectorStatus:
        return ConnectorStatus(healthy=True, detail="slow")

    async def execute_named_query(
        self, query_id: QueryId, parameters: dict, context: RequestContext
    ):
        await asyncio.sleep(5)
        return []

    async def close(self) -> None:
        return None


async def test_tool_call_timeout_returns_mcp_execution_timeout() -> None:
    reg = ToolRegistry()
    register_poc_tools(reg)
    tool = reg.get("db_metadata.get_tables")
    assert tool is not None
    reg._tools["db_metadata.get_tables"] = RegisteredTool(**{**tool.__dict__, "timeout_seconds": 1})

    pipe = ToolCallPipeline(
        registry=reg,
        connector=_SlowConnector(),
        audit_sink=InMemoryAuditSink(),
        rate_limiter=RateLimiter(),
    )
    ctx = make_context(requested_tool="db_metadata.get_tables")
    body = make_call_body(tool_name="db_metadata.get_tables", input_={"schema": "APP"}, context=ctx)

    with pytest.raises(McpError) as exc_info:
        await pipe.call("db_metadata.get_tables", body)
    assert exc_info.value.code == ErrorCode.MCP_EXECUTION_TIMEOUT


# ---------------------------------------------------------------------------
# Rate limit
# ---------------------------------------------------------------------------


def test_rate_limiter_blocks_after_limit_reached() -> None:
    limiter = RateLimiter()
    keys = [("user:u1:tool", 2)]
    assert limiter.check_and_record(keys) is None
    assert limiter.check_and_record(keys) is None
    assert limiter.check_and_record(keys) == "user:u1:tool"


async def test_pipeline_rate_limits_repeated_calls(
    connector: MockOracleConnector, audit_sink: InMemoryAuditSink
) -> None:
    reg = ToolRegistry()
    register_poc_tools(reg)
    tool = reg.get("db_metadata.get_tables")
    assert tool is not None
    reg._tools["db_metadata.get_tables"] = RegisteredTool(
        **{**tool.__dict__, "rate_limit_per_minute": 2}
    )
    pipe = ToolCallPipeline(
        registry=reg, connector=connector, audit_sink=audit_sink, rate_limiter=RateLimiter()
    )

    ctx = make_context(requested_tool="db_metadata.get_tables")
    body = make_call_body(tool_name="db_metadata.get_tables", input_={"schema": "APP"}, context=ctx)

    await pipe.call("db_metadata.get_tables", body)
    await pipe.call("db_metadata.get_tables", body)
    with pytest.raises(McpError) as exc_info:
        await pipe.call("db_metadata.get_tables", body)
    assert exc_info.value.code == ErrorCode.RATE_LIMITED
