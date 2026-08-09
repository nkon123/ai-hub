"""Output Filter — 05-mcp-security-governance.md §9."""

from __future__ import annotations

import pytest
from office_mcp_server.errors import ErrorCode, McpError
from office_mcp_server.output_filter import apply_output_filter
from office_mcp_server.pipeline import ToolCallPipeline
from office_mcp_server.tool_registry import RegisteredTool

from .conftest import make_call_body, make_context


async def test_get_columns_strips_forbidden_column(pipeline: ToolCallPipeline) -> None:
    ctx = make_context(requested_tool="db_metadata.get_columns")
    body = make_call_body(
        tool_name="db_metadata.get_columns",
        input_={"schema": "APP", "table": "INTERFACE_LOG"},
        context=ctx,
    )
    result = await pipeline.call("db_metadata.get_columns", body)
    names = {c["name"] for c in result["output"]["columns"]}
    assert "INTERNAL_AUDIT_TOKEN" not in names
    assert "STATUS" in names  # sanity: other columns still present


async def test_get_columns_masks_pii_in_comment(pipeline: ToolCallPipeline) -> None:
    ctx = make_context(requested_tool="db_metadata.get_columns")
    body = make_call_body(
        tool_name="db_metadata.get_columns",
        input_={"schema": "APP", "table": "INTERFACE_LOG"},
        context=ctx,
    )
    result = await pipeline.call("db_metadata.get_columns", body)
    requester_email_col = next(
        c for c in result["output"]["columns"] if c["name"] == "REQUESTER_EMAIL"
    )
    assert "@" not in requester_email_col["comment"]
    assert "hong.gildong" not in requester_email_col["comment"]
    assert "[MASKED_EMAIL]" in requester_email_col["comment"]


async def test_response_carries_classification_label(pipeline: ToolCallPipeline) -> None:
    ctx = make_context(requested_tool="db_metadata.get_tables")
    body = make_call_body(tool_name="db_metadata.get_tables", input_={"schema": "APP"}, context=ctx)
    result = await pipeline.call("db_metadata.get_tables", body)
    assert result["output"]["classification"] == "INTERNAL"


def test_output_schema_revalidation_catches_handler_bug() -> None:
    tool = RegisteredTool(
        name="t",
        version="1.0.0",
        server_alias="oracle-connector",
        description="d",
        input_schema={},
        output_schema={
            "type": "object",
            "required": ["count"],
            "properties": {"count": {"type": "integer"}},
        },
        classification="INTERNAL",
    )
    # Handler bug: returns the wrong shape entirely.
    broken_output = {"totally_wrong_field": "oops"}
    with pytest.raises(McpError) as exc_info:
        apply_output_filter(tool, broken_output)
    assert exc_info.value.code == ErrorCode.INTERNAL_ERROR
    # Must not echo the raw jsonschema error (which could quote live data).
    assert "totally_wrong_field" not in exc_info.value.message


def test_email_masking_helper_handles_nested_structures() -> None:
    from office_mcp_server.output_filter import _mask_pii_deep

    value = {"items": [{"comment": "contact hong@miracom.com or 010-1234-5678"}]}
    masked = _mask_pii_deep(value)
    assert masked["items"][0]["comment"] == "contact [MASKED_EMAIL] or [MASKED_PHONE]"
