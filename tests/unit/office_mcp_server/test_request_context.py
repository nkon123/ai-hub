"""Request Context validation — 05-mcp-security-governance.md §3.

"Context 누락 또는 서명/세션 검증 실패 시 요청을 거부한다" and "Agent Prompt가
사용자 ID나 Role을 임의로 만들 수 없다."
"""

from __future__ import annotations

import pytest
from office_mcp_server.errors import ErrorCode, McpError
from office_mcp_server.pipeline import ToolCallPipeline
from office_mcp_server.tool_registry import ToolRegistry

from .conftest import make_call_body, make_context


async def test_missing_audit_context_rejected(pipeline: ToolCallPipeline) -> None:
    body = {
        "tool_name": "db_metadata.get_tables",
        "server_alias": "oracle-connector",
        "input": {"schema": "APP"},
        # no audit_context at all
    }
    with pytest.raises(McpError) as exc_info:
        await pipeline.call("db_metadata.get_tables", body)
    assert exc_info.value.code == ErrorCode.VALIDATION_ERROR


async def test_null_audit_context_rejected(pipeline: ToolCallPipeline) -> None:
    body = make_call_body(
        tool_name="db_metadata.get_tables", input_={"schema": "APP"}, context=None
    )
    body["audit_context"] = None
    with pytest.raises(McpError) as exc_info:
        await pipeline.call("db_metadata.get_tables", body)
    assert exc_info.value.code == ErrorCode.VALIDATION_ERROR


@pytest.mark.parametrize(
    "missing_field",
    ["request_id", "trace_id", "run_id", "service_id", "agent_id", "user", "requested_tool"],
)
async def test_context_missing_required_field_rejected(
    pipeline: ToolCallPipeline, missing_field: str
) -> None:
    ctx = make_context(requested_tool="db_metadata.get_tables")
    del ctx[missing_field]
    body = make_call_body(
        tool_name="db_metadata.get_tables", input_={"schema": "APP"}, context=ctx
    )
    with pytest.raises(McpError) as exc_info:
        await pipeline.call("db_metadata.get_tables", body)
    assert exc_info.value.code == ErrorCode.VALIDATION_ERROR


async def test_context_user_missing_roles_rejected(pipeline: ToolCallPipeline) -> None:
    ctx = make_context(requested_tool="db_metadata.get_tables")
    del ctx["user"]["roles"]
    body = make_call_body(
        tool_name="db_metadata.get_tables", input_={"schema": "APP"}, context=ctx
    )
    with pytest.raises(McpError) as exc_info:
        await pipeline.call("db_metadata.get_tables", body)
    assert exc_info.value.code == ErrorCode.VALIDATION_ERROR


async def test_context_empty_roles_list_rejected(pipeline: ToolCallPipeline) -> None:
    ctx = make_context(requested_tool="db_metadata.get_tables", roles=[])
    body = make_call_body(
        tool_name="db_metadata.get_tables", input_={"schema": "APP"}, context=ctx
    )
    with pytest.raises(McpError) as exc_info:
        await pipeline.call("db_metadata.get_tables", body)
    assert exc_info.value.code == ErrorCode.VALIDATION_ERROR


async def test_context_requested_tool_mismatch_rejected(pipeline: ToolCallPipeline) -> None:
    """A context minted for one tool must not be reusable to call another."""
    ctx = make_context(requested_tool="table_count.query")
    body = make_call_body(
        tool_name="db_metadata.get_tables", input_={"schema": "APP"}, context=ctx
    )
    with pytest.raises(McpError) as exc_info:
        await pipeline.call("db_metadata.get_tables", body)
    assert exc_info.value.code == ErrorCode.VALIDATION_ERROR


async def test_extra_unknown_fields_in_context_rejected(pipeline: ToolCallPipeline) -> None:
    """`additionalProperties: false` — a caller cannot smuggle extra claims
    (e.g. a bogus `is_admin`) into the trusted context."""
    ctx = make_context(requested_tool="db_metadata.get_tables")
    ctx["is_admin"] = True
    body = make_call_body(
        tool_name="db_metadata.get_tables", input_={"schema": "APP"}, context=ctx
    )
    with pytest.raises(McpError) as exc_info:
        await pipeline.call("db_metadata.get_tables", body)
    assert exc_info.value.code == ErrorCode.VALIDATION_ERROR


async def test_role_smuggled_into_tool_input_does_not_escalate(
    registry: ToolRegistry, pipeline: ToolCallPipeline
) -> None:
    """The core Prompt Injection defense (§3, §12.7): a role/user claim can
    only ever come from `audit_context.user.roles`. Stuffing it into the
    business `input` dict must not grant any permission — it should just be
    rejected as an unrecognized input field (input_schema uses
    additionalProperties: false), definitely not silently accepted or
    upgrade the caller's effective role."""
    # This context legitimately has no permission for the tool (USER role
    # not granted anything if we strip allowed_roles) — instead we assert
    # that an attempted role smuggled into `input` is simply rejected as an
    # invalid/unknown input field, never interpreted as a role.
    ctx = make_context(requested_tool="db_metadata.get_tables", roles=["USER"])
    body = make_call_body(
        tool_name="db_metadata.get_tables",
        input_={"schema": "APP", "role": "ADMIN", "user": {"roles": ["ADMIN"]}},
        context=ctx,
    )
    with pytest.raises(McpError) as exc_info:
        await pipeline.call("db_metadata.get_tables", body)
    # Rejected as an invalid tool input (additionalProperties: false), not
    # as a permission check that somehow saw an ADMIN role.
    assert exc_info.value.code == ErrorCode.MCP_INPUT_INVALID
