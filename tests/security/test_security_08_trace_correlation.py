"""Security property 8 — trace correlation holds for security events.

05-mcp-security-governance.md §12.9: "Trace ID로 Portal→Desktop→Runtime→
Search→MCP를 연결한다." This module proves the MCP half of that chain for
BOTH outcomes a security-relevant call can have -- denied and allowed --
against the live office-mcp-server admin audit endpoint
(`GET /admin/audit/events`, gated by `X-Actor-Role: ADMIN`,
`services/office-mcp-server/src/office_mcp_server/main.py`). Unlike
`tests/e2e/test_e2e_02_mcp_service.py` (which proves this once, for a
SUCCEEDED call reached indirectly via agent-runtime), this file calls
office-mcp-server directly for both outcomes and additionally proves the
admin audit endpoint itself is access-controlled -- otherwise "trace
correlation" would be trivially readable by anyone, undermining its value
as a security control.
"""

from __future__ import annotations

import uuid

import httpx
import pytest

from tests.security.conftest import assert_no_secret_leak, mcp_audit_context

pytestmark = pytest.mark.security


async def test_admin_audit_endpoint_itself_requires_admin_actor_role(
    mcp: httpx.AsyncClient,
) -> None:
    """Precondition for this whole property to mean anything as a security
    control: the audit trail used to prove trace correlation must not be
    world-readable."""
    resp = await mcp.get("/admin/audit/events")
    assert resp.status_code == 403, resp.text
    assert resp.json()["error"]["code"] == "PERMISSION_DENIED", resp.text

    resp = await mcp.get("/admin/audit/events", headers={"X-Actor-Role": "USER"})
    assert resp.status_code == 403, resp.text


async def test_denied_mcp_call_trace_id_correlates_in_admin_audit(mcp: httpx.AsyncClient) -> None:
    trace_id = str(uuid.uuid4())
    resp = await mcp.post(
        "/mcp/v1/tools/db_metadata.get_tables/call",
        json={
            "tool_name": "db_metadata.get_tables",
            "server_alias": "oracle-connector",
            "input": {"schema": "APP"},
            "confirmed": True,
            "audit_context": mcp_audit_context(
                requested_tool="db_metadata.get_tables",
                roles=["RELEASE_MANAGER"],  # outside this tool's allowed_roles -> denied
                trace_id=trace_id,
            ),
        },
    )
    assert resp.status_code == 403, resp.text

    audit_resp = await mcp.get(
        "/admin/audit/events", params={"trace_id": trace_id}, headers={"X-Actor-Role": "ADMIN"}
    )
    audit_resp.raise_for_status()
    events = audit_resp.json()["events"]
    assert events, f"no audit event correlated to trace_id={trace_id}"
    assert events[0]["trace_id"] == trace_id
    assert events[0]["result"] == "DENIED"
    assert events[0]["tool_name"] == "db_metadata.get_tables"


async def test_allowed_mcp_call_trace_id_correlates_in_admin_audit(mcp: httpx.AsyncClient) -> None:
    trace_id = str(uuid.uuid4())
    resp = await mcp.post(
        "/mcp/v1/tools/db_metadata.get_tables/call",
        json={
            "tool_name": "db_metadata.get_tables",
            "server_alias": "oracle-connector",
            "input": {"schema": "APP"},
            "confirmed": True,
            "audit_context": mcp_audit_context(
                requested_tool="db_metadata.get_tables", roles=["USER"], trace_id=trace_id
            ),
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["trace_id"] == trace_id, (
        "the call's own response must echo the caller's trace_id"
    )

    audit_resp = await mcp.get(
        "/admin/audit/events", params={"trace_id": trace_id}, headers={"X-Actor-Role": "ADMIN"}
    )
    audit_resp.raise_for_status()
    events = audit_resp.json()["events"]
    assert events, f"no audit event correlated to trace_id={trace_id}"
    assert events[0]["trace_id"] == trace_id
    assert events[0]["result"] == "SUCCEEDED"
    assert events[0]["tool_name"] == "db_metadata.get_tables"


async def test_distinct_calls_never_share_or_cross_trace_ids(mcp: httpx.AsyncClient) -> None:
    """A denied call and an allowed call issued back-to-back with distinct
    trace_ids must each correlate to exactly their own audit entry -- never
    to each other's -- proving trace_id is what actually keys the
    correlation, not incidental call ordering."""
    denied_trace_id = str(uuid.uuid4())
    allowed_trace_id = str(uuid.uuid4())

    await mcp.post(
        "/mcp/v1/tools/db_metadata.get_tables/call",
        json={
            "tool_name": "db_metadata.get_tables",
            "server_alias": "oracle-connector",
            "input": {"schema": "APP"},
            "confirmed": True,
            "audit_context": mcp_audit_context(
                requested_tool="db_metadata.get_tables",
                roles=["SECURITY_REVIEWER"],
                trace_id=denied_trace_id,
            ),
        },
    )
    await mcp.post(
        "/mcp/v1/tools/db_metadata.get_tables/call",
        json={
            "tool_name": "db_metadata.get_tables",
            "server_alias": "oracle-connector",
            "input": {"schema": "APP"},
            "confirmed": True,
            "audit_context": mcp_audit_context(
                requested_tool="db_metadata.get_tables", roles=["USER"], trace_id=allowed_trace_id
            ),
        },
    )

    denied_audit = (
        await mcp.get(
            "/admin/audit/events",
            params={"trace_id": denied_trace_id},
            headers={"X-Actor-Role": "ADMIN"},
        )
    ).json()["events"]
    allowed_audit = (
        await mcp.get(
            "/admin/audit/events",
            params={"trace_id": allowed_trace_id},
            headers={"X-Actor-Role": "ADMIN"},
        )
    ).json()["events"]

    assert all(e["trace_id"] == denied_trace_id for e in denied_audit)
    assert all(e["result"] == "DENIED" for e in denied_audit)
    assert all(e["trace_id"] == allowed_trace_id for e in allowed_audit)
    assert all(e["result"] == "SUCCEEDED" for e in allowed_audit)
    assert_no_secret_leak(str(denied_audit) + str(allowed_audit), context="cross-trace audit check")
