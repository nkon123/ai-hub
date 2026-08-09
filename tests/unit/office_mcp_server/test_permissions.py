"""Authorization — 05-mcp-security-governance.md §7.

Role/org allowlist enforcement, and the denial message must not leak the
tool's actual allowlists (§7 "내부 Policy 조건 전체를 노출하지 않는다")."""

from __future__ import annotations

import pytest
from office_mcp_server.errors import ErrorCode, McpError
from office_mcp_server.pipeline import ToolCallPipeline

from .conftest import make_call_body, make_context


async def test_role_outside_allowlist_denied(pipeline: ToolCallPipeline) -> None:
    ctx = make_context(requested_tool="db_metadata.get_tables", roles=["AUDITOR"])
    body = make_call_body(
        tool_name="db_metadata.get_tables", input_={"schema": "APP"}, context=ctx
    )
    with pytest.raises(McpError) as exc_info:
        await pipeline.call("db_metadata.get_tables", body)
    assert exc_info.value.code == ErrorCode.MCP_PERMISSION_DENIED


async def test_org_outside_allowlist_denied(pipeline: ToolCallPipeline) -> None:
    ctx = make_context(
        requested_tool="db_metadata.get_tables", roles=["USER"], organization_id="other-corp"
    )
    body = make_call_body(
        tool_name="db_metadata.get_tables", input_={"schema": "APP"}, context=ctx
    )
    with pytest.raises(McpError) as exc_info:
        await pipeline.call("db_metadata.get_tables", body)
    assert exc_info.value.code == ErrorCode.MCP_PERMISSION_DENIED


async def test_denial_message_does_not_leak_allowlist(pipeline: ToolCallPipeline) -> None:
    ctx = make_context(requested_tool="db_metadata.get_tables", roles=["AUDITOR"])
    body = make_call_body(
        tool_name="db_metadata.get_tables", input_={"schema": "APP"}, context=ctx
    )
    with pytest.raises(McpError) as exc_info:
        await pipeline.call("db_metadata.get_tables", body)

    message = exc_info.value.message
    # Must not echo the actual required roles/orgs allowlist anywhere in the
    # message (the contact address's domain happens to also be "miracom",
    # which is fine — that is not the same as disclosing the org allowlist
    # mechanism itself).
    assert "CREATOR" not in message
    assert "TECH_REVIEWER" not in message
    assert "allowed_roles" not in message
    assert "allowed_orgs" not in message
    # Must still be actionable: says permission is required and gives a
    # contact point.
    assert "권한" in message
    assert exc_info.value.details == {}


async def test_allowed_role_and_org_succeeds(pipeline: ToolCallPipeline) -> None:
    ctx = make_context(requested_tool="db_metadata.get_tables", roles=["USER"])
    body = make_call_body(
        tool_name="db_metadata.get_tables", input_={"schema": "APP"}, context=ctx
    )
    result = await pipeline.call("db_metadata.get_tables", body)
    assert result["success"] is True


async def test_one_of_multiple_roles_matching_is_sufficient(pipeline: ToolCallPipeline) -> None:
    ctx = make_context(
        requested_tool="db_metadata.get_tables", roles=["AUDITOR", "USER", "SECURITY_REVIEWER"]
    )
    body = make_call_body(
        tool_name="db_metadata.get_tables", input_={"schema": "APP"}, context=ctx
    )
    result = await pipeline.call("db_metadata.get_tables", body)
    assert result["success"] is True
